import assert from "node:assert/strict";
import test from "node:test";

import express from "express";
import request from "supertest";

import { createApiRouter } from "../app/routes/api.js";

function recoveryApp({ calls, middlewareCalls }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "admin-1", is_admin: true };
    next();
  });
  app.use(
    createApiRouter({
      requireAdmin(req, _res, next) {
        middlewareCalls.push(`admin:${req.method}`);
        next();
      },
      requireCsrf(req, _res, next) {
        middlewareCalls.push(`csrf:${req.method}`);
        next();
      },
      financeService: {
        listPendingEditRecoveries(input, actor) {
          calls.push(["list", input, actor]);
          return { recoveries: [] };
        },
        attachPendingEditRecovery(input, actor) {
          calls.push(["attach", input, actor]);
          return { attached: true, recovery: { id: input.recovery_id } };
        },
        dismissPendingEditRecovery(input, actor) {
          calls.push(["dismiss", input, actor]);
          return { dismissed: true, recovery: { id: input.recovery_id } };
        },
      },
    }),
  );
  return app;
}

test("pending edit recovery REST routes are admin-only and guard mutations with CSRF", async () => {
  const calls = [];
  const middlewareCalls = [];
  const app = recoveryApp({ calls, middlewareCalls });

  await request(app)
    .get("/api/v1/pending-edit-recoveries")
    .expect(200, { recoveries: [] });
  await request(app)
    .post("/api/v1/pending-edit-recoveries/recovery-1/attach")
    .send({ transaction_id: "posted-1" })
    .expect(200, {
      attached: true,
      recovery: { id: "recovery-1" },
    });
  await request(app)
    .post("/api/v1/pending-edit-recoveries/recovery-1/dismiss")
    .send({})
    .expect(200, {
      dismissed: true,
      recovery: { id: "recovery-1" },
    });

  const actor = { id: "admin-1", is_admin: true };
  assert.deepEqual(calls, [
    ["list", { include_resolved: false }, actor],
    [
      "attach",
      {
        recovery_id: "recovery-1",
        transaction_id: "posted-1",
      },
      actor,
    ],
    ["dismiss", { recovery_id: "recovery-1" }, actor],
  ]);
  assert.deepEqual(middlewareCalls, [
    "admin:GET",
    "admin:POST",
    "csrf:POST",
    "admin:POST",
    "csrf:POST",
  ]);
});

test("attach recovery rejects a missing explicit posted transaction", async () => {
  const calls = [];
  const app = recoveryApp({ calls, middlewareCalls: [] });

  await request(app)
    .post("/api/v1/pending-edit-recoveries/recovery-1/attach")
    .send({})
    .expect(400, {
      error: "invalid_request",
      message: "transaction_id is required.",
    });

  assert.equal(calls.length, 0);
});
