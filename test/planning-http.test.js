import assert from "node:assert/strict";
import test from "node:test";

import request from "supertest";

import { createApp } from "../app/app.js";
import { loadConfig } from "../app/config.js";
import {
  FINANCE_TOOL_NAMES,
  PLANNING_READ_TOOL_NAMES,
  PLANNING_WRITE_TOOL_NAMES,
} from "../app/mcp/constants.js";
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

  assert.equal(
    readNames.length,
    FINANCE_TOOL_NAMES.length + PLANNING_READ_TOOL_NAMES.length,
  );
  assert.equal(
    writeNames.length,
    FINANCE_TOOL_NAMES.length +
      PLANNING_READ_TOOL_NAMES.length +
      PLANNING_WRITE_TOOL_NAMES.length,
  );
  assert.ok(readNames.includes("get_safe_to_spend"));
  assert.equal(readNames.includes("create_finance_goal"), false);
  assert.ok(readNames.includes("get_transaction_goal_spending"));
  assert.equal(readNames.includes("spend_from_finance_goal"), false);
  assert.ok(writeNames.includes("create_finance_goal"));
  assert.ok(writeNames.includes("spend_from_finance_goal"));
  assert.ok(writeNames.includes("reverse_goal_spend"));
  assert.ok(writeNames.includes("clear_category_budget"));
  assert.ok(writeNames.includes("set_budget_income_categories"));
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
        target_amount: 5_000,
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
    Object.hasOwn(
      first.body.result.structuredContent.data,
      "safe_to_spend",
    ),
    false,
  );
  assert.equal(
    first.body.result.structuredContent.data.audit_event_id,
    replay.body.result.structuredContent.data.audit_event_id,
  );
});

test("the Plan page renders the daily number, goals, schedules, and budgets", async () => {
  const app = createApp({
    config,
    financeService: createDemoFinanceService(),
    planningService: createDemoPlanningService(),
  });
  const response = await request(app)
    .get("/plan?month=2030-01")
    .set("Host", "money.test")
    .expect(200);
  assert.match(response.text, /Safe to Spend/);
  assert.match(response.text, /House down payment/);
  assert.match(response.text, /Every other Friday/);
  assert.match(response.text, /Edit budget/);
  assert.match(response.text, /<h2 id="budget-heading">Budget<\/h2>/);
  assert.match(response.text, /Previous month actual/);
  assert.match(response.text, /budget-row--total/);
  assert.match(
    response.text,
    /href="\/transactions\?category=category_dining"/,
  );
  assert.match(response.text, /\$71\.46 over/);
  assert.match(response.text, /\$65\.70 under/);
  assert.doesNotMatch(
    response.text,
    /type="month"|Budget month|View month|Standing plan|July 2026 actuals/,
  );
  assert.doesNotMatch(response.text, /Copy last month|Save month|Future default/);
  assert.doesNotMatch(response.text, /Add a budget category/);
  assert.doesNotMatch(response.text, /Model a scenario|Run scenario/);
  assert.match(response.text, /Allocation and plan history/);

  const totalIndex = response.text.indexOf("budget-row--total");
  const utilitiesIndex = response.text.indexOf(
    'href="/transactions?category=category_utilities"',
  );
  const otherIndex = response.text.indexOf(
    'href="/transactions?category=category_other"',
  );
  assert.ok(totalIndex >= 0 && totalIndex < otherIndex);
  assert.ok(utilitiesIndex >= 0 && utilitiesIndex < otherIndex);
  assert.match(
    response.text,
    /href="\/transactions\?category=category_dining">Dining<\/a>[\s\S]*?budget-cell-label">Planned<\/span><span class="budget-cell-value">\$450\.00<\/span>[\s\S]*?budget-cell-label">Actual<\/span><span class="budget-cell-value">\$521\.46<\/span>[\s\S]*?budget-cell-label">Previous month<\/span><span class="budget-cell-value">\$460\.00<\/span>/,
  );
});

test("the budget is view-only until edit mode is explicit", async () => {
  const app = createApp({
    config,
    financeService: createDemoFinanceService(),
    planningService: createDemoPlanningService(),
  });
  const response = await request(app)
    .get("/plan?edit_budget=1")
    .set("Host", "money.test")
    .expect(200);

  assert.match(response.text, /Done<\/a>/);
  assert.match(response.text, /Add budget categories/);
  assert.match(response.text, /Income categories/);
  assert.match(
    response.text,
    /data-endpoint="\/api\/v1\/plan\/budget\/batch"/,
  );
  assert.match(
    response.text,
    /data-budget-version="0"/,
  );
  assert.match(
    response.text,
    /name="expected_version" value="[1-9]\d*"/,
  );
  assert.match(response.text, /data-money-minor="amount_minor"/);
  assert.doesNotMatch(
    response.text,
    /name="scope"|name="effective_month_on"/,
  );
  assert.doesNotMatch(response.text, /Copy last month|Save month|Future default/);
});

test("Dashboard and Plan render one identical Safe to Spend card without a link", async () => {
  const planningService = createDemoPlanningService();
  const app = createApp({
    config,
    financeService: createDemoFinanceService(),
    planningService,
  });
  const dashboard = await request(app)
    .get("/")
    .set("Host", "money.test")
    .expect(200);
  const plan = await request(app)
    .get("/plan?month=2026-07")
    .set("Host", "money.test")
    .expect(200);
  const safeCard = (html) =>
    html.match(
      /<section class="card safe-to-spend-hero[\s\S]*?<\/section>/,
    )?.[0];

  assert.ok(safeCard(dashboard.text));
  assert.equal(safeCard(dashboard.text), safeCard(plan.text));
  assert.match(dashboard.text, /<h2 id="safe-to-spend-heading">Safe to Spend<\/h2>/);
  assert.match(dashboard.text, /class="display-money">\$33,734\.73<\/p>/);
  assert.match(
    safeCard(dashboard.text),
    /Liquid cash[\s\S]*Credit card balances[\s\S]*Expected bills[\s\S]*Goals/,
  );
  assert.match(
    safeCard(dashboard.text),
    /How Safe to Spend is calculated[\s\S]*Bill amounts and dates are estimates based on recurring history/,
  );
  assert.doesNotMatch(
    safeCard(dashboard.text),
    /Available after cards and cash-backed goals|Open the family plan|Cash details|quiet-link/,
  );
});

test("demo category drill-down projects saved splits into its ledger and detail", async () => {
  const planningService = createDemoPlanningService();
  await planningService.splitTransaction({
    transaction_id: "txn_whole_foods",
    expected_version: 0,
    lines: [
      { category: "Groceries", amount_minor: -8_842 },
      { category: "Other", amount_minor: -5_000 },
    ],
  });
  const app = createApp({
    config,
    financeService: createDemoFinanceService(),
    planningService,
  });

  const response = await request(app)
    .get(
      "/transactions?category=Other&transaction=txn_whole_foods",
    )
    .set("Host", "money.test")
    .expect(200);

  assert.match(
    response.text,
    /href="\/transactions\?category=Other&amp;transaction=txn_whole_foods"/,
  );
  assert.match(
    response.text,
    /id="selected-transaction-heading">Whole Foods Market<\/h2>[\s\S]*?<p[^>]*>[\s\S]*?Other · Everyday checking<\/span>\s+· <time[\s\S]*?>Jul 25, 2026<\/time>[\s\S]*?Business[\s\S]*?<\/p>/,
  );
  assert.match(
    response.text,
    /Whole Foods Market<\/strong>\s*<span[^>]*>Other · Everyday checking(?: · [^<]+)*<\/span>[\s\S]*?-\$50\.00/,
  );
  assert.match(response.text, /data-source-amount="-13842"/);
  assert.match(
    response.text,
    /name="expected_version" value="1"/,
  );
  assert.match(response.text, /Showing 1 transactions/);
});

test("the dashboard does not load the full family plan for Safe to Spend", async () => {
  const planningService = createDemoPlanningService();
  planningService.getPlanningOverview = async () => {
    throw new Error("dashboard must not load the full family plan");
  };
  const app = createApp({
    config,
    financeService: createDemoFinanceService(),
    planningService,
  });

  await request(app)
    .get("/")
    .set("Host", "money.test")
    .expect(200);
});

test("the transaction goal picker uses every active goal, not the paginated goal list", async () => {
  const planningService = createDemoPlanningService();
  const getSafeToSpend =
    planningService.getSafeToSpend.bind(planningService);
  planningService.getSafeToSpend = async () => {
    const result = await getSafeToSpend();
    return {
      ...result,
      data: {
        ...result.data,
        goals: Array.from({ length: 9 }, (_, index) => ({
          id: `goal_${index + 1}`,
          name: `Goal ${index + 1}`,
          status: "active",
          version: 1,
          cash_earmarked: {
            amount_minor: 0,
            currency: "USD",
          },
          brokerage_earmarked: {
            amount_minor: 0,
            currency: "USD",
          },
        })),
      },
    };
  };
  planningService.listFinanceGoals = async () => {
    throw new Error(
      "The transaction picker must not use the paginated goal list.",
    );
  };
  const app = createApp({
    config,
    financeService: createDemoFinanceService(),
    planningService,
  });

  const response = await request(app)
    .get("/transactions?transaction=txn_whole_foods")
    .set("Host", "money.test")
    .expect(200);

  assert.match(
    response.text,
    /value="goal_9"[\s\S]*?>Goal 9<\/option>/,
  );
});
