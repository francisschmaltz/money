import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig, readiness } from "../app/config.js";

test("production rejects mock authentication", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        AUTH_MODE: "mock",
        PUBLIC_BASE_URL: "https://money.example.com",
      }),
    /forbidden/,
  );
});

test("production rejects demo mode even when a database is configured", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        AUTH_MODE: "oidc",
        DEMO_MODE: "true",
        DATABASE_URL: "postgres://money:secret@db/money",
        PUBLIC_BASE_URL: "https://money.example.com",
      }),
    /DEMO_MODE=true is forbidden in production/,
  );
});

test("production requires DATABASE_URL instead of falling back to demo mode", () => {
  for (const databaseUrl of [undefined, "   "]) {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "production",
          AUTH_MODE: "oidc",
          PUBLIC_BASE_URL: "https://money.example.com",
          DATABASE_URL: databaseUrl,
        }),
      /DATABASE_URL is required in production/,
    );
  }
});

test("admin identities must be allowlisted", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "test",
        DUO_ALLOWED_EMAILS: "reader@example.com",
        DUO_ADMIN_EMAILS: "admin@example.com",
      }),
    /must also be allowlisted/,
  );
});

test("development config supports explicit demo mode", () => {
  const config = loadConfig({
    NODE_ENV: "development",
    DEMO_MODE: "true",
    AUTH_MODE: "mock",
    PUBLIC_BASE_URL: "http://127.0.0.1:4173",
  });

  assert.equal(config.demoMode, true);
  assert.equal(config.publicBaseUrl, "http://127.0.0.1:4173");
  assert.deepEqual(readiness(config), { ready: true, failures: [] });
});

test("production readiness reports every missing auth and service secret", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    AUTH_MODE: "oidc",
    PUBLIC_BASE_URL: "https://money.example.com",
    DUO_ALLOWED_EMAILS: "reader@example.com",
    DEMO_MODE: "false",
    DATABASE_URL: "postgres://money:secret@db/money",
    SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  });
  const incompleteConfig = {
    ...config,
    database: { ...config.database, url: "" },
    auth: { ...config.auth, sessionSecret: "" },
  };

  assert.deepEqual(readiness(incompleteConfig), {
    ready: false,
    failures: [
      "DATABASE_URL",
      "SESSION_SECRET",
      "DUO_OIDC_ISSUER",
      "DUO_CLIENT_ID",
      "DUO_CLIENT_SECRET",
      "PLAID_CLIENT_ID",
      "PLAID_SECRET",
      "MCP_BEARER_TOKEN",
    ],
  });
});

test("production readiness cannot bypass service secrets with a demo flag", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    AUTH_MODE: "oidc",
    PUBLIC_BASE_URL: "https://money.example.com",
    DATABASE_URL: "postgres://money:secret@db/money",
    SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  });
  const impossibleDemoConfig = {
    ...config,
    demoMode: true,
    database: { ...config.database, url: "" },
    auth: { ...config.auth, sessionSecret: "" },
  };

  assert.deepEqual(readiness(impossibleDemoConfig).failures, [
    "DATABASE_URL",
    "SESSION_SECRET",
    "DUO_OIDC_ISSUER",
    "DUO_CLIENT_ID",
    "DUO_CLIENT_SECRET",
    "DUO_ALLOWED_EMAILS",
    "PLAID_CLIENT_ID",
    "PLAID_SECRET",
    "MCP_BEARER_TOKEN",
  ]);
});

test("OIDC redirect URI must stay on the Money origin", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "test",
        AUTH_MODE: "oidc",
        PUBLIC_BASE_URL: "https://money.example.com",
        DUO_REDIRECT_URI: "https://evil.example/auth/duo/callback",
      }),
    /exactly match/,
  );
});

test("production requires a real public origin and exact mounted callback", () => {
  const base = {
    NODE_ENV: "production",
    AUTH_MODE: "oidc",
    DATABASE_URL: "postgres://money:secret@db/money",
    SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  };

  assert.throws(() => loadConfig(base), /PUBLIC_BASE_URL is required/);
  assert.throws(
    () =>
      loadConfig({
        ...base,
        PUBLIC_BASE_URL: "http://money.example.com",
      }),
    /must use HTTPS/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...base,
        PUBLIC_BASE_URL: "https://money.example.com",
        DUO_REDIRECT_URI: "https://money.example.com/not-the-callback",
      }),
    /exactly match/,
  );
});

test("production readiness rejects weak session secrets", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    AUTH_MODE: "oidc",
    DATABASE_URL: "postgres://money:secret@db/money",
    PUBLIC_BASE_URL: "https://money.example.com",
    SESSION_SECRET: "tiny",
  });

  assert.ok(readiness(config).failures.includes("SESSION_SECRET"));
});

test("OIDC configuration keeps the Duo issuer and optional endpoint checks", () => {
  const config = loadConfig({
    NODE_ENV: "test",
    AUTH_MODE: "oidc",
    PUBLIC_BASE_URL: "https://money.example.com",
    DUO_OIDC_ISSUER:
      "https://sso-example.sso.duosecurity.com/oidc/DIEXAMPLE/",
    DUO_CLIENT_ID: "DIEXAMPLE",
    DUO_CLIENT_SECRET: "secret",
    DUO_AUTHORIZATION_URL:
      "https://sso-example.sso.duosecurity.com/oidc/DIEXAMPLE/authorize",
    DUO_TOKEN_URL:
      "https://sso-example.sso.duosecurity.com/oidc/DIEXAMPLE/token",
  });

  assert.equal(
    config.auth.duo.issuer,
    "https://sso-example.sso.duosecurity.com/oidc/DIEXAMPLE",
  );
  assert.equal(
    config.auth.duo.redirectUri,
    "https://money.example.com/auth/duo/callback",
  );
  assert.equal(config.auth.duo.scope, "openid email profile");
});
