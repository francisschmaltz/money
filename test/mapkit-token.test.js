import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  verify,
} from "node:crypto";
import test from "node:test";

import express from "express";
import request from "supertest";

import { createApp } from "../app/app.js";
import { loadConfig, readiness } from "../app/config.js";
import {
  MapKitTokenError,
  createMapKitTokenProvider,
} from "../app/mapKitToken.js";
import { createWebRouter } from "../app/routes/web.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const privateKeyPem = privateKey.export({
  type: "pkcs8",
  format: "pem",
});

function decodeJwt(token) {
  const [encodedHeader, encodedClaims, encodedSignature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(encodedHeader, "base64url").toString()),
    claims: JSON.parse(Buffer.from(encodedClaims, "base64url").toString()),
    signingInput: `${encodedHeader}.${encodedClaims}`,
    signature: Buffer.from(encodedSignature, "base64url"),
  };
}

function providerConfig(overrides = {}) {
  return {
    teamId: "TEAM123456",
    keyId: "MAPS123456",
    privateKey: privateKeyPem,
    origin: "https://money.example.com",
    ...overrides,
  };
}

test("MapKit provider signs an origin-bound short-lived ES256 token", () => {
  const now = Date.UTC(2026, 7, 1, 12, 0, 0);
  const provider = createMapKitTokenProvider(providerConfig(), {
    now: () => now,
  });

  const result = provider.getToken();
  const decoded = decodeJwt(result.token);

  assert.deepEqual(decoded.header, {
    alg: "ES256",
    kid: "MAPS123456",
    typ: "JWT",
  });
  assert.deepEqual(decoded.claims, {
    iss: "TEAM123456",
    iat: Math.floor(now / 1_000),
    exp: Math.floor(now / 1_000) + 3_600,
    scope: "mapkit_js",
    origin: "https://money.example.com",
  });
  assert.equal(
    result.expiresAt,
    new Date(decoded.claims.exp * 1_000).toISOString(),
  );
  assert.equal(
    verify(
      "sha256",
      Buffer.from(decoded.signingInput),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      decoded.signature,
    ),
    true,
  );
});

test("MapKit provider caches until the 60-second refresh window", () => {
  let now = Date.UTC(2026, 7, 1, 12, 0, 0);
  const provider = createMapKitTokenProvider(providerConfig(), {
    now: () => now,
  });

  const first = provider.getToken();
  now += 3_539_000;
  assert.equal(provider.getToken(), first);

  now += 1_000;
  const refreshed = provider.getToken();
  assert.notEqual(refreshed, first);
  assert.notEqual(refreshed.token, first.token);
});

test("MapKit credentials are normalized and validated only when requested", () => {
  const provider = createMapKitTokenProvider({});
  assert.throws(
    () => provider.getToken(),
    (error) =>
      error instanceof MapKitTokenError &&
      /APPLE_TEAM_ID/.test(error.message),
  );

  const escapedKey = privateKeyPem.replaceAll("\n", "\\n");
  const escaped = createMapKitTokenProvider(
    providerConfig({ privateKey: escapedKey }),
  );
  assert.match(escaped.getToken().token, /^[^.]+\.[^.]+\.[^.]+$/);

  assert.throws(
    () =>
      createMapKitTokenProvider(
        providerConfig({ origin: "https://money.example.com/path" }),
      ).getToken(),
    /exact HTTP\(S\) origin/,
  );
});

test("MapKit configuration is optional and never affects readiness", () => {
  const missing = loadConfig({
    NODE_ENV: "test",
    DEMO_MODE: "true",
    PUBLIC_BASE_URL: "http://127.0.0.1:4173",
    MAPKIT_JS_TOKEN: "obsolete-static-token",
  });
  const configured = loadConfig({
    NODE_ENV: "test",
    DEMO_MODE: "true",
    PUBLIC_BASE_URL: "https://money.example.com",
    APPLE_TEAM_ID: " TEAM123456 ",
    APPLE_MAPS_KEY_ID: " MAPS123456 ",
    APPLE_MAPS_PRIVATE_KEY: privateKeyPem,
  });

  assert.deepEqual(missing.maps, {
    teamId: "",
    keyId: "",
    privateKey: "",
    origin: "http://127.0.0.1:4173",
  });
  assert.equal("mapkitJsToken" in missing.maps, false);
  assert.deepEqual(readiness(missing), { ready: true, failures: [] });
  assert.equal(configured.maps.teamId, "TEAM123456");
  assert.equal(configured.maps.keyId, "MAPS123456");
  assert.equal(configured.maps.privateKey, privateKeyPem);
  assert.equal(configured.maps.origin, "https://money.example.com");
});

test("authenticated MapKit endpoint returns a no-store token response", async () => {
  let calls = 0;
  const app = express();
  app.use(
    createWebRouter({
      requireAuth(request, response, next) {
        if (request.get("x-test-user") === "yes") {
          next();
          return;
        }
        response.status(401).json({ error: "unauthorized" });
      },
      mapkitTokenProvider: {
        getToken() {
          calls += 1;
          return {
            token: "signed-token",
            expiresAt: "2026-08-01T13:00:00.000Z",
          };
        },
      },
    }),
  );

  const unauthorized = await request(app)
    .get("/api/mapkit-token")
    .expect(401);
  assert.equal(unauthorized.headers["cache-control"], "no-store");
  assert.equal(calls, 0);

  const response = await request(app)
    .get("/api/mapkit-token")
    .set("x-test-user", "yes")
    .expect(200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.body, {
    token: "signed-token",
    expiresAt: "2026-08-01T13:00:00.000Z",
  });
  assert.equal(calls, 1);
});

test("MapKit endpoint contains signer failures and leaves app readiness alone", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    AUTH_MODE: "mock",
    DEMO_MODE: "true",
    PUBLIC_BASE_URL: "http://money.test",
  });
  const app = createApp({ config });

  await request(app).get("/health/ready").expect(200, {
    status: "ready",
    database: "ready",
  });
  const response = await request(app)
    .get("/api/mapkit-token")
    .expect(503);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.body, {
    error: "map_unavailable",
    message: "The map preview is unavailable.",
  });
  assert.doesNotMatch(JSON.stringify(response.body), /APPLE_|private|sign/i);
});
