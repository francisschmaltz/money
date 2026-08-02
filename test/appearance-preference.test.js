import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import express from "express";
import request from "supertest";

import { PgFinanceRepository } from "../app/db/financeRepository.js";
import { createApiRouter } from "../app/routes/api.js";
import { createRuntime } from "../app/runtime.js";
import {
  createAppearancePreferenceResolver,
  createAppearancePreferenceService,
  createDemoAppearancePreferenceService,
} from "../app/services/appearancePreferenceService.js";

test("appearance migration defaults users to System and constrains the enum", async () => {
  const migration = await readFile(
    new URL(
      "../migrations/038_user_appearance_preference.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    migration,
    /appearance_preference text NOT NULL DEFAULT 'system'/,
  );
  assert.match(
    migration,
    /CHECK \(appearance_preference IN \('system', 'light', 'dark'\)\)/,
  );
});

test("repository reads and updates only the authenticated user's appearance", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, params });
      if (compact.startsWith("SELECT appearance_preference")) {
        return { rows: [{ appearance_preference: "dark" }] };
      }
      return { rows: [{ appearance_preference: params[1] }] };
    },
  };
  const repository = new PgFinanceRepository(pool);

  assert.equal(
    await repository.getUserAppearancePreference("member-1"),
    "dark",
  );
  assert.equal(
    await repository.updateUserAppearancePreference(
      "member-1",
      "light",
    ),
    "light",
  );
  assert.deepEqual(calls[0].params, ["member-1"]);
  assert.deepEqual(calls[1].params, ["member-1", "light"]);
  assert.match(calls[1].sql, /updated_at = now\(\)/);
  await assert.rejects(
    repository.updateUserAppearancePreference("member-1", "Dark"),
    /exactly system, light, or dark/,
  );
  assert.equal(calls.length, 2);
});

test("repository rejects an authenticated user missing from persistence", async () => {
  const repository = new PgFinanceRepository({
    async query() {
      return { rows: [] };
    },
  });

  await assert.rejects(
    repository.getUserAppearancePreference("missing-user"),
    (error) => error.code === "USER_NOT_FOUND",
  );
  await assert.rejects(
    repository.updateUserAppearancePreference("missing-user", "dark"),
    (error) => error.code === "USER_NOT_FOUND",
  );
});

test("database and demo services enforce exact values with per-user state", async () => {
  const calls = [];
  const service = createAppearancePreferenceService({
    repository: {
      getUserAppearancePreference(userId) {
        calls.push(["get", userId]);
        return "system";
      },
      updateUserAppearancePreference(userId, appearance) {
        calls.push(["set", userId, appearance]);
        return appearance;
      },
    },
  });
  assert.equal(await service.getAppearancePreference("member-1"), "system");
  assert.equal(
    await service.setAppearancePreference("member-1", "dark"),
    "dark",
  );
  await assert.rejects(
    service.setAppearancePreference("member-1", " dark"),
    /exactly system, light, or dark/,
  );
  assert.deepEqual(calls, [
    ["get", "member-1"],
    ["set", "member-1", "dark"],
  ]);

  const demo = createDemoAppearancePreferenceService();
  assert.equal(await demo.getAppearancePreference("member-1"), "system");
  assert.equal(await demo.getAppearancePreference("member-2"), "system");
  await demo.setAppearancePreference("member-1", "light");
  assert.equal(await demo.getAppearancePreference("member-1"), "light");
  assert.equal(await demo.getAppearancePreference("member-2"), "system");
});

function appearanceApi({ service, user = { id: "member-1" } } = {}) {
  const state = {
    adminChecks: 0,
    csrfChecks: 0,
    sessions: [],
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    req.session = { appearancePreference: "system" };
    state.sessions.push(req.session);
    next();
  });
  app.use(
    createApiRouter({
      requireAuth(req, res, next) {
        if (req.user) {
          next();
          return;
        }
        res.status(401).json({ error: "unauthorized" });
      },
      requireAdmin(_req, _res, next) {
        state.adminChecks += 1;
        next();
      },
      requireCsrf(req, res, next) {
        state.csrfChecks += 1;
        if (req.get("x-csrf-token") === "valid-token") {
          next();
          return;
        }
        res.status(403).json({ error: "invalid_csrf_token" });
      },
      appearancePreferenceService: service,
      financeService: {},
    }),
  );
  return { app, state };
}

test("member appearance API is no-store, CSRF-protected, and user-bound", async () => {
  const calls = [];
  const { app, state } = appearanceApi({
    service: {
      getAppearancePreference(userId) {
        calls.push(["get", userId]);
        return "light";
      },
      setAppearancePreference(userId, appearance) {
        calls.push(["set", userId, appearance]);
        return appearance;
      },
    },
  });

  const read = await request(app)
    .get("/api/v1/me/appearance")
    .expect(200, { appearance: "light" });
  assert.equal(read.headers["cache-control"], "no-store");
  assert.equal(state.sessions[0].appearancePreference, "light");

  await request(app)
    .put("/api/v1/me/appearance")
    .send({ appearance: "dark" })
    .expect(403, { error: "invalid_csrf_token" });

  const write = await request(app)
    .put("/api/v1/me/appearance")
    .set("x-csrf-token", "valid-token")
    .send({
      appearance: "dark",
      user_id: "attacker-selected-user",
    })
    .expect(200, { updated: true, appearance: "dark" });
  assert.equal(write.headers["cache-control"], "no-store");
  assert.equal(state.sessions[2].appearancePreference, "dark");
  assert.equal(state.adminChecks, 0);
  assert.equal(state.csrfChecks, 2);
  assert.deepEqual(calls, [
    ["get", "member-1"],
    ["set", "member-1", "dark"],
  ]);
});

test("appearance API rejects non-exact values and reports persistence outages", async () => {
  let writes = 0;
  const { app } = appearanceApi({
    service: {
      async getAppearancePreference() {
        throw new Error("database unavailable");
      },
      async setAppearancePreference() {
        writes += 1;
        throw new Error("database unavailable");
      },
    },
  });

  await request(app)
    .put("/api/v1/me/appearance")
    .set("x-csrf-token", "valid-token")
    .send({ appearance: "Dark" })
    .expect(400)
    .expect(({ body }) => {
      assert.equal(body.error, "invalid_request");
    });
  assert.equal(writes, 0);

  await request(app)
    .get("/api/v1/me/appearance")
    .expect(503)
    .expect(({ body }) => {
      assert.equal(body.error, "capability_unavailable");
    });
  await request(app)
    .put("/api/v1/me/appearance")
    .set("x-csrf-token", "valid-token")
    .send({ appearance: "dark" })
    .expect(503);
  assert.equal(writes, 1);
});

async function runResolver(middleware, requestOverrides = {}) {
  const request = {
    method: "GET",
    path: "/transactions",
    user: { id: "member-1" },
    session: {},
    accepts(type) {
      return type === "html" ? "html" : false;
    },
    ...requestOverrides,
  };
  const response = { locals: {} };
  await new Promise((resolve) => middleware(request, response, resolve));
  return { request, response };
}

test("HTML preference resolution refreshes from persistence on every GET", async () => {
  let reads = 0;
  const middleware = createAppearancePreferenceResolver({
    appearancePreferenceService: {
      getAppearancePreference(userId) {
        reads += 1;
        assert.equal(userId, "member-1");
        return reads === 1 ? "dark" : "light";
      },
    },
  });
  const session = {};

  const first = await runResolver(middleware, { session });
  const second = await runResolver(middleware, { session });

  assert.equal(first.response.locals.appearancePreference, "dark");
  assert.equal(second.response.locals.appearancePreference, "light");
  assert.equal(session.appearancePreference, "light");
  assert.equal(reads, 2);
});

test("HTML preference resolution falls back to a valid session, then System", async () => {
  let reads = 0;
  const middleware = createAppearancePreferenceResolver({
    appearancePreferenceService: {
      async getAppearancePreference() {
        reads += 1;
        throw new Error("database unavailable");
      },
    },
  });

  const saved = await runResolver(middleware, {
    session: { appearancePreference: "dark" },
  });
  const invalid = await runResolver(middleware, {
    session: { appearancePreference: "sepia" },
  });
  const api = await runResolver(middleware, {
    path: "/api/search",
    session: { appearancePreference: "light" },
  });

  assert.equal(saved.response.locals.appearancePreference, "dark");
  assert.equal(invalid.response.locals.appearancePreference, "system");
  assert.equal(api.response.locals.appearancePreference, "light");
  assert.equal(reads, 2);
});

test("signed-out HTML always renders System even when the session has a preference", async () => {
  let reads = 0;
  const middleware = createAppearancePreferenceResolver({
    appearancePreferenceService: {
      async getAppearancePreference() {
        reads += 1;
        return "dark";
      },
    },
  });

  const signedOut = await runResolver(middleware, {
    user: null,
    session: { appearancePreference: "dark" },
  });

  assert.equal(signedOut.response.locals.appearancePreference, "system");
  assert.equal(reads, 0);
});

test("demo runtime wires one process-local appearance service", async () => {
  const runtime = createRuntime({
    demoMode: true,
    demoScenario: "default",
    lmStudio: {},
  });

  assert.equal(
    await runtime.appearancePreferenceService.getAppearancePreference(
      "demo-user",
    ),
    "system",
  );
  await runtime.appearancePreferenceService.setAppearancePreference(
    "demo-user",
    "dark",
  );
  assert.equal(
    await runtime.appearancePreferenceService.getAppearancePreference(
      "demo-user",
    ),
    "dark",
  );
  await runtime.close();
});
