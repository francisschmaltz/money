import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createApiRouter } from "../app/routes/api.js";
import { createDemoFinanceService } from "../app/services/demoFinanceService.js";
import { createDemoPlanningService } from "../app/services/demoPlanningService.js";
import { FinanceService } from "../app/services/financeService.js";

function api({ financeService = createDemoFinanceService(), planningService, isAdmin = true, ...options } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "demo-user", isAdmin };
    next();
  });
  app.use(createApiRouter({
    financeService,
    planningService: planningService ?? createDemoPlanningService({ financeService }),
    requireAdmin: (req, res, next) => req.user.isAdmin ? next() : res.status(403).json({ error: "forbidden" }),
    ...options,
  }));
  app.use((error, _req, res, _next) => res.status(error.statusCode ?? error.status ?? 500).json({ error: error.message }));
  return app;
}

test("native details compose canonical transactions, splits, goal versions and Plan reads", async () => {
  const app = api();
  const transactions = await request(app).get("/api/v1/transactions").expect(200);
  const id = transactions.body.data.transactions.find((row) => !row.pending).id;
  const detail = await request(app).get(`/api/v1/transactions/${id}`).expect(200);
  assert.equal(detail.body.data.transaction.id, id);
  assert.equal(typeof detail.body.data.transaction.amount.amount_minor, "number");
  assert.equal(typeof detail.body.data.splits.split_version, "number");
  assert.equal(typeof detail.body.data.goal_spending.goal_spend_version, "number");
  assert.equal(detail.body.data.recurring_context.transaction_id, id);
  const overview = await request(app).get("/api/v1/plan/overview").expect(200);
  assert.ok(overview.body.data.safe_to_spend);
  assert.ok(Array.isArray(overview.body.data.budget.available_categories));
  assert.ok(Array.isArray(overview.body.data.audit_events));
  assert.equal(overview.body.data.safeToSpend, undefined);
  const goal = overview.body.data.goals[0];
  const goalDetail = await request(app).get(`/api/v1/plan/goals/${goal.id}`).expect(200);
  assert.equal(goalDetail.body.data.goal.id, goal.id);
  const credit = await request(app).get("/api/v1/credit?period=1m").expect(200);
  assert.equal(typeof credit.body.data.summary.total_balance_owed.amount_minor, "number");
  await request(app).get("/api/v1/credit?period=garbage").expect(400);
  await request(app).get("/api/v1/transactions/missing").expect(404);
});

test("member category reads and budget choices work while connection inventory stays admin-only", async () => {
  const app = api({ isAdmin: false });
  const categories = await request(app).get("/api/v1/categories").expect(200);
  assert.ok(categories.body.categories.length);
  const budget = await request(app).get("/api/v1/plan/budget?include_available_categories=true").expect(200);
  assert.ok(budget.body.data.available_categories.length);
  await request(app).get("/api/v1/connections").expect(403);
  await request(app).post("/api/v1/categories").send({ name: "Forbidden" }).expect(403);
});

test("native insight pages include active/archive detail without MCP delivery caps", async () => {
  const app = api();
  const first = await request(app).get("/api/v1/insight-feed?limit=2").expect(200);
  assert.equal(first.body.data.findings.length, 2);
  assert.equal(first.body.data.page_info.has_more, true);
  const second = await request(app).get("/api/v1/insight-feed").query({ limit: 2, cursor: first.body.data.page_info.next_cursor }).expect(200);
  assert.ok(second.body.data.findings.every((row) => !first.body.data.findings.some((previous) => previous.id === row.id)));
  const archive = await request(app).get("/api/v1/insight-feed?view=archive").expect(200);
  assert.ok(archive.body.data.findings.length);
  assert.ok(archive.body.data.findings.every((row) => row.state !== "active"));
  const id = archive.body.data.findings[0].id;
  const detail = await request(app).get(`/api/v1/insights/${id}`).expect(200);
  assert.equal(detail.body.data.finding.id, id);
  await request(app).get("/api/v1/insight-feed?cursor=invalid").expect(400);
  await request(app).get("/api/v1/insight-feed?view=other").expect(400);
  await request(app).get("/api/v1/insight-feed/missing").expect(404);
});

test("recurring/accounts paginate and global search returns native entity destinations", async () => {
  const app = api();
  for (const endpoint of ["accounts", "recurring"]) {
    const first = await request(app).get(`/api/v1/${endpoint}?limit=1`).expect(200);
    assert.ok(first.body.data.page_info.next_cursor);
    const second = await request(app).get(`/api/v1/${endpoint}`).query({ limit: 1, cursor: first.body.data.page_info.next_cursor }).expect(200);
    const rows = (body) => endpoint === "accounts" ? body.data.groups.flatMap((group) => group.accounts) : body.data.recurring_payments;
    assert.notEqual(rows(first.body)[0].id, rows(second.body)[0].id);
    if (endpoint === "recurring") {
      const detail = await request(app).get(`/api/v1/recurring/${rows(first.body)[0].id}`).expect(200);
      assert.ok(detail.body.data.recurring_payment);
      assert.ok(Array.isArray(detail.body.data.transactions));
    }
  }
  const assets = await request(app).get("/api/v1/manual-assets?limit=1").expect(200);
  assert.equal(assets.body.data.manual_assets.length, 1);
  assert.equal(assets.body.data.page_info.has_more, false);
  const portfolio = await request(app).get("/api/v1/portfolio?holdings_limit=1").expect(200);
  const nextPortfolio = await request(app).get("/api/v1/portfolio").query({ holdings_limit: 1, holdings_cursor: portfolio.body.data.page_info.next_cursor }).expect(200);
  assert.notEqual(portfolio.body.data.holdings[0].id, nextPortfolio.body.data.holdings[0].id);
  assert.deepEqual(portfolio.body.data.total_value, nextPortfolio.body.data.total_value);
  const search = await request(app).get("/api/v1/search?q=Whole&entity_type=transaction").expect(200);
  assert.ok(search.body.returned_count > 0);
  for (const item of search.body.groups.flatMap((group) => group.items)) {
    assert.equal(item.entity_type, "transaction");
    assert.ok(item.entity_id);
  }
  await request(app).get("/api/v1/search?q=test&entity_type=secret").expect(400);
});

test("real connection metadata is allowlisted and real insight pagination reaches repository", async () => {
  let insightQuery;
  const financeService = new FinanceService({ repository: {
    getDataFreshness: async () => ({ data_as_of: "2026-07-27T00:00:00Z", partial: true, warnings: ["stale"] }),
    listFinanceConnections: async () => [{ id: "connection", provider: "plaid", access_token: "must-not-leak", secret: "must-not-leak" }],
    listInsightFindings: async (_workspace, query) => {
      insightQuery = query;
      return Array.from({ length: query.limit }, (_, index) => ({ id: String(query.offset + index), family: "weekly", state: "active" }));
    },
  } });
  const app = api({ financeService });
  const connections = await request(app).get("/api/v1/connections").expect(200);
  assert.equal(connections.body.data.connections[0].id, "connection");
  assert.equal(connections.body.data.connections[0].access_token, undefined);
  assert.equal(connections.body.data.connections[0].secret, undefined);
  assert.equal(connections.body.partial, true);
  const first = await request(app).get("/api/v1/insight-feed?limit=2&section=weekly").expect(200);
  assert.equal(insightQuery.limit, 3);
  await request(app).get("/api/v1/insight-feed").query({ limit: 2, section: "weekly", cursor: first.body.data.page_info.next_cursor }).expect(200);
  assert.equal(insightQuery.offset, 2);
});

test("native filters reach canonical services and Plaid redirects stay server-owned", async () => {
  const calls = [];
  const financeService = Object.fromEntries(["listTransactions", "getSpendingSummary", "getCashFlow", "getNetWorthHistory"].map((method) => [method, async (input) => { calls.push({ method, input }); return { data: input }; }]));
  const app = api({ financeService, plaidRedirectUri: "https://money.example/plaid/oauth", plaidIosRedirectUri: "https://money.example/plaid/ios/callback", plaidSyncService: {
    createLinkToken: async (input) => { calls.push(input); return { linkToken: "link", expiration: "later" }; },
    createUpdateLinkToken: async (input) => { calls.push(input); return { linkToken: "update", expiration: "later" }; },
  } });
  await request(app).get("/api/v1/transactions?merchant=Shop&currency_code=USD&sort=cost").expect(200);
  assert.equal(calls[0].input.merchant, "Shop");
  assert.equal(calls[0].input.currencyCode, "USD");
  assert.equal(calls[0].input.sort, "cost");
  await request(app).get("/api/v1/spending?search=coffee&merchant=Shop").expect(200);
  assert.equal(calls[1].input.search, "coffee");
  assert.equal(calls[1].input.merchant, "Shop");
  await request(app).get("/api/v1/cash-flow?search=coffee&merchant=Shop").expect(200);
  assert.equal(calls[2].input.merchant, "Shop");
  await request(app).get("/api/v1/net-worth?include_components=true").expect(200);
  assert.equal(calls[3].input.includeComponents, true);
  await request(app).post("/api/v1/plaid/link-token").send({ platform: "ios", redirect_uri: "https://evil.example" }).expect(200);
  assert.equal(calls[4].redirectUri, "https://money.example/plaid/ios/callback");
  await request(app).post("/api/v1/plaid/items/item/link-token").send({ platform: "ios" }).expect(200);
  assert.equal(calls[5].redirectUri, "https://money.example/plaid/ios/callback");
  await request(app).post("/api/v1/plaid/link-token").send({ platform: "other" }).expect(400);
});
