import assert from "node:assert/strict";
import test from "node:test";

import { createReadModelCache } from "../app/cache/readModelCache.js";
import {
  createCachedFinanceService,
  createCachedPlanningService,
} from "../app/cache/readModelRuntime.js";
import { createReadModelService } from "../app/cache/readModelService.js";

class FakeRedis {
  isReady = true;
  values = new Map();

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async set(key, value) {
    this.values.set(key, value);
    return "OK";
  }

  async del(key) {
    this.values.delete(key);
  }
}

function fixture() {
  let revision = "1";
  const calls = {
    pages: [],
    overlays: [],
    safe: 0,
    plan: 0,
    financeWrites: 0,
    planningWrites: 0,
    publishes: [],
    warms: [],
    revisions: 0,
    history: 0,
    budgets: [],
    overview: 0,
    recent: 0,
    accounts: 0,
    insights: 0,
    categories: 0,
  };
  const financeService = {
    async getPageData(view, request) {
      calls.pages.push({ view, query: request?.query ?? {} });
      return { view, build: calls.pages.length, selectedTransaction: null };
    },
    async getTransactionPageOverlay(transactionId) {
      calls.overlays.push(transactionId);
      return { selectedTransaction: { id: transactionId } };
    },
    async getFinanceOverview() {
      calls.overview += 1;
      return { data: { net_worth: 1 } };
    },
    async listTransactions(input) {
      calls.recent += 1;
      return { data: { transactions: [], input } };
    },
    async listAccounts() {
      calls.accounts += 1;
      return { data: { groups: [] } };
    },
    async getFinanceInsights() {
      calls.insights += 1;
      return { data: { sections: [] } };
    },
    async getNetWorthHistory(input) {
      calls.history += 1;
      return { data: { series: [], input } };
    },
    async listSpendingCategories() {
      calls.categories += 1;
      return { data: [] };
    },
    async updateTransactionNote() {
      calls.financeWrites += 1;
      return { updated: true };
    },
  };
  const planningService = {
    async getPlanningOverview() {
      calls.plan += 1;
      return { budget: { month_on: "2026-08-01" }, build: calls.plan };
    },
    async getSafeToSpend() {
      calls.safe += 1;
      return { data: { amount_minor: calls.safe } };
    },
    async getBudgetStatus({
      month_on,
      include_available_categories = false,
    }) {
      calls.budgets.push(month_on);
      return {
        data: {
          month_on,
          ...(include_available_categories
            ? { available_categories: ["Dining"] }
            : {}),
        },
      };
    },
    async executeIdempotentWrite() {
      calls.planningWrites += 1;
      return { updated: true };
    },
  };
  const cache = createReadModelCache({
    client: new FakeRedis(),
    mode: "serve",
  });
  const readModels = createReadModelService({
    cache,
    pool: {},
    financeService,
    planningService,
    planningRepository: {
      async getWorkspaceTimezone() {
        return "America/Los_Angeles";
      },
    },
    nodeEnvironment: "test",
    now: () => new Date("2026-08-03T12:00:00.000Z"),
    revisionSource: {
      async read() {
        calls.revisions += 1;
        return revision;
      },
    },
    logger() {},
  });
  const publisher = {
    async publish(reason) {
      calls.publishes.push(reason);
    },
    async queueWarm(reason) {
      calls.warms.push(reason);
    },
  };
  return {
    calls,
    financeService,
    planningService,
    readModels,
    publisher,
    setRevision(value) {
      revision = String(value);
    },
  };
}

test("canonical pages hit Redis and a revision change makes the old model unusable", async () => {
  const context = fixture();
  const request = { query: {} };
  const first = await context.readModels.getFinancePageData(
    "dashboard",
    request,
  );
  const second = await context.readModels.getFinancePageData(
    "dashboard",
    { query: {} },
  );

  assert.deepEqual(second, first);
  assert.equal(context.calls.pages.length, 1);
  assert.equal(request.readModelTimings[0].outcome, "miss");

  context.setRevision(2);
  const fresh = await context.readModels.getFinancePageData(
    "dashboard",
    { query: {} },
  );
  assert.equal(fresh.build, 2);
  assert.equal(context.calls.pages.length, 2);
});

test("transaction filters bypass while deep links reuse the base and load detail live", async () => {
  const context = fixture();
  await context.readModels.getFinancePageData("transactions", {
    query: {},
  });
  const selected = await context.readModels.getFinancePageData(
    "transactions",
    { query: { transaction: "txn_1" } },
  );
  await context.readModels.getFinancePageData("transactions", {
    query: { q: "coffee" },
  });

  assert.equal(selected.selectedTransaction.id, "txn_1");
  assert.deepEqual(context.calls.overlays, ["txn_1"]);
  assert.equal(
    context.calls.pages.filter((call) => call.view === "transactions")
      .length,
    2,
  );
  assert.deepEqual(context.calls.pages.at(-1).query, { q: "coffee" });
});

test("Plan and Safe to Spend cache independently", async () => {
  const context = fixture();
  const [firstPlan, firstSafe] = await Promise.all([
    context.readModels.getPlanningOverview(),
    context.readModels.getSafeToSpend(),
  ]);
  const [secondPlan, secondSafe] = await Promise.all([
    context.readModels.getPlanningOverview(),
    context.readModels.getSafeToSpend(),
  ]);

  assert.deepEqual(secondPlan, firstPlan);
  assert.deepEqual(secondSafe, firstSafe);
  assert.equal(context.calls.plan, 1);
  assert.equal(context.calls.safe, 1);
});

test("matching models share one initial PostgreSQL revision read per request", async () => {
  const context = fixture();
  const request = { query: {} };

  await Promise.all([
    context.readModels.getFinancePageData("dashboard", request),
    context.readModels.getSafeToSpend({}, request),
  ]);

  // One shared initial revision plus one post-build recheck per miss.
  assert.equal(context.calls.revisions, 3);
});

test("a Dashboard request retries the pair when its models observe different revisions", async () => {
  const context = fixture();
  await context.readModels.getFinancePageData("dashboard", { query: {} });
  const originalSafe =
    context.planningService.getSafeToSpend.bind(context.planningService);
  let changed = false;
  context.planningService.getSafeToSpend = async () => {
    const result = await originalSafe();
    if (!changed) {
      changed = true;
      context.setRevision(2);
    }
    return result;
  };
  const request = { query: {} };

  const [safe, dashboard] = await context.readModels.runCoherentRequest(
    request,
    () => Promise.all([
      context.readModels.getSafeToSpend({}, request),
      context.readModels.getFinancePageData("dashboard", request),
    ]),
  );

  assert.equal(dashboard.build, 2);
  assert.equal(safe.data.amount_minor, 2);
  assert.equal(context.calls.pages.length, 2);
  assert.equal(context.calls.safe, 2);
});

test("malformed budget dates bypass Redis and preserve source validation", async () => {
  const context = fixture();

  await context.readModels.getBudgetStatus({ month_on: "2026-08-99" });
  await context.readModels.getBudgetStatus({ month_on: "2026-08-99" });

  assert.deepEqual(context.calls.budgets, ["2026-08-99", "2026-08-99"]);
});

test("non-boolean expanded-budget inputs bypass without poisoning canonical budgets", async () => {
  const context = fixture();
  const expandedInput = {
    month_on: "2026-08-01",
    include_available_categories: "true",
  };

  const firstExpanded = await context.readModels.getBudgetStatus(
    expandedInput,
  );
  const secondExpanded = await context.readModels.getBudgetStatus(
    expandedInput,
  );
  const firstCanonical = await context.readModels.getBudgetStatus({
    month_on: "2026-08-01",
  });
  const secondCanonical = await context.readModels.getBudgetStatus({
    month_on: "2026-08-01",
  });

  assert.deepEqual(firstExpanded.data.available_categories, ["Dining"]);
  assert.deepEqual(secondExpanded, firstExpanded);
  assert.equal(firstCanonical.data.available_categories, undefined);
  assert.deepEqual(secondCanonical, firstCanonical);
  assert.deepEqual(context.calls.budgets, [
    "2026-08-01",
    "2026-08-01",
    "2026-08-01",
  ]);
});

test("only the exact bounded dashboard history read is shared", async () => {
  const context = fixture();
  const canonical = {
    startOn: "2026-07-04",
    endOn: "2026-08-04",
    interval: "day",
    limit: 31,
    includeComponents: true,
  };
  await context.readModels.getBoundedHistory(canonical);
  await context.readModels.getBoundedHistory(canonical);
  await context.readModels.getBoundedHistory({
    ...canonical,
    interval: "week",
  });

  assert.equal(context.calls.history, 2);
});

test("service proxies publish finance writes and only queue atomic planning writes", async () => {
  const context = fixture();
  const finance = createCachedFinanceService({
    service: context.financeService,
    readModels: context.readModels,
    publisher: context.publisher,
  });
  const planning = createCachedPlanningService({
    service: context.planningService,
    readModels: context.readModels,
    publisher: context.publisher,
  });

  await finance.updateTransactionNote({ transactionId: "txn_1" });
  await planning.executeIdempotentWrite("split_transaction", {});

  assert.deepEqual(context.calls.publishes, [
    "finance.updateTransactionNote",
  ]);
  assert.deepEqual(context.calls.warms, ["planning.write"]);
});

test("a completed warm makes every canonical read a served hit", async () => {
  const context = fixture();
  const warm = await context.readModels.warmCanonicalModels({
    reason: "acceptance",
  });
  assert.deepEqual(warm, {
    revision: "1",
    changedDuringWarm: false,
  });
  const buildCounts = () => ({
    pages: context.calls.pages.length,
    plan: context.calls.plan,
    safe: context.calls.safe,
    budgets: context.calls.budgets.length,
    overview: context.calls.overview,
    recent: context.calls.recent,
    accounts: context.calls.accounts,
    insights: context.calls.insights,
    history: context.calls.history,
    categories: context.calls.categories,
  });
  const warmedCounts = buildCounts();
  const canonicalHistory = {
    startOn: "2026-07-04",
    endOn: "2026-08-04",
    interval: "day",
    limit: 31,
    includeComponents: true,
  };
  const acquireCanonical = () => Promise.all([
    context.readModels.getFinancePageData("dashboard", { query: {} }),
    context.readModels.getPlanningOverview(),
    context.readModels.getFinancePageData("transactions", { query: {} }),
    context.readModels.getSafeToSpend(),
    context.readModels.getBudgetStatus({ month_on: "2026-08-01" }),
    context.readModels.getBudgetStatus({ month_on: "2026-07-01" }),
    context.readModels.getFinanceOverview(),
    context.readModels.getBoundedHistory(canonicalHistory),
    context.readModels.listRecentTransactions({ limit: 6 }),
    context.readModels.listAccountCatalog(),
    context.readModels.getActiveInsights(),
    context.readModels.listSpendingCategories(),
  ]);

  const first = await acquireCanonical();
  const second = await acquireCanonical();
  assert.deepEqual(second, first);
  assert.deepEqual(buildCounts(), warmedCounts);
});

test("warming abandons remaining heavy reads after a revision change", async () => {
  const context = fixture();
  const original =
    context.financeService.getPageData.bind(context.financeService);
  context.financeService.getPageData = async (...args) => {
    const result = await original(...args);
    context.setRevision(2);
    return result;
  };

  assert.deepEqual(
    await context.readModels.warmCanonicalModels({ reason: "raced" }),
    { revision: "2", changedDuringWarm: true },
  );
  assert.equal(context.calls.pages.length, 1);
  assert.equal(context.calls.plan, 0);
  assert.equal(context.calls.safe, 0);
});
