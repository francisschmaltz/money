import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCashFlow,
  buildPortfolioSummary,
  buildSpendingSummary,
  completedWeeklyPeriods,
} from "../app/services/analytics.js";
import {
  detectInvestmentInsights,
  detectWeeklyInsights,
} from "../app/services/insightDetectors.js";
import { safeJobError } from "../app/db/jobQueue.js";
import { validateNarrative } from "../app/services/narrativeService.js";
import {
  enqueueNightlyFinanceJobs,
  FinanceWorker,
} from "../app/worker/financeWorker.js";
import { startFinanceWorker } from "../app/worker/index.js";

const currency = "USD";

function transaction({
  id,
  date,
  amount,
  category = "FOOD_AND_DRINK",
  merchant = "Merchant",
  excluded = false,
  fixed = false,
  pending = false,
}) {
  return {
    id,
    posted_on: date,
    amount_minor: amount,
    currency_code: currency,
    category_primary: category,
    category_detailed: category,
    merchant_name: merchant,
    normalized_merchant: merchant.toLowerCase(),
    name: merchant,
    account_id: "account_1",
    account_name: "Checking",
    excluded_from_spending: excluded,
    is_fixed: fixed,
    pending,
  };
}

test("weekly periods are complete, adjacent, and non-overlapping", () => {
  assert.deepEqual(
    completedWeeklyPeriods(new Date("2026-07-26T19:30:00Z")),
    {
      current: { start_on: "2026-07-19", end_on: "2026-07-26" },
      previous: { start_on: "2026-07-12", end_on: "2026-07-19" },
    },
  );
});

test("refunds reduce spending while payroll is income and transfers stay excluded", () => {
  const rows = [
    transaction({
      id: "purchase",
      date: "2026-07-20",
      amount: -10_000,
      category: "GENERAL_MERCHANDISE",
    }),
    transaction({
      id: "refund",
      date: "2026-07-21",
      amount: 2_000,
      category: "GENERAL_MERCHANDISE",
    }),
    transaction({
      id: "payroll",
      date: "2026-07-22",
      amount: 100_000,
      category: "INCOME",
    }),
    transaction({
      id: "transfer",
      date: "2026-07-23",
      amount: -50_000,
      category: "TRANSFER_OUT",
      excluded: true,
    }),
    transaction({
      id: "card-payment",
      date: "2026-07-24",
      amount: -25_000,
      category: "LOAN_PAYMENTS",
      excluded: true,
    }),
  ];
  const period = { start_on: "2026-07-01", end_on: "2026-08-01" };
  const spending = buildSpendingSummary({
    transactions: rows,
    currentPeriod: period,
    previousPeriod: { start_on: "2026-06-01", end_on: "2026-07-01" },
    currency,
  });
  assert.equal(spending.total.amount_minor, 8_000);
  assert.equal(spending.transaction_count, 2);
  assert.equal(spending.segments[0].amount.amount_minor, 8_000);
  assert.equal(spending.segments[0].count, 2);
  assert.equal(spending.series.length, 31);
  assert.equal(spending.series[18].value.amount_minor, 0);
  assert.equal(spending.series[19].value.amount_minor, 10_000);
  assert.equal(spending.series[20].value.amount_minor, -2_000);

  const cashFlow = buildCashFlow({
    transactions: rows,
    period,
    interval: "week",
    currency,
  });
  assert.equal(cashFlow.income.amount_minor, 100_000);
  assert.equal(cashFlow.spending.amount_minor, 8_000);
  assert.equal(cashFlow.net.amount_minor, 92_000);
});

test("weekly spend-less hits its exact boundary and excludes fixed categories", () => {
  const rows = [
    transaction({
      id: "prior-flex",
      date: "2026-07-15",
      amount: -10_000,
      category: "DINING",
    }),
    transaction({
      id: "current-flex",
      date: "2026-07-22",
      amount: -12_500,
      category: "DINING",
    }),
    transaction({
      id: "prior-rent",
      date: "2026-07-15",
      amount: -100_000,
      category: "HOUSING",
    }),
    transaction({
      id: "current-rent",
      date: "2026-07-22",
      amount: -150_000,
      category: "HOUSING",
    }),
  ];
  const findings = detectWeeklyInsights(rows, {
    asOf: new Date("2026-07-26T12:00:00Z"),
    dataAsOf: new Date("2026-07-26T10:00:00Z"),
    minimumChangeMinor: 2_500,
    minimumChangeBasisPoints: 1_500,
    fixedCategories: ["HOUSING"],
  });
  const spendLess = findings.filter(
    (finding) =>
      finding.type === "spend_less" &&
      finding.rule.key === "spend_less",
  );
  assert.equal(spendLess.length, 1);
  assert.match(spendLess[0].title, /Dining/);
  assert.equal(spendLess[0].metrics.change.amount_minor, 2_500);
  assert.deepEqual(
    spendLess[0].actions.map((action) => action.type),
    ["review", "mark_expected", "recategorize", "dismiss"],
  );
});

test("single-transaction insight review opens that transaction", () => {
  const findings = detectWeeklyInsights(
    [
      transaction({
        id: "transaction-needs-review",
        date: "2026-07-22",
        amount: -20_000,
        category: null,
        merchant: "Mystery charge",
      }),
    ],
    {
      asOf: new Date("2026-07-26T12:00:00Z"),
      baseUrl: "https://money.test",
    },
  );
  const finding = findings.find(
    (candidate) => candidate.type === "needs_review",
  );

  assert.ok(finding);
  assert.equal(finding.evidence.length, 1);
  assert.equal(
    finding.actions.find((action) => action.type === "review").web_url,
    "https://money.test/transactions?transaction=transaction-needs-review",
  );
});

test("the same insight pattern keeps its finding key across periods", () => {
  const rows = [
    transaction({
      id: "prior-dining",
      date: "2026-07-15",
      amount: -10_000,
      category: "DINING",
    }),
    transaction({
      id: "current-dining",
      date: "2026-07-22",
      amount: -15_000,
      category: "DINING",
    }),
  ];
  const first = detectWeeklyInsights(rows, {
    asOf: new Date("2026-07-26T12:00:00Z"),
  }).find(
    (finding) =>
      finding.type === "spend_less" &&
      finding.rule.key === "spend_less",
  );
  const next = detectWeeklyInsights(rows, {
    asOf: new Date("2026-07-27T12:00:00Z"),
  }).find(
    (finding) =>
      finding.type === "spend_less" &&
      finding.rule.key === "spend_less",
  );

  assert.ok(first);
  assert.ok(next);
  assert.notEqual(first.id, next.id);
  assert.equal(first.finding_key, next.finding_key);
});

test("weekly insights cover merchant increases and repeated convenience clusters", () => {
  const rows = [
    transaction({
      id: "prior-merchant",
      date: "2026-07-15",
      amount: -1_000,
      category: "DINING",
      merchant: "Quick Coffee",
    }),
    ...[1, 2, 3].map((index) =>
      transaction({
        id: `current-${index}`,
        date: `2026-07-2${index}`,
        amount: -1_250,
        category: "DINING",
        merchant: "Quick Coffee",
      }),
    ),
  ];

  const findings = detectWeeklyInsights(rows, {
    asOf: new Date("2026-07-26T12:00:00Z"),
    minimumChangeMinor: 2_500,
    minimumChangeBasisPoints: 1_500,
  });
  const rules = new Set(findings.map((finding) => finding.rule.key));

  assert.ok(rules.has("merchant_spend_increase"));
  assert.ok(rules.has("repeated_convenience_spending"));
  assert.ok(rules.has("similar_purchase_cluster"));
  for (const finding of findings.filter((candidate) =>
    [
      "merchant_spend_increase",
      "repeated_convenience_spending",
      "similar_purchase_cluster",
    ].includes(candidate.rule.key),
  )) {
    assert.ok(finding.metrics.current);
    assert.ok(finding.metrics.previous);
    assert.ok(finding.metrics.change);
    assert.equal(
      Number.isSafeInteger(finding.metrics.transaction_count_change),
      true,
    );
  }
});

test("single-security concentration starts above, not at, 25 percent", () => {
  const holdings = [25_000, 75_000].map((value, index) => ({
    id: `holding-${index}`,
    account_id: "investment",
    security_id: `security-${index}`,
    name: `Holding ${index}`,
    value_minor: value,
    cost_basis_minor: value,
    close_price_as_of: "2026-07-26",
    currency_code: "USD",
    quantity: 1,
  }));
  const findings = detectInvestmentInsights({
    holdings,
    snapshots: [],
    investmentTransactions: [],
    asOf: new Date("2026-07-26T12:00:00Z"),
    concentrationBasisPoints: 2_500,
  });
  const concentrations = findings.filter(
    (finding) => finding.type === "concentration",
  );

  assert.equal(
    concentrations.some(
      (finding) =>
        finding.metrics.allocation_basis_points === 2_500,
    ),
    false,
  );
  assert.equal(
    concentrations.some(
      (finding) =>
        finding.metrics.allocation_basis_points === 7_500,
    ),
    true,
  );
  const concentrated = concentrations.find(
    (finding) =>
      finding.metrics.allocation_basis_points === 7_500,
  );
  assert.equal(
    concentrated.actions.find((action) => action.type === "review")
      .web_url,
    "https://money.example.com/portfolio?holding=Holding%201",
  );
});

test("disabled deterministic rule families do not emit their findings", () => {
  const weeklyRows = [
    transaction({
      id: "prior",
      date: "2026-07-15",
      amount: -10_000,
      category: "DINING",
    }),
    transaction({
      id: "current",
      date: "2026-07-22",
      amount: -20_000,
      category: "DINING",
    }),
  ];
  const weekly = detectWeeklyInsights(weeklyRows, {
    asOf: new Date("2026-07-26T12:00:00Z"),
    spendLessEnabled: false,
  });
  assert.ok(!weekly.some((finding) => finding.type === "spend_less"));

  const investments = detectInvestmentInsights({
    holdings: [
      {
        id: "holding",
        security_id: "security",
        name: "Single holding",
        value_minor: 100_000,
        currency_code: "USD",
        close_price_as_of: "2026-07-26",
      },
    ],
    snapshots: [],
    investmentTransactions: [],
    asOf: new Date("2026-07-26T12:00:00Z"),
    concentrationEnabled: false,
  });
  assert.ok(
    !investments.some((finding) => finding.type === "concentration"),
  );
});

test("contributions and withdrawals never become portfolio performance", () => {
  const snapshots = [];
  for (let day = 1; day <= 8; day += 1) {
    snapshots.push({
      account_id: "investment_account",
      security_id: "security_vti",
      name: "VTI",
      ticker_symbol: "VTI",
      snapshot_on: `2026-07-${String(day).padStart(2, "0")}`,
      value_minor: day === 8 ? 120_000 : 100_000,
      currency_code: currency,
    });
  }
  const holdings = [
    {
      id: "holding_vti",
      account_id: "investment_account",
      security_id: "security_vti",
      name: "VTI",
      ticker_symbol: "VTI",
      security_type: "equity",
      value_minor: 120_000,
      cost_basis_minor: 120_000,
      close_price_as_of: "2026-07-08",
      currency_code: currency,
      quantity: 1,
    },
  ];
  const flows = [
    {
      id: "deposit",
      account_id: "investment_account",
      transaction_type: "cash",
      subtype: "deposit",
      amount_minor: 20_000,
      fees_minor: 0,
      posted_on: "2026-07-08",
      currency_code: currency,
    },
  ];
  const portfolio = buildPortfolioSummary({
    holdings,
    snapshots,
    investmentTransactions: flows,
    currency,
    now: new Date("2026-07-08T23:00:00Z"),
    investmentHistoryComplete: true,
  });
  assert.equal(portfolio.external_cash_flow.amount_minor, 20_000);
  assert.equal(portfolio.estimated_gain.amount_minor, 0);
  assert.equal(portfolio.estimated_return_basis_points, 0);

  const suppressed = buildPortfolioSummary({
    holdings,
    snapshots,
    investmentTransactions: flows,
    currency,
    now: new Date("2026-07-08T23:00:00Z"),
  });
  assert.equal(suppressed.estimated_gain, null);
  assert.equal(suppressed.estimated_return_basis_points, null);

  const findings = detectInvestmentInsights({
    holdings,
    snapshots,
    investmentTransactions: flows,
    asOf: new Date("2026-07-08T23:00:00Z"),
    dataAsOf: new Date("2026-07-08T22:00:00Z"),
    investmentHistoryComplete: true,
  });
  const performance = findings.find(
    (finding) => finding.type === "performance",
  );
  assert.equal(performance.metrics.estimated_gain.amount_minor, 0);
});

test("investment insights surface holding contribution, allocation, and membership changes", () => {
  const snapshots = [
    {
      security_id: "a",
      name: "Alpha",
      ticker_symbol: "AAA",
      snapshot_on: "2026-07-01",
      value_minor: 100_000,
      currency_code: "USD",
    },
    {
      security_id: "b",
      name: "Beta",
      ticker_symbol: "BBB",
      snapshot_on: "2026-07-01",
      value_minor: 100_000,
      currency_code: "USD",
    },
    {
      security_id: "a",
      name: "Alpha",
      ticker_symbol: "AAA",
      snapshot_on: "2026-07-08",
      value_minor: 180_000,
      currency_code: "USD",
    },
    {
      security_id: "c",
      name: "Charlie",
      ticker_symbol: "CCC",
      snapshot_on: "2026-07-08",
      value_minor: 20_000,
      currency_code: "USD",
    },
  ];
  const holdings = [
    {
      id: "holding_a",
      security_id: "a",
      name: "Alpha",
      ticker_symbol: "AAA",
      security_type: "equity",
      value_minor: 180_000,
      cost_basis_minor: 100_000,
      close_price_as_of: "2026-07-08",
      currency_code: "USD",
      quantity: 1,
    },
    {
      id: "holding_c",
      security_id: "c",
      name: "Charlie",
      ticker_symbol: "CCC",
      security_type: "equity",
      value_minor: 20_000,
      cost_basis_minor: 20_000,
      close_price_as_of: "2026-07-08",
      currency_code: "USD",
      quantity: 1,
    },
  ];
  const findings = detectInvestmentInsights({
    holdings,
    snapshots,
    investmentTransactions: [],
    asOf: new Date("2026-07-08T12:00:00Z"),
    dataAsOf: new Date("2026-07-08T11:00:00Z"),
  });
  assert.ok(
    findings.some(
      (finding) =>
        finding.type === "holding_value_contribution" &&
        finding.metrics.value_change.amount_minor > 0,
    ),
  );
  assert.ok(
    findings.some(
      (finding) =>
        finding.type === "holding_value_contribution" &&
        finding.metrics.value_change.amount_minor < 0,
    ),
  );
  assert.ok(
    findings.some((finding) => finding.type === "allocation_change"),
  );
  const membership = findings.find(
    (finding) => finding.type === "holdings_changed",
  );
  assert.equal(membership.metrics.added_count, 1);
  assert.equal(membership.metrics.removed_count, 1);
});

test("LM Studio cannot introduce finding IDs, numbers, or unknown facts", () => {
  const facts = [
    {
      id: "finding_known",
      metrics: { amount_minor: 2_500 },
      title: "Dining changed",
    },
  ];
  assert.equal(
    validateNarrative(
      {
        headline: "Dining changed by 9999",
        bullets: [],
        finding_ids: ["finding_known"],
      },
      facts,
    ),
    null,
  );
  assert.equal(
    validateNarrative(
      {
        headline: "Dining changed",
        bullets: ["Llamas caused the change."],
        finding_ids: ["finding_known"],
      },
      facts,
    ),
    null,
  );
  assert.equal(
    validateNarrative(
      {
        headline: "Dining changed",
        bullets: [],
        finding_ids: ["finding_invented"],
      },
      facts,
    ),
    null,
  );
  assert.deepEqual(
    validateNarrative(
      {
        headline: "Dining changed by 2500",
        bullets: ["Review the deterministic finding."],
        finding_ids: ["finding_known"],
      },
      facts,
    ),
    {
      headline: "Dining changed by 2500",
      bullets: ["Review the deterministic finding."],
      findingIds: ["finding_known"],
    },
  );
});

test("failed jobs persist only safe class and code", () => {
  const error = new Error(
    "postgres://money:database-password@db/money PLAID_SECRET=plaid-secret access-token",
  );
  error.name = "PlaidApiError";
  error.code = "ITEM_LOGIN_REQUIRED";
  const safe = safeJobError(error);
  assert.equal(safe, "PlaidApiError:ITEM_LOGIN_REQUIRED");
  assert.doesNotMatch(safe, /password|secret|access|postgres/i);
});

test("worker shutdown waits for the active job before returning", async () => {
  let releaseJob;
  let markStarted;
  const jobStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const blockedJob = new Promise((resolve) => {
    releaseJob = resolve;
  });
  let claimed = false;
  let completed = false;
  const worker = new FinanceWorker({
    queue: {
      async recoverStale() {},
      async claim() {
        if (claimed) return null;
        claimed = true;
        return {
          id: "job",
          type: "plaid.sync_item",
          payload: { itemId: "item" },
        };
      },
      async complete() {
        completed = true;
      },
      async fail() {
        assert.fail("job should not fail");
      },
    },
    plaidSyncService: {
      async syncItem() {
        markStarted();
        await blockedJob;
      },
    },
    recurringService: { async detectAndStore() {} },
    insightService: { async generateAll() {} },
    pollIntervalMs: 60_000,
  });

  const startPromise = worker.start();
  await jobStarted;
  await startPromise;
  let stopped = false;
  const stopPromise = worker.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  releaseJob();
  await Promise.all([startPromise, stopPromise]);
  assert.equal(completed, true);
  assert.equal(stopped, true);
});

test("insight jobs wait while a workspace still has Plaid sync work", async () => {
  const events = [];
  const worker = new FinanceWorker({
    queue: {
      async claim() {
        return {
          id: "insight-job",
          type: "finance.generate_insights",
          payload: { workspaceId: "shared" },
        };
      },
      async hasPendingPlaidSyncs(workspaceId) {
        events.push(`pending:${workspaceId}`);
        return true;
      },
      async enqueue(type, payload, options) {
        events.push({ type, payload, options });
      },
      async complete(id) {
        events.push(`complete:${id}`);
      },
      async fail() {
        assert.fail("deferred insight generation should not fail");
      },
    },
    plaidSyncService: {},
    recurringService: {},
    insightService: {
      async generateAll() {
        assert.fail("the model path must not run before syncs settle");
      },
    },
  });

  assert.equal(await worker.runOnce(), true);
  assert.equal(events[0], "pending:shared");
  assert.equal(events[2], "complete:insight-job");
  assert.deepEqual(events[1].type, "finance.generate_insights");
  assert.deepEqual(events[1].payload, { workspaceId: "shared" });
  assert.equal(events[1].options.dedupeKey, "shared");
  assert.ok(events[1].options.runAt instanceof Date);
});

test("in-process worker reuses the application runtime and leaves its pool open", async () => {
  const enqueued = [];
  let poolClosed = false;
  let ready = false;
  const pool = {
    async end() {
      poolClosed = true;
    },
  };
  const applicationRuntime = {
    pool,
    repository: {},
    secretRepository: {},
    jobQueue: {
      async recoverStale() {},
      async claim() {
        return null;
      },
      async enqueue(...args) {
        enqueued.push(args);
        return { id: "nightly-job" };
      },
    },
    plaidSyncService: {},
    planningService: {},
  };

  const workerRuntime = await startFinanceWorker(
    {
      demoMode: false,
      lmStudio: { baseUrl: "", model: "", apiKey: "" },
      mcp: { cardBaseUrl: "https://money.example" },
      worker: {
        pollIntervalMs: 60_000,
        nightlyInsightsHourUtc: 9,
      },
    },
    {
      applicationRuntime,
      onReady: () => {
        ready = true;
      },
    },
  );

  assert.equal(ready, true);
  assert.equal(enqueued.length, 1);
  await workerRuntime.close();
  assert.equal(poolClosed, false);
});

test("nightly refresh syncs active Items before recurring detection and insights", async () => {
  const events = [];
  const worker = new FinanceWorker({
    queue: {
      async claim() {
        return {
          id: "nightly-job",
          type: "finance.nightly_refresh",
          payload: { workspaceId: "shared" },
        };
      },
      async complete() {
        events.push("complete");
      },
      async fail() {
        assert.fail("nightly refresh should not fail");
      },
      async enqueue() {
        assert.fail("the nightly pipeline runs derived work inline");
      },
    },
    repository: {
      async listPlaidItems() {
        return [
          { id: "active-item", status: "active" },
          { id: "reauth-item", status: "reauth_required" },
        ];
      },
      async takeDailySnapshots() {
        events.push("snapshots");
      },
    },
    plaidSyncService: {
      async syncItem(itemId, options) {
        events.push(`sync:${itemId}:${options.enqueueDerived}`);
      },
    },
    recurringService: {
      async detectAndStore() {
        events.push("recurring");
      },
    },
    insightService: {
      async generateAll() {
        events.push("insights");
      },
    },
  });

  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(events, [
    "sync:active-item:false",
    "snapshots",
    "recurring",
    "insights",
    "complete",
  ]);
});

test("nightly scheduling enqueues one ordered refresh job", async () => {
  const calls = [];
  const runAt = new Date("2026-07-27T09:00:00.000Z");
  await enqueueNightlyFinanceJobs(
    {
      async enqueue(...args) {
        calls.push(args);
        return { id: "nightly-job" };
      },
    },
    { workspaceId: "shared", runAt, dedupeSuffix: "2026-07-27" },
  );

  assert.deepEqual(calls, [
    [
      "finance.nightly_refresh",
      { workspaceId: "shared" },
      {
        dedupeKey: "nightly:shared:2026-07-27",
        runAt,
      },
    ],
  ]);
});
