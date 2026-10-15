import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";

const ACCESS_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const HANDOFF_LIFETIME_MS = 60 * 1_000;
const LOGIN_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_LOCAL_RECORDS = 1_000;
const secret = () => randomBytes(32).toString("base64url");
export const mobileTokenHash = (value) =>
  createHash("sha256").update(value).digest("hex");
const challengeFor = (value) =>
  createHash("sha256").update(value).digest("base64url");

// Only used by explicit nonproduction AUTH_MODE=mock. Production uses PostgreSQL.
export class MemoryMobileAuthStore {
  codes = new Map();
  sessions = new Map();

  #put(map, key, value) {
    if (map.size >= MAX_LOCAL_RECORDS) map.delete(map.keys().next().value);
    map.set(key, value);
  }

  async saveHandoff(record) {
    for (const [key, code] of this.codes) {
      if (code.expires_at <= record.created_at) this.codes.delete(key);
    }
    this.#put(this.codes, record.code_hash, record);
  }

  async consumeHandoff(hash, challenge, now) {
    const record = this.codes.get(hash);
    if (!record || record.expires_at <= now || record.code_challenge !== challenge) return null;
    this.codes.delete(hash);
    return record.identity;
  }

  async saveSession(record) {
    this.#put(this.sessions, record.token_hash, record);
  }

  async findSession(hash) { return this.sessions.get(hash) ?? null; }

  async enablePersistence(hash) {
    const record = this.sessions.get(hash);
    if (record) record.expires_at = null;
    return record ?? null;
  }

  async revokeSession(hash) { this.sessions.delete(hash); }

  async workspace() {
    return {
      id: "shared", name: "Shared finances", base_currency: "USD",
      timezone: "America/Los_Angeles",
    };
  }
}

export class PgMobileAuthStore {
  constructor(pool) { this.pool = pool; }

  async saveHandoff(record) {
    await this.pool.query("DELETE FROM mobile_auth_handoffs WHERE expires_at <= now()");
    await this.pool.query(
      `INSERT INTO mobile_auth_handoffs (code_hash, code_challenge, identity, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [record.code_hash, record.code_challenge, JSON.stringify(record.identity), record.expires_at],
    );
  }

  async consumeHandoff(hash, challenge, now) {
    const result = await this.pool.query(
      `DELETE FROM mobile_auth_handoffs
       WHERE code_hash = $1 AND code_challenge = $2 AND expires_at > $3
       RETURNING identity`,
      [hash, challenge, now],
    );
    return result.rows[0]?.identity ?? null;
  }

  async saveSession(record) {
    await this.pool.query("DELETE FROM native_sessions WHERE expires_at <= now()");
    await this.pool.query(
      `INSERT INTO native_sessions (token_hash, user_id, identity, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [record.token_hash, record.identity.id, JSON.stringify(record.identity), record.created_at, record.expires_at],
    );
  }

  async findSession(hash) {
    const result = await this.pool.query(
      "SELECT token_hash, identity, created_at, expires_at FROM native_sessions WHERE token_hash = $1",
      [hash],
    );
    return result.rows[0] ?? null;
  }

  async enablePersistence(hash) {
    const result = await this.pool.query(
      "UPDATE native_sessions SET expires_at = NULL WHERE token_hash = $1 RETURNING token_hash, identity, created_at, expires_at",
      [hash],
    );
    return result.rows[0] ?? null;
  }

  async revokeSession(hash) {
    await this.pool.query("DELETE FROM native_sessions WHERE token_hash = $1", [hash]);
  }

  async workspace(userId) {
    const result = await this.pool.query(
      `SELECT w.id, w.name, w.base_currency, w.timezone FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id
       WHERE w.id = 'shared' AND m.user_id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }
}

function unauthorized(response) {
  return response.status(401).set("WWW-Authenticate", 'Bearer realm="money-native"')
    .json({ error: "unauthorized", message: "Sign in to Money again." });
}

export function createMobileAuth({
  config, pool = null, store = null, resolveIdentity,
  appearancePreferenceService = null, capabilities = {}, now = () => new Date(),
}) {
  const mock = config.auth.mode === "mock" && !config.production;
  if (!store) {
    if (mock) store = new MemoryMobileAuthStore();
    else if (pool) store = new PgMobileAuthStore(pool);
    else throw new Error("Native authentication requires PostgreSQL outside explicit mock mode.");
  }
  const origin = new URL(config.publicBaseUrl).origin;
  const callback = mock
    ? "com.yaboiii.money://auth/callback"
    : new URL("/auth/ios/callback", origin).href;
  const router = Router();
  const identityForSession = (stored) => {
    const identity = resolveIdentity(stored);
    return mock && identity?.subject === "mock:demo-user"
      ? { ...identity, isAdmin: true } : identity;
  };

  function checkOrigin(request, response) {
    const presented = request.get("origin");
    if (presented !== undefined && presented !== origin) {
      response.status(403).json({ error: "forbidden_origin" });
      return false;
    }
    return true;
  }

  function redirect(request, response, parameters) {
    const flow = request.session?.mobileAuth;
    if (request.session) delete request.session.mobileAuth;
    const target = new URL(callback);
    if (flow?.state) target.searchParams.set("state", flow.state);
    for (const [key, value] of Object.entries(parameters)) target.searchParams.set(key, value);
    response.redirect(target.href);
  }

  function begin(request, response, next) {
    if (!checkOrigin(request, response)) return;
    const { state, code_challenge: challenge, code_challenge_method: method } = request.query;
    if (typeof state !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(state) ||
        typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || method !== "S256") {
      response.status(400).json({ error: "invalid_mobile_login" });
      return;
    }
    request.session.mobileAuth = { state, challenge, started_at: now().getTime() };
    delete request.session.returnTo;
    next();
  }

  async function complete(request, response, identity) {
    const flow = request.session?.mobileAuth;
    const age = now().getTime() - flow?.started_at;
    if (!flow || !Number.isFinite(age) || age < 0 || age >= LOGIN_LIFETIME_MS) {
      redirect(request, response, { error: "login_expired" });
      return;
    }
    const code = secret();
    const createdAt = now();
    await store.saveHandoff({
      code_hash: mobileTokenHash(code), code_challenge: flow.challenge, identity,
      created_at: createdAt, expires_at: new Date(createdAt.getTime() + HANDOFF_LIFETIME_MS),
    });
    redirect(request, response, { code });
  }

  async function authenticate(request, response, next) {
    if (request.get("authorization") === undefined) return next();
    if (!checkOrigin(request, response)) return;
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.get("authorization"));
    if (!match) return unauthorized(response);
    const record = await store.findSession(mobileTokenHash(match[1]));
    const isRevocation = request.method === "POST" && request.path === "/auth/mobile/logout";
    if (!record || (!isRevocation && record.expires_at && new Date(record.expires_at) <= now())) {
      return unauthorized(response);
    }
    const identity = identityForSession(record.identity);
    if (!identity) return unauthorized(response);
    request.user = identity;
    request.nativeSession = record;
    // Feature handlers sometimes cache browser preferences in request.session.
    // Native bearer requests must not turn those writes into anonymous cookies.
    delete request.session;
    next();
  }

  router.post("/auth/mobile/exchange", async (request, response) => {
    if (!checkOrigin(request, response)) return;
    const { code, code_verifier: verifier } = request.body ?? {};
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code) ||
        typeof verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      response.status(400).json({ error: "invalid_handoff" });
      return;
    }
    const identity = await store.consumeHandoff(mobileTokenHash(code), challengeFor(verifier), now());
    if (!identity || !identityForSession(identity)) {
      response.status(400).json({ error: "invalid_handoff" });
      return;
    }
    const token = secret();
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + ACCESS_LIFETIME_MS);
    await store.saveSession({
      token_hash: mobileTokenHash(token), identity, created_at: createdAt, expires_at: expiresAt,
    });
    response.json({ access_token: token, token_type: "Bearer", expires_at: expiresAt.toISOString() });
  });

  router.get("/api/v1/session", async (request, response) => {
    if (!request.user) return unauthorized(response);
    const workspace = await store.workspace(request.user.id);
    if (!workspace) return response.status(403).json({ error: "workspace_unavailable" });
    const appearance = appearancePreferenceService
      ? await appearancePreferenceService.getAppearancePreference(request.user.id) : "system";
    const expiresAt = request.nativeSession?.expires_at;
    const browserAuthenticatedAt = request.session?.passport?.user?.authenticatedAt;
    response.json({
      user: { id: request.user.id, email: request.user.email, name: request.user.name, is_admin: Boolean(request.user.isAdmin) },
      workspace, currency: workspace.base_currency, timezone: workspace.timezone,
      permissions: { read: true, write: true, admin: Boolean(request.user.isAdmin) },
      appearance,
      capabilities: {
        plan: true, insights: true, portfolio: true, credit: true,
        financekit: false, ...capabilities,
      },
      expires_at: request.nativeSession
        ? (expiresAt ? new Date(expiresAt).toISOString() : null)
        : (browserAuthenticatedAt ? new Date(browserAuthenticatedAt + 8 * 60 * 60 * 1_000).toISOString() : null),
      biometric_persistence_enabled: Boolean(request.nativeSession && !expiresAt),
      csrf_token: request.nativeSession ? null : (request.session?.csrfToken ?? null),
    });
  });

  router.patch("/auth/mobile/session", async (request, response) => {
    if (!request.nativeSession) return unauthorized(response);
    const enabled = request.body?.biometric_persistence_enabled;
    if (typeof enabled !== "boolean") return response.status(400).json({ error: "invalid_session_mode" });
    if (!enabled) {
      await store.revokeSession(request.nativeSession.token_hash);
      response.status(204).end();
      return;
    }
    const updated = await store.enablePersistence(request.nativeSession.token_hash);
    if (!updated) return unauthorized(response);
    response.json({ expires_at: null, biometric_persistence_enabled: true });
  });

  router.post("/auth/mobile/logout", async (request, response) => {
    if (!request.nativeSession) return unauthorized(response);
    await store.revokeSession(request.nativeSession.token_hash);
    response.status(204).end();
  });

  return {
    router, authenticate, begin, complete, callback,
    fail: (request, response) => redirect(request, response, { error: "authentication_failed" }),
  };
}
