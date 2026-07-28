import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig, readiness } from "../app/config.js";
import { databaseSslOptions } from "../app/db/pool.js";

test("database TLS verification defaults on and can be explicitly disabled", () => {
  assert.equal(databaseSslOptions(), undefined);
  assert.deepEqual(
    databaseSslOptions({ enabled: true }),
    { rejectUnauthorized: true },
  );
  assert.deepEqual(
    databaseSslOptions({
      enabled: "true",
      rejectUnauthorized: "false",
    }),
    { rejectUnauthorized: false },
  );
  assert.equal(
    databaseSslOptions({
      enabled: false,
      rejectUnauthorized: false,
    }),
    false,
  );

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_SSL: "true",
    DATABASE_SSL_REJECT_UNAUTHORIZED: "false",
  });
  assert.equal(config.database.ssl, true);
  assert.equal(config.database.sslRejectUnauthorized, false);
});

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

test("admin identities do not require an application allowlist", () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DUO_ADMIN_EMAILS: "ADMIN@example.com",
  });

  assert.deepEqual([...config.auth.adminEmails], ["admin@example.com"]);
  assert.equal("allowedEmails" in config.auth, false);
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
  assert.equal(
    config.plaid.redirectUri,
    "http://127.0.0.1:4173/plaid/oauth",
  );
  assert.deepEqual(readiness(config), { ready: true, failures: [] });
});

test("demo scenario defaults safely and accepts the UX stress fixture", () => {
  const defaults = loadConfig({
    NODE_ENV: "test",
    DEMO_MODE: "true",
  });
  const stress = loadConfig({
    NODE_ENV: "test",
    DEMO_MODE: "true",
    DEMO_SCENARIO: "ux-stress",
  });

  assert.equal(defaults.demoScenario, "default");
  assert.equal(stress.demoScenario, "ux-stress");
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "test",
        DEMO_MODE: "true",
        DEMO_SCENARIO: "surprise",
      }),
    /Invalid option/,
  );
});

test("production readiness reports every missing auth and service secret", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    AUTH_MODE: "oidc",
    PUBLIC_BASE_URL: "https://money.example.com",
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
      "MCP_PLAN_WRITE_TOKEN",
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
    "PLAID_CLIENT_ID",
    "PLAID_SECRET",
    "MCP_BEARER_TOKEN",
    "MCP_PLAN_WRITE_TOKEN",
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
