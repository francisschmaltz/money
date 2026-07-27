import assert from "node:assert/strict";
import test from "node:test";

import request from "supertest";

import { createApp } from "../app/app.js";
import { loadConfig } from "../app/config.js";
import {
  FINANCE_CARD_SCHEMA,
  FINANCE_TOOL_KIND_MAP,
  assertCanonicalJsonCopy,
} from "../app/mcp/index.js";
import { createDemoFinanceService } from "../app/services/demoFinanceService.js";

const config = loadConfig(
  {
    NODE_ENV: "test",
    AUTH_MODE: "mock",
    DEMO_MODE: "true",
    PUBLIC_BASE_URL: "http://money.test",
    MCP_BEARER_TOKEN: "test-mcp-token",
    MCP_ALLOWED_HOSTS: "money.test",
    MCP_CARD_BASE_URL: "https://money.example.com",
  },
  [],
);

function mcpRequest(app, body, token = "test-mcp-token") {
  return request(app)
    .post("/mcp")
    .set("Host", "money.test")
    .set("Authorization", `Bearer ${token}`)
    .set("Accept", "application/json, text/event-stream")
    .send(body);
}

function toolCall(name, args = {}, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

test("stateless HTTP MCP calls return prose, canonical JSON, and structuredContent", async () => {
  const app = createApp({
    config,
    financeService: createDemoFinanceService(),
  });

  const insights = await mcpRequest(
    app,
    toolCall("get_finance_insights", { section: "weekly" }),
  ).expect(200);
  const result = insights.body.result;

  assert.equal(result.structuredContent.schema, FINANCE_CARD_SCHEMA);
  assert.equal(result.structuredContent.kind, "insights");
  assert.equal(result.structuredContent.data.section, "weekly");
  assert.equal(result.content.length, 2);
  assert.doesNotMatch(result.content[0].text, /^\s*[\[{]/);
  assert.equal(
    assertCanonicalJsonCopy(
      result.content[1].text,
      result.structuredContent,
    ),
    true,
  );

  const accounts = await mcpRequest(
    app,
    toolCall("list_accounts", {}, 2),
  ).expect(200);
  assert.equal(accounts.body.result.structuredContent.kind, "accounts");
});

test("every finance card kind survives the direct Streamable HTTP transport", async () => {
  const app = createApp({
    config,
    financeService: createDemoFinanceService(),
  });
  const inputs = {
    get_finance_overview: {},
    get_finance_insights: { section: "all" },
    list_accounts: {},
    list_transactions: { status: "all", limit: 10 },
    get_spending_summary: { period: "month" },
    get_cash_flow: { period: "month", interval: "week" },
    list_recurring_payments: { kind: "all", status: "active" },
    get_net_worth_history: { interval: "month" },
    get_portfolio_summary: { period: "1m" },
    get_credit_score_summary: { period: "1y" },
  };

  let id = 100;
  for (const [toolName, kind] of Object.entries(FINANCE_TOOL_KIND_MAP)) {
    const response = await mcpRequest(
      app,
      toolCall(toolName, inputs[toolName], id++),
    ).expect(200);
    const result = response.body.result;
    assert.equal(result.isError, undefined, toolName);
    assert.equal(result.structuredContent.kind, kind, toolName);
    assert.equal(result.content.length, 2, toolName);
    assert.doesNotMatch(result.content[0].text, /^\s*[\[{]/, toolName);
    assert.match(result.content[0].text, /Data (?:is fresh )?as of/i, toolName);
    assert.equal(
      assertCanonicalJsonCopy(
        result.content[1].text,
        result.structuredContent,
      ),
      true,
      toolName,
    );
  }
});

test("HTTP MCP rejects bad credentials and disallows stateful methods", async () => {
  const app = createApp({
    config,
    financeService: createDemoFinanceService(),
  });

  await mcpRequest(
    app,
    toolCall("get_finance_overview"),
    "wrong-token",
  ).expect(401);

  const getResponse = await request(app)
    .get("/mcp")
    .set("Host", "money.test")
    .set("Authorization", "Bearer test-mcp-token")
    .expect(405);
  assert.equal(getResponse.headers.allow, "POST");

  const deleteResponse = await request(app)
    .delete("/mcp")
    .set("Host", "money.test")
    .set("Authorization", "Bearer test-mcp-token")
    .expect(405);
  assert.equal(deleteResponse.body.error.message, "Method not allowed for this stateless MCP endpoint.");
});
