import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import express from "express";
import request from "supertest";

import { createApp } from "../app/app.js";
import { createAuth, createSessionMiddleware, identityForStoredIdentity } from "../app/auth.js";
import { loadConfig } from "../app/config.js";
import { createMobileAuth, MemoryMobileAuthStore, PgMobileAuthStore, mobileTokenHash } from "../app/mobileAuth.js";
import { ensureCsrfToken, requireCsrf } from "../app/security.js";
import { createDemoAppearancePreferenceService } from "../app/services/appearancePreferenceService.js";
import { createDemoFinanceService } from "../app/services/demoFinanceService.js";

const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = "native-login-state-123456";

function harness() {
  let instant = new Date("2026-10-15T12:00:00Z");
  const config = loadConfig({ NODE_ENV: "test", AUTH_MODE: "mock", DEMO_MODE: "true", PUBLIC_BASE_URL: "http://money.test" }, []);
  const store = new MemoryMobileAuthStore();
  const mobile = createMobileAuth({ config, store, now: () => instant,
    resolveIdentity: (stored) => identityForStoredIdentity(stored, config),
  });
  const app = express();
  app.use(express.json());
  app.use(createSessionMiddleware({ config, pool: null }));
  app.use(ensureCsrfToken);
  app.use(createAuth({ config, mobileAuth: mobile }).router);
  app.use(mobile.authenticate);
  app.use(mobile.router);
  app.post("/api/test-write", requireCsrf, (_req, res) => res.json({ ok: true }));
  app.get("/browser-csrf", (req, res) => res.json({ csrf_token: req.session.csrfToken }));
  return { app, config, store, advance: (ms) => { instant = new Date(instant.getTime() + ms); } };
}

async function handoff(app, query = {}) {
  const result = await request(app).get("/auth/mobile/start")
    .query({ state, code_challenge: challenge, code_challenge_method: "S256", ...query }).expect(302);
  const callback = new URL(result.headers.location);
  assert.equal(callback.origin, "null");
  assert.equal(callback.protocol, "com.yaboiii.money:");
  assert.equal(callback.hostname, "auth");
  assert.equal(callback.pathname, "/callback");
  assert.equal(callback.searchParams.get("state"), state);
  return callback.searchParams.get("code");
}

async function signIn(app) {
  const code = await handoff(app);
  return request(app).post("/auth/mobile/exchange").send({ code, code_verifier: verifier }).expect(200);
}

test("mock native login exchanges a PKCE handoff for a hashed seven-day credential without a browser cookie", async () => {
  const { app, store } = harness();
  const login = await signIn(app);
  assert.equal(login.headers["set-cookie"], undefined);
  assert.equal(login.body.token_type, "Bearer");
  assert.equal(login.body.expires_at, "2026-10-22T12:00:00.000Z");
  const records = [...store.sessions.values()];
  assert.equal(records.length, 1);
  assert.equal(records[0].token_hash, mobileTokenHash(login.body.access_token));
  assert.equal(JSON.stringify(records).includes(login.body.access_token), false);
  assert.equal(store.codes.size, 0);

  const session = await request(app).get("/api/v1/session")
    .set("Authorization", `Bearer ${login.body.access_token}`).expect(200);
  assert.equal(session.headers["set-cookie"], undefined);
  assert.equal(session.body.workspace.id, "shared");
  assert.equal(session.body.currency, "USD");
  assert.equal(session.body.timezone, "America/Los_Angeles");
  assert.equal(session.body.biometric_persistence_enabled, false);
  assert.equal(session.body.csrf_token, null);
  await request(app).post("/api/test-write").set("Authorization", `Bearer ${login.body.access_token}`)
    .send({}).expect(200);
});

test("native handoffs reject incorrect verifiers, expire after 60 seconds, and cannot be replayed", async () => {
  const { app, advance } = harness();
  const code = await handoff(app, { redirect_uri: "https://evil.test/steal" });
  await request(app).post("/auth/mobile/exchange").send({ code, code_verifier: "b".repeat(43) }).expect(400);
  await request(app).post("/auth/mobile/exchange").send({ code, code_verifier: verifier }).expect(200);
  await request(app).post("/auth/mobile/exchange").send({ code, code_verifier: verifier }).expect(400);
  const expired = await handoff(app);
  advance(60_000);
  await request(app).post("/auth/mobile/exchange").send({ code: expired, code_verifier: verifier }).expect(400);
  await request(app).get("/auth/mobile/start").query({ state, code_challenge: challenge, code_challenge_method: "plain" }).expect(400);
});

test("native persistence removes expiry and disabling it revokes the entire session", async () => {
  const { app, advance } = harness();
  const { body } = await signIn(app);
  const authorization = `Bearer ${body.access_token}`;
  await request(app).patch("/auth/mobile/session").set("Authorization", authorization)
    .send({ biometric_persistence_enabled: "true" }).expect(400);
  const persisted = await request(app).patch("/auth/mobile/session").set("Authorization", authorization)
    .send({ biometric_persistence_enabled: true }).expect(200);
  assert.deepEqual(persisted.body, { expires_at: null, biometric_persistence_enabled: true });
  advance(31 * 24 * 60 * 60 * 1_000);
  const session = await request(app).get("/api/v1/session").set("Authorization", authorization).expect(200);
  assert.equal(session.body.expires_at, null);
  await request(app).patch("/auth/mobile/session").set("Authorization", authorization)
    .send({ biometric_persistence_enabled: false }).expect(204);
  await request(app).get("/api/v1/session").set("Authorization", authorization).expect(401);
});

test("expired access cannot read or enable persistence but can revoke its own session", async () => {
  const { app, store, advance } = harness();
  const { body } = await signIn(app);
  const authorization = `Bearer ${body.access_token}`;
  advance(7 * 24 * 60 * 60 * 1_000);
  await request(app).get("/api/v1/session").set("Authorization", authorization).expect(401);
  await request(app).patch("/auth/mobile/session").set("Authorization", authorization)
    .send({ biometric_persistence_enabled: true }).expect(401);
  await request(app).post("/auth/mobile/logout").set("Authorization", authorization).expect(204);
  assert.equal(store.sessions.size, 0);
});

test("invalid native Authorization cannot fall back to a mock/browser identity and cookie CSRF still applies", async () => {
  const { app } = harness();
  const browser = request.agent(app);
  const csrf = await browser.get("/browser-csrf").expect(200);
  await browser.get("/api/v1/session").set("Authorization", "Bearer invalid").expect(401);
  await browser.post("/api/test-write").send({}).expect(403);
  await browser.post("/api/test-write").set("Authorization", "Basic garbage").send({}).expect(401);
  await browser.post("/api/test-write").set("x-csrf-token", csrf.body.csrf_token).send({}).expect(200);
  const login = await signIn(app);
  await request(app).get("/api/v1/session").set("Authorization", `Bearer ${login.body.access_token}`)
    .set("Origin", "https://evil.test").expect(403);
  const code = await handoff(app);
  await request(app).post("/auth/mobile/exchange").set("Origin", "null")
    .send({ code, code_verifier: verifier }).expect(403);
  await request(app).post("/auth/mobile/exchange").set("Origin", "http://money.test")
    .send({ code, code_verifier: verifier }).expect(200);
});

test("native identity resolves current roles for each request", async () => {
  const { app, config, store } = harness();
  const token = "z".repeat(43);
  config.auth.adminEmails.add("owner@example.com");
  await store.saveSession({ token_hash: mobileTokenHash(token),
    identity: { id: "u1", subject: "duo:u1", email: "owner@example.com", name: "Owner", isAdmin: true },
    created_at: new Date(), expires_at: null });
  const first = await request(app).get("/api/v1/session").set("Authorization", `Bearer ${token}`).expect(200);
  assert.equal(first.body.permissions.admin, true);
  config.auth.adminEmails.clear();
  const second = await request(app).get("/api/v1/session").set("Authorization", `Bearer ${token}`).expect(200);
  assert.equal(second.body.permissions.admin, false);
});

test("PostgreSQL handoff consumption uses one conditional delete and serializes JSON objects", async () => {
  const calls = [];
  const pool = { async query(sql, parameters) { calls.push({ sql, parameters }); return { rows: [{ identity: { id: "u1" } }] }; } };
  const store = new PgMobileAuthStore(pool);
  const now = new Date();
  await store.saveHandoff({ code_hash: "hash", code_challenge: challenge, identity: { id: "u1" }, expires_at: now });
  assert.equal(calls[1].parameters[2], '{"id":"u1"}');
  assert.deepEqual(await store.consumeHandoff("hash", challenge, now), { id: "u1" });
  assert.match(calls[2].sql, /DELETE FROM mobile_auth_handoffs/);
  assert.match(calls[2].sql, /code_challenge = \$2 AND expires_at > \$3/);
});

test("app serves configured Apple association without sessions and native API mutations use bearer", async () => {
  const config = loadConfig({ NODE_ENV: "test", AUTH_MODE: "mock", DEMO_MODE: "true", PUBLIC_BASE_URL: "http://money.test", APPLE_TEAM_ID: "ABCDE12345" }, []);
  const app = createApp({ config, financeService: createDemoFinanceService(), appearancePreferenceService: createDemoAppearancePreferenceService() });
  const association = await request(app).get("/.well-known/apple-app-site-association").expect(200);
  assert.equal(association.headers["set-cookie"], undefined);
  assert.deepEqual(association.body.webcredentials.apps, ["ABCDE12345.com.yaboiii.money"]);
  assert.equal(association.body.applinks.details[0].components[0]["/"], "/plaid/ios/callback");
  const login = await signIn(app);
  const updated = await request(app).put("/api/v1/me/appearance").set("Authorization", `Bearer ${login.body.access_token}`)
    .send({ appearance: "dark" }).expect(200);
  assert.equal(updated.headers["set-cookie"], undefined);
  const bootstrap = await request(app).get("/api/v1/session").set("Authorization", `Bearer ${login.body.access_token}`).expect(200);
  assert.equal(bootstrap.body.appearance, "dark");
});
