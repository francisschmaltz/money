import assert from "node:assert/strict";
import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";

import express from "express";
import { exportJWK, SignJWT } from "jose";
import * as oidc from "openid-client";
import request from "supertest";

import {
  createAuth,
  createOidcConfiguration,
  createSessionMiddleware,
  identityForOidcClaims,
  identityForStoredSession,
  validateOidcConfiguration,
} from "../app/auth.js";

const issuer =
  "https://sso-example.sso.duosecurity.com/oidc/DIEXAMPLE";
const clientId = "money-client";
const clientSecret = "not-a-production-secret";
const redirectUri = "http://127.0.0.1/auth/duo/callback";

function metadata(overrides = {}) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"],
    id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic"],
    scopes_supported: ["openid", "email", "profile"],
    ...overrides,
  };
}

function configuration(serverMetadata = metadata()) {
  return new oidc.Configuration(
    serverMetadata,
    clientId,
    {
      client_secret: clientSecret,
      token_endpoint_auth_method: "client_secret_basic",
      id_token_signed_response_alg: "RS256",
    },
    oidc.ClientSecretBasic(clientSecret),
  );
}

function config(overrides = {}) {
  const adminEmails = new Set(["admin@example.com"]);
  return {
    production: false,
    auth: {
      mode: "oidc",
      adminEmails,
      sessionSecret: "test-session-secret-with-enough-entropy",
      duo: {
        issuer,
        clientId,
        clientSecret,
        authorizationUrl: "",
        tokenUrl: "",
        redirectUri,
        scope: "openid email profile",
      },
    },
    ...overrides,
  };
}

function authApp({
  oidcConfiguration = configuration(),
  onAuthenticated = null,
} = {}) {
  const app = express();
  const appConfig = config();
  app.use(createSessionMiddleware({ config: appConfig, pool: null }));
  app.use(
    createAuth({
      config: appConfig,
      oidcConfiguration,
      onAuthenticated,
    }).router,
  );
  app.get("/signed-in", (req, res) => {
    res.json({ user: req.user || null });
  });
  app.get("/session", (req, res) => {
    res.json(req.session);
  });
  app.use((error, _req, res, _next) => {
    res.status(400).json({ name: error.name, code: error.code });
  });
  return app;
}

function loginParameters(location) {
  return new URL(location).searchParams;
}

test("OIDC claims require a verified email and stable subject", () => {
  const appConfig = config();

  assert.deepEqual(
    identityForOidcClaims(
      {
        sub: "duo-user-1",
        email: "ADMIN@EXAMPLE.COM",
        email_verified: true,
        name: "Ada Admin",
      },
      appConfig,
    ),
    {
      subject: "duo-user-1",
      email: "admin@example.com",
      name: "Ada Admin",
      isAdmin: true,
    },
  );

  assert.deepEqual(
    identityForOidcClaims(
      {
        sub: "duo-user-2",
        email: "outsider@example.com",
        email_verified: true,
      },
      appConfig,
    ),
    {
      subject: "duo-user-2",
      email: "outsider@example.com",
      name: "outsider",
      isAdmin: false,
    },
  );

  for (const claims of [
    {
      sub: "duo-user-3",
      email: "reader@example.com",
      email_verified: false,
    },
    {
      email: "reader@example.com",
      email_verified: true,
    },
    {
      sub: "",
      email: "reader@example.com",
      email_verified: true,
    },
  ]) {
    assert.equal(identityForOidcClaims(claims, appConfig), null);
  }
});

test("stored sessions expire absolutely and re-evaluate access roles", () => {
  const now = Date.parse("2026-07-27T05:00:00Z");
  const stored = {
    id: "local-user-1",
    email: "admin@example.com",
    name: "Ada Admin",
    subject: "duo-user-1",
    authenticatedAt: now - (8 * 60 * 60 * 1_000 - 1),
  };
  const appConfig = config();

  assert.equal(
    identityForStoredSession(stored, appConfig, now)?.isAdmin,
    true,
  );

  appConfig.auth.adminEmails.clear();
  assert.equal(
    identityForStoredSession(stored, appConfig, now)?.isAdmin,
    false,
  );

  assert.equal(
    identityForStoredSession(
      {
        ...stored,
        authenticatedAt: now - 8 * 60 * 60 * 1_000,
      },
      config(),
      now,
    ),
    null,
  );
});

test("production refuses to create sessions with a weak secret", () => {
  const appConfig = config({ production: true });
  appConfig.auth.sessionSecret = "tiny";

  assert.throws(
    () => createSessionMiddleware({ config: appConfig, pool: null }),
    /at least 32 bytes/,
  );
});

test("OIDC discovery validation accepts Duo Generic OIDC metadata", () => {
  const oidcConfiguration = configuration();

  assert.equal(
    validateOidcConfiguration(config(), oidcConfiguration),
    oidcConfiguration,
  );
});

test("OIDC discovery validation rejects unsafe or incompatible metadata", () => {
  const cases = [
    [
      "unexpected issuer",
      metadata({ issuer: `${issuer}/other` }),
      /unexpected issuer/,
    ],
    [
      "cross-origin authorization endpoint",
      metadata({
        authorization_endpoint: "https://evil.example/authorize",
      }),
      /issuer origin/,
    ],
    [
      "insecure token endpoint",
      metadata({ token_endpoint: "http://example.test/token" }),
      /must use HTTPS/,
    ],
    [
      "MFA-only oauth/v1 endpoint",
      metadata({ authorization_endpoint: `${new URL(issuer).origin}/oauth/v1/authorize` }),
      /MFA-only/,
    ],
    [
      "implicit-only response types",
      metadata({ response_types_supported: ["id_token"] }),
      /authorization code flow/,
    ],
    [
      "non-RS256 ID tokens",
      metadata({ id_token_signing_alg_values_supported: ["ES256"] }),
      /RS256/,
    ],
    [
      "no PKCE S256",
      metadata({ code_challenge_methods_supported: ["plain"] }),
      /PKCE S256/,
    ],
    [
      "no client_secret_basic",
      metadata({ token_endpoint_auth_methods_supported: ["client_secret_post"] }),
      /client_secret_basic/,
    ],
    [
      "missing profile scope",
      metadata({ scopes_supported: ["openid", "email"] }),
      /missing required scopes: profile/,
    ],
  ];

  for (const [label, serverMetadata, expected] of cases) {
    assert.throws(
      () =>
        validateOidcConfiguration(
          config({
            auth: {
              ...config().auth,
              duo: {
                ...config().auth.duo,
                issuer:
                  label === "unexpected issuer"
                    ? issuer
                    : serverMetadata.issuer,
              },
            },
          }),
          configuration(serverMetadata),
        ),
      expected,
      label,
    );
  }
});

test("configured authorization and token URLs must match discovery", () => {
  for (const [field, value, expected] of [
    ["authorizationUrl", `${issuer}/different-authorize`, /DUO_AUTHORIZATION_URL/],
    ["tokenUrl", `${issuer}/different-token`, /DUO_TOKEN_URL/],
  ]) {
    const base = config();
    const appConfig = {
      ...base,
      auth: {
        ...base.auth,
        duo: { ...base.auth.duo, [field]: value },
      },
    };
    assert.throws(
      () => validateOidcConfiguration(appConfig, configuration()),
      expected,
    );
  }
});

test("MFA-only Duo api hosts and oauth/v1 paths are rejected before discovery", async () => {
  for (const endpoint of [
    "https://api-12345.duosecurity.com/oauth/v1/authorize",
    "https://sso-example.sso.duosecurity.com/oauth/v1/token",
  ]) {
    const base = config();
    let discoveryCalled = false;
    const appConfig = {
      ...base,
      auth: {
        ...base.auth,
        duo: {
          ...base.auth.duo,
          authorizationUrl: endpoint,
        },
      },
    };

    await assert.rejects(
      createOidcConfiguration(appConfig, {
        discover: async () => {
          discoveryCalled = true;
          return configuration();
        },
      }),
      /MFA-only/,
    );
    assert.equal(discoveryCalled, false);
  }
});

test("missing required OIDC settings fail before discovery", async () => {
  const base = config();
  let discoveryCalled = false;
  const appConfig = {
    ...base,
    auth: {
      ...base.auth,
      duo: {
        ...base.auth.duo,
        issuer: "",
        clientId: "",
        clientSecret: "",
      },
    },
  };

  await assert.rejects(
    createOidcConfiguration(appConfig, {
      discover: async () => {
        discoveryCalled = true;
        return configuration();
      },
    }),
    /DUO_OIDC_ISSUER, DUO_CLIENT_ID, DUO_CLIENT_SECRET/,
  );
  assert.equal(discoveryCalled, false);
});

test("OIDC discovery is configured for client_secret_basic and validated metadata", async () => {
  let call;
  const discovered = configuration();
  const resolved = await createOidcConfiguration(config(), {
    discover: async (...args) => {
      call = args;
      return discovered;
    },
  });

  assert.equal(resolved, discovered);
  assert.equal(call[0].href, issuer);
  assert.equal(call[1], clientId);
  assert.deepEqual(call[2], {
    client_secret: clientSecret,
    token_endpoint_auth_method: "client_secret_basic",
    id_token_signed_response_alg: "RS256",
  });
  assert.equal(typeof call[3], "function");
  assert.deepEqual(call[4], { timeout: 10 });
});

test("login sends authorization code, state, nonce, and PKCE S256 parameters", async () => {
  const first = await request(authApp())
    .get("/auth/login")
    .query({ return_to: "/transactions?q=coffee" })
    .expect(302);
  const second = await request(authApp()).get("/auth/login").expect(302);
  const firstUrl = new URL(first.headers.location);
  const firstParams = firstUrl.searchParams;
  const secondParams = loginParameters(second.headers.location);

  assert.equal(firstUrl.origin, new URL(issuer).origin);
  assert.equal(firstUrl.pathname, `${new URL(issuer).pathname}/authorize`);
  assert.equal(firstParams.get("response_type"), "code");
  assert.equal(firstParams.get("client_id"), clientId);
  assert.equal(firstParams.get("redirect_uri"), redirectUri);
  assert.equal(firstParams.get("scope"), "openid email profile");
  assert.equal(firstParams.get("code_challenge_method"), "S256");

  for (const name of ["state", "nonce", "code_challenge"]) {
    assert.match(firstParams.get(name) || "", /^[A-Za-z0-9_-]{32,}$/);
    assert.notEqual(firstParams.get(name), secondParams.get(name));
  }
});

test("OIDC callback validates state, nonce, and signs in a verified user", async () => {
  const generateKeyPairAsync = promisify(generateKeyPair);
  const { publicKey, privateKey } = await generateKeyPairAsync("rsa", {
    modulusLength: 2048,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "duo-test-key";
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";

  const oidcConfiguration = configuration();
  let expectedNonce;
  let issuedIdToken;
  let tokenRequestBody;
  let tokenRequests = 0;
  oidcConfiguration[oidc.customFetch] = async (url, options = {}) => {
    const target = new URL(url);
    if (target.href === `${issuer}/token`) {
      tokenRequests += 1;
      tokenRequestBody = String(options.body || "");
      const now = Math.floor(Date.now() / 1000);
      issuedIdToken = await new SignJWT({
        email: "reader@example.com",
        email_verified: true,
        name: "Riley Reader",
        nonce: expectedNonce,
      })
        .setProtectedHeader({
          alg: "RS256",
          kid: publicJwk.kid,
          typ: "JWT",
        })
        .setIssuer(issuer)
        .setAudience(clientId)
        .setSubject("duo-user-42")
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);
      return Response.json({
        access_token: "test-access-token",
        token_type: "Bearer",
        expires_in: 300,
        id_token: issuedIdToken,
      });
    }
    if (target.href === `${issuer}/jwks`) {
      return Response.json({ keys: [publicJwk] });
    }
    throw new Error(`Unexpected OIDC request: ${target.href}`);
  };

  const persisted = [];
  const agent = request.agent(
    authApp({
      oidcConfiguration,
      onAuthenticated: async (identity) => {
        persisted.push(identity);
        return { id: "local-user-1" };
      },
    }),
  );
  const login = await agent
    .get("/auth/login")
    .query({ return_to: "/signed-in" })
    .expect(302);
  const parameters = loginParameters(login.headers.location);
  expectedNonce = parameters.get("nonce");

  const callback = await agent
    .get("/auth/duo/callback")
    .query({ code: "valid-code", state: parameters.get("state") })
    .expect(302)
    .expect("location", "/signed-in");

  assert.notEqual(
    callback.headers["set-cookie"]?.[0],
    login.headers["set-cookie"]?.[0],
    "the authenticated session must rotate",
  );
  assert.match(tokenRequestBody, /code=valid-code/);
  assert.match(tokenRequestBody, /code_verifier=/);
  assert.equal(tokenRequests, 1);
  assert.deepEqual(persisted, [
    {
      email: "reader@example.com",
      name: "Riley Reader",
      isAdmin: false,
      subject: "duo-user-42",
    },
  ]);

  const signedIn = await agent.get("/signed-in").expect(200);
  assert.deepEqual(signedIn.body, {
    user: {
      email: "reader@example.com",
      name: "Riley Reader",
      isAdmin: false,
      subject: "duo-user-42",
      id: "local-user-1",
    },
  });

  const storedSession = JSON.stringify(
    (await agent.get("/session").expect(200)).body,
  );
  assert.doesNotMatch(storedSession, /test-access-token/);
  assert.equal(storedSession.includes(issuedIdToken), false);

  await agent
    .get("/auth/duo/callback")
    .query({ code: "valid-code", state: parameters.get("state") })
    .expect(302)
    .expect("location", "/login?error=not-allowed");
  assert.equal(tokenRequests, 1, "a consumed callback cannot be replayed");
});

test("OIDC callback rejects the wrong state before token exchange", async () => {
  const oidcConfiguration = configuration();
  let fetchCalled = false;
  oidcConfiguration[oidc.customFetch] = async () => {
    fetchCalled = true;
    throw new Error("The token endpoint must not be called.");
  };

  const agent = request.agent(authApp({ oidcConfiguration }));
  await agent.get("/auth/login").expect(302);
  const callback = await agent
    .get("/auth/duo/callback")
    .query({ code: "valid-code", state: "wrong-state" })
    .expect(400);

  assert.equal(fetchCalled, false);
  assert.match(
    `${callback.body.name} ${callback.body.code}`,
    /OAUTH_INVALID_RESPONSE|OAUTH_JWT_CLAIM_COMPARISON_FAILED|unexpected/i,
  );
});
