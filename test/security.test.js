import assert from "node:assert/strict";
import test from "node:test";

import { safeLocalReturnTo } from "../app/auth.js";
import {
  allowedHost,
  bearerAuth,
  scopedBearerAuth,
  timingSafeStringEqual,
} from "../app/security.js";

function runMiddleware(middleware, headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const state = {
    status: 200,
    headers: {},
    body: undefined,
    nextCalled: false,
  };
  const request = {
    get(name) {
      return normalized[name.toLowerCase()];
    },
  };
  state.request = request;
  const response = {
    status(value) {
      state.status = value;
      return this;
    },
    set(name, value) {
      state.headers[name.toLowerCase()] = value;
      return this;
    },
    json(value) {
      state.body = value;
      return this;
    },
  };
  middleware(request, response, () => {
    state.nextCalled = true;
  });
  return state;
}

test("timing-safe token comparison compares content", () => {
  assert.equal(timingSafeStringEqual("secret", "secret"), true);
  assert.equal(timingSafeStringEqual("secret", "different"), false);
});

test("bearer middleware rejects missing and accepts valid credentials", () => {
  const middleware = bearerAuth("secret");
  const rejected = runMiddleware(middleware);
  assert.equal(rejected.status, 401);
  assert.match(rejected.headers["www-authenticate"], /money-mcp/);
  assert.equal(rejected.nextCalled, false);

  const accepted = runMiddleware(middleware, {
    authorization: "Bearer secret",
  });
  assert.equal(accepted.nextCalled, true);
});

test("scoped MCP credentials cannot elevate when read and write tokens collide", () => {
  const scoped = scopedBearerAuth({
    readToken: "read-secret",
    planWriteToken: "write-secret",
  });
  const read = runMiddleware(scoped, {
    authorization: "Bearer read-secret",
  });
  const write = runMiddleware(scoped, {
    authorization: "Bearer write-secret",
  });
  assert.equal(read.request.mcpScope, "read");
  assert.equal(write.request.mcpScope, "plan:write");

  const collision = runMiddleware(
    scopedBearerAuth({
      readToken: "same-secret",
      planWriteToken: "same-secret",
    }),
    { authorization: "Bearer same-secret" },
  );
  assert.equal(collision.request.mcpScope, "read");
});

test("host allowlist accepts explicit host and rejects other hosts", () => {
  const middleware = allowedHost(["money.example.com"]);
  const accepted = runMiddleware(middleware, {
    host: "money.example.com",
  });
  assert.equal(accepted.nextCalled, true);

  const rejected = runMiddleware(middleware, {
    host: "evil.example.com",
  });
  assert.equal(rejected.status, 421);
  assert.equal(rejected.nextCalled, false);
});

test("authentication return paths stay on the Money origin", () => {
  assert.equal(
    safeLocalReturnTo("/transactions?q=coffee#latest"),
    "/transactions?q=coffee#latest",
  );
  assert.equal(safeLocalReturnTo("//evil.example/steal"), "/");
  assert.equal(safeLocalReturnTo("/\\evil.example/steal"), "/");
  assert.equal(safeLocalReturnTo("https://evil.example/steal"), "/");
});
