import assert from "node:assert/strict";
import test from "node:test";

import { log } from "../app/log.js";

test("logs redact credentials and financial detail", () => {
  const original = console.log;
  let output = "";
  console.log = (value) => {
    output = value;
  };
  try {
    log("info", "request failed", {
      authorization: "Bearer top-secret",
      amount_minor: 12_345,
      merchant_name: "Private Merchant",
      error:
        "postgres://money:password@db/money access-production-private-token access_token=dynamic-secret",
    });
  } finally {
    console.log = original;
  }

  assert.doesNotMatch(
    output,
    /top-secret|12_345|12345|Private Merchant|password|private-token|dynamic-secret/,
  );
  assert.match(output, /\[redacted\]/);
});

test("logs redact OIDC secrets and transient authorization artifacts", () => {
  const original = console.log;
  let output = "";
  console.log = (value) => {
    output = value;
  };
  try {
    log(
      "info",
      "callback failed with id_token=message-id-token",
      {
        callback:
          "https://money.example/auth/duo/callback?code=callback-code&state=callback-state",
        code_verifier: "verifier-value",
        code_challenge: "challenge-value",
        nonce: "nonce-value",
        state: "state-value",
        response:
          'refresh_token="refresh-value" client_secret=client-secret-value {"client_assertion":"assertion-value","id_token":"json-id-token"}',
        basicAuthorization: "Authorization: Basic dXNlcjpzZWNyZXQ=",
        compactJwt: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
      },
    );
  } finally {
    console.log = original;
  }

  assert.doesNotMatch(
    output,
    /message-id-token|callback-code|callback-state|verifier-value|challenge-value|nonce-value|state-value|refresh-value|client-secret-value|assertion-value|json-id-token|dXNlcjpzZWNyZXQ|eyJhbGciOiJSUzI1NiJ9/,
  );
  assert.match(output, /\[redacted\]/);
});

test("OIDC redaction preserves ordinary diagnostic fields", () => {
  const original = console.log;
  let output = "";
  console.log = (value) => {
    output = value;
  };
  try {
    log("info", "token refresh completed", {
      code: "ECONNRESET",
      code_challenge_method: "S256",
      status: 502,
      workflow_state: "queued",
    });
  } finally {
    console.log = original;
  }

  const entry = JSON.parse(output);
  assert.equal(entry.message, "token refresh completed");
  assert.equal(entry.code, "ECONNRESET");
  assert.equal(entry.code_challenge_method, "S256");
  assert.equal(entry.status, 502);
  assert.equal(entry.workflow_state, "queued");
});
