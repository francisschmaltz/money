import assert from "node:assert/strict";
import test from "node:test";

import {
  DASHBOARD_READ_MODEL_PERIODS,
  MAX_STABLE_READ_MODEL_KEYS_PER_WORKSPACE,
  PRODUCTION_READ_MODEL_CACHE_NAMESPACE,
  READ_MODEL_SLOTS,
  SHARED_READ_MODELS,
  readModelCacheKey,
  readModelCacheNamespace,
  resolvePageReadModelPolicy,
  resolveSharedReadModelPolicy,
  stableReadModelSlots,
} from "../app/cache/readModelPolicy.js";

const PRODUCTION = { nodeEnvironment: "production" };

test("production keys use the fixed versioned namespace", () => {
  assert.equal(
    PRODUCTION_READ_MODEL_CACHE_NAMESPACE,
    "money:production:v1",
  );
  assert.equal(
    readModelCacheNamespace("production"),
    PRODUCTION_READ_MODEL_CACHE_NAMESPACE,
  );
  assert.equal(readModelCacheNamespace("test"), "money:test:v1");
  assert.equal(
    readModelCacheKey({
      workspaceId: "shared",
      slot: READ_MODEL_SLOTS.SAFE_TO_SPEND_CURRENT,
      ...PRODUCTION,
    }),
    "money:production:v1:workspace:shared:planning:safe-to-spend:current",
  );
});

test("the allowlist stays within the per-workspace key budget", () => {
  const slots = stableReadModelSlots();
  assert.ok(slots.length <= MAX_STABLE_READ_MODEL_KEYS_PER_WORKSPACE);
  assert.equal(new Set(slots).size, slots.length);
  assert.equal(slots.length, Object.keys(READ_MODEL_SLOTS).length);
  // At a rollover, 12-hour TTLs can briefly retain yesterday's four
  // dashboard ranges and the prior transaction month alongside current keys.
  assert.ok(
    slots.length + DASHBOARD_READ_MODEL_PERIODS.length + 1 <=
      MAX_STABLE_READ_MODEL_KEYS_PER_WORKSPACE,
  );
});

test("dashboard exposes exactly four stable period keys", () => {
  assert.deepEqual(DASHBOARD_READ_MODEL_PERIODS, [
    "1w",
    "1m",
    "1y",
    "all",
  ]);
  const defaultPolicy = resolvePageReadModelPolicy({
    page: "/",
    workspaceId: "shared",
    ...PRODUCTION,
  });
  assert.equal(defaultPolicy.eligible, true);
  assert.equal(defaultPolicy.slot, READ_MODEL_SLOTS.DASHBOARD_1M);

  const keys = DASHBOARD_READ_MODEL_PERIODS.map((period) =>
    resolvePageReadModelPolicy({
      page: "dashboard",
      query: { period },
      workspaceId: "shared",
      ...PRODUCTION,
    }).key,
  );
  assert.equal(new Set(keys).size, 4);

  const presentationOnly = resolvePageReadModelPolicy({
    page: "dashboard",
    query: { period: "1m", metric: "net_worth" },
    workspaceId: "shared",
    ...PRODUCTION,
  });
  assert.equal(presentationOnly.key, defaultPolicy.key);
});

test("rolling page keys include their bounded date or month window", () => {
  const now = new Date("2026-08-03T12:00:00.000Z");
  const dashboard = resolvePageReadModelPolicy({
    page: "dashboard",
    query: { period: "1m" },
    now,
    ...PRODUCTION,
  });
  const transactions = resolvePageReadModelPolicy({
    page: "transactions",
    now,
    ...PRODUCTION,
  });

  assert.match(
    dashboard.key,
    /:range:2026-07-04:2026-08-04$/,
  );
  assert.match(transactions.key, /:month:2026-08$/);
  assert.notEqual(
    dashboard.key,
    resolvePageReadModelPolicy({
      page: "dashboard",
      query: { period: "1m" },
      now: new Date("2026-08-04T12:00:00.000Z"),
      ...PRODUCTION,
    }).key,
  );
});

test("dashboard rejects unbounded periods, metrics, and query fields", () => {
  for (const query of [
    { period: "forever" },
    { metric: "everything" },
    { account: "checking" },
  ]) {
    assert.equal(
      resolvePageReadModelPolicy({
        page: "dashboard",
        query,
        ...PRODUCTION,
      }).eligible,
      false,
    );
  }
});

test("page policies reject non-canonical query whitespace", () => {
  for (const [page, query] of [
    ["dashboard", { period: " 1w " }],
    ["transactions", { account: " " }],
    ["transactions", { category: " Dining " }],
    ["transactions", { merchant: " " }],
  ]) {
    const policy = resolvePageReadModelPolicy({
      page,
      query,
      ...PRODUCTION,
    });
    assert.equal(policy.eligible, false);
    assert.equal(policy.reason, "invalid_query");
    assert.equal(policy.key, null);
  }
});

test("plan reuses one overview key for view and edit presentation", () => {
  const view = resolvePageReadModelPolicy({
    page: "/plan",
    query: {},
    ...PRODUCTION,
  });
  const edit = resolvePageReadModelPolicy({
    page: "plan",
    query: { edit_budget: "1" },
    ...PRODUCTION,
  });
  assert.equal(view.eligible, true);
  assert.equal(view.slot, READ_MODEL_SLOTS.PLAN_OVERVIEW_CURRENT);
  assert.equal(edit.key, view.key);

  for (const slot of [
    READ_MODEL_SLOTS.PLAN_OVERVIEW_CURRENT,
    READ_MODEL_SLOTS.PLAN_BUDGET_CURRENT,
    READ_MODEL_SLOTS.PLAN_BUDGET_PREVIOUS,
    READ_MODEL_SLOTS.SAFE_TO_SPEND_CURRENT,
  ]) {
    assert.match(
      readModelCacheKey({ workspaceId: "shared", slot, ...PRODUCTION }),
      /^money:production:v1:workspace:shared:/,
    );
  }
});

test("transactions caches only the canonical current-month base", () => {
  const canonical = resolvePageReadModelPolicy({
    page: "/transactions",
    query: {},
    ...PRODUCTION,
  });
  const explicitDefaults = resolvePageReadModelPolicy({
    page: "transactions",
    query: {
      account: "",
      analytics_group: "category",
      category: "",
      merchant: "",
      period: "month",
      q: "",
      sort: "date",
    },
    ...PRODUCTION,
  });
  assert.equal(canonical.eligible, true);
  assert.equal(
    canonical.slot,
    READ_MODEL_SLOTS.TRANSACTIONS_CURRENT_MONTH_BASE,
  );
  assert.equal(explicitDefaults.key, canonical.key);
});

test("transactions rejects searches, filters, custom periods, sort, and cursors", () => {
  const cases = [
    [{ q: "coffee" }, "transactions_search"],
    [{ account: "checking" }, "transactions_filter"],
    [{ category: "Dining" }, "transactions_filter"],
    [{ category_id: "category-dining" }, "transactions_filter"],
    [{ merchant: "Cafe" }, "transactions_filter"],
    [
      { start: "2026-07-01", end: "2026-08-01" },
      "transactions_custom_period",
    ],
    [{ period: "30" }, "transactions_nondefault_period"],
    [{ sort: "cost" }, "transactions_nondefault_sort"],
    [{ cursor: "next-page" }, "transactions_cursor"],
    [
      { analytics_group: "merchant" },
      "transactions_nondefault_analytics",
    ],
    [{ mystery: "value" }, "transactions_query_not_allowlisted"],
  ];
  for (const [query, reason] of cases) {
    const policy = resolvePageReadModelPolicy({
      page: "transactions",
      query,
      ...PRODUCTION,
    });
    assert.equal(policy.eligible, false);
    assert.equal(policy.reason, reason);
    assert.equal(policy.key, null);
  }
});

test("transaction deep links reuse the base and keep detail uncached", () => {
  const base = resolvePageReadModelPolicy({
    page: "transactions",
    ...PRODUCTION,
  });
  const deepLink = resolvePageReadModelPolicy({
    page: "transactions",
    query: { transaction: "txn_123" },
    ...PRODUCTION,
  });
  assert.equal(deepLink.eligible, true);
  assert.equal(deepLink.key, base.key);
  assert.deepEqual(deepLink.overlay, {
    cacheable: false,
    kind: "transaction-detail",
    transactionId: "txn_123",
  });

  const filteredDeepLink = resolvePageReadModelPolicy({
    page: "transactions",
    query: { transaction: "txn_123", category: "Dining" },
    ...PRODUCTION,
  });
  assert.equal(filteredDeepLink.eligible, false);
  assert.equal(filteredDeepLink.reason, "transactions_filter");
});

test("shared reads are allowlisted and scoped by workspace", () => {
  const reads = Object.keys(SHARED_READ_MODELS);
  const sharedKeys = reads.map((read) => {
    const policy = resolveSharedReadModelPolicy({
      read,
      workspaceId: "shared",
      ...PRODUCTION,
    });
    assert.equal(policy.eligible, true);
    return policy.key;
  });
  assert.equal(new Set(sharedKeys).size, reads.length);

  const otherWorkspace = resolveSharedReadModelPolicy({
    read: "accounts",
    workspaceId: "household-2",
    ...PRODUCTION,
  });
  assert.notEqual(
    otherWorkspace.key,
    resolveSharedReadModelPolicy({
      read: "accounts",
      workspaceId: "shared",
      ...PRODUCTION,
    }).key,
  );
  assert.equal(
    resolveSharedReadModelPolicy({
      read: "arbitrarySql",
      ...PRODUCTION,
    }).reason,
    "unsupported_shared_read",
  );
  assert.equal(
    resolveSharedReadModelPolicy({
      read: "toString",
      ...PRODUCTION,
    }).reason,
    "unsupported_shared_read",
  );
});

test("repeated parameters and invalid identifiers fail closed", () => {
  const repeated = new URLSearchParams();
  repeated.append("period", "month");
  repeated.append("period", "30");
  assert.equal(
    resolvePageReadModelPolicy({
      page: "transactions",
      query: repeated,
      ...PRODUCTION,
    }).reason,
    "invalid_query",
  );
  assert.equal(
    resolvePageReadModelPolicy({
      page: "transactions",
      query: { transaction: "bad transaction id" },
      ...PRODUCTION,
    }).reason,
    "invalid_transaction",
  );
  assert.equal(
    resolvePageReadModelPolicy({
      page: "dashboard",
      workspaceId: "bad/workspace",
      ...PRODUCTION,
    }).reason,
    "invalid_workspace",
  );
  assert.equal(
    resolvePageReadModelPolicy({
      page: "dashboard",
      query: new Map(),
      ...PRODUCTION,
    }).reason,
    "invalid_query",
  );
});
