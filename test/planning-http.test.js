import assert from "node:assert/strict";
import test from "node:test";

import request from "supertest";

import { createApp } from "../app/app.js";
import { loadConfig } from "../app/config.js";
import { createDemoFinanceService } from "../app/services/demoFinanceService.js";
import { createDemoPlanningService } from "../app/services/demoPlanningService.js";

const config = loadConfig(
  {
    NODE_ENV: "test",
    AUTH_MODE: "mock",
    DEMO_MODE: "true",
    PUBLIC_BASE_URL: "http://money.test",
    MCP_BEARER_TOKEN: "read-only-token",
    MCP_PLAN_WRITE_TOKEN: "planning-write-token",
    MCP_ALLOWED_HOSTS: "money.test",
    MCP_CARD_BASE_URL: "https://money.example.com",
  },
  [],
);

function call(app, token, body) {
  return request(app)
    .post("/mcp")
    .set("Host", "money.test")
    .set("Authorization", `Bearer ${token}`)
    .set("Accept", "application/json, text/event-stream")
    .send(body);
}

test("HTTP MCP discovery separates read and plan-write credentials", async () => {
  const app = createApp({
    config,
    financeService: createDemoFinanceService(),
    planningService: createDemoPlanningService(),
  });
  const list = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  };
  const read = await call(app, "read-only-token", list).expect(200);
  const write = await call(app, "planning-write-token", list).expect(200);
  const readNames = read.body.result.tools.map((tool) => tool.name);
  const writeNames = write.body.result.tools.map((tool) => tool.name);

  assert.equal(readNames.length, 14);
  assert.equal(writeNames.length, 21);
  assert.ok(readNames.includes("get_safe_to_spend"));
  assert.equal(readNames.includes("create_finance_goal"), false);
  assert.ok(writeNames.includes("create_finance_goal"));
});

test("only the plan credential can execute an idempotent audited write", async () => {
  const app = createApp({
    config,
    financeService: createDemoFinanceService(),
    planningService: createDemoPlanningService(),
  });
  const requestBody = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "create_finance_goal",
      arguments: {
        name: "Roof",
        target_amount_minor: 500_000,
        idempotency_key: "roof-goal-2026-07-27",
      },
    },
  };

  const denied = await call(
    app,
    "read-only-token",
    requestBody,
  ).expect(200);
  assert.equal(denied.body.result.isError, true);
  assert.match(
    denied.body.result.content[0].text,
    /Tool create_finance_goal not found/,
  );

  const first = await call(
    app,
    "planning-write-token",
    requestBody,
  ).expect(200);
  const replay = await call(
    app,
    "planning-write-token",
    { ...requestBody, id: 3 },
  ).expect(200);
  assert.equal(first.body.result.structuredContent.kind, "plan_change");
  assert.equal(
    first.body.result.structuredContent.data.audit_event_id,
    replay.body.result.structuredContent.data.audit_event_id,
  );
});

test("the Plan page renders the daily number, goals, schedules, budgets, and scenarios", async () => {
  const app = createApp({
    config,
    financeService: createDemoFinanceService(),
    planningService: createDemoPlanningService(),
  });
  const response = await request(app)
    .get("/plan?month=2026-07")
    .set("Host", "money.test")
    .expect(200);
  assert.match(response.text, /Safe to Spend/);
  assert.match(response.text, /House down payment/);
  assert.match(response.text, /Every other Friday/);
  assert.match(response.text, /Copy last month/);
  assert.match(response.text, /Model a scenario/);
  assert.match(response.text, /Allocation and plan history/);
});
