import test from "node:test";
import assert from "node:assert/strict";

import { createFinanceService } from "../app/services/financeService.js";

const FRESHNESS = {
  data_as_of: "2026-07-26T18:42:00.000Z",
  partial: false,
  warnings: [],
};

function usd(amountMinor) {
  return { amount_minor: amountMinor, currency: "USD" };
}

function finding({
  id,
  family,
  type,
  metrics = {},
  generatedAt = "2026-07-26T18:00:00.000Z",
}) {
  return {
    id,
    family,
    type,
    severity: "info",
    title: `${type} ${id}`,
    explanation: `${type} explanation`,
    metrics,
    rule: { key: type },
    confidence_basis_points: 9_000,
    evidence: [],
    actions: [],
    generated_at: generatedAt,
  };
}

function repositoryWith(overrides = {}) {
  return {
    async getDataFreshness() {
      return FRESHNESS;
    },
    async listInsightFindings() {
      return [];
    },
    async getLatestNarrative() {
      return null;
    },
    async getHoldings() {
      return [];
    },
    async getHoldingSnapshots() {
      return [];
    },
    async getInvestmentTransactions() {
      return [];
    },
    async listRecurringStreams() {
      return [];
    },
    ...overrides,
  };
}

test("weekly insight summaries count every stored finding while cards stay bounded", async () => {
  const findings = [
    finding({ id: "spend-1", family: "weekly", type: "spend_less" }),
    finding({ id: "habit-1", family: "weekly", type: "better_habits" }),
    finding({ id: "review-1", family: "weekly", type: "needs_review" }),
    finding({ id: "spend-2", family: "weekly", type: "spend_less" }),
    finding({ id: "spend-3", family: "weekly", type: "spend_less" }),
  ];
  let findingQuery;
  const service = createFinanceService({
    now: () => new Date("2026-07-26T19:30:00.000Z"),
    repository: repositoryWith({
      async listInsightFindings(_workspaceId, query) {
        findingQuery = query;
        return findings.slice(0, query.limit);
      },
      async getLatestNarrative() {
        assert.fail("narratives must not be queried when omitted");
      },
    }),
  });

  const result = await service.getFinanceInsights({
    section: "weekly",
    limit_per_section: 2,
    include_narratives: false,
  });

  assert.deepEqual(findingQuery, { family: "weekly", limit: 200 });
  assert.equal(result.data.weekly.findings.length, 2);
  assert.deepEqual(result.data.weekly.period, {
    current: { start_on: "2026-07-19", end_on: "2026-07-26" },
    previous: { start_on: "2026-07-12", end_on: "2026-07-19" },
  });
  assert.deepEqual(result.data.weekly.summary, {
    spend_less_count: 3,
    better_habits_count: 1,
    needs_review_count: 1,
  });
  assert.equal("narrative" in result.data.weekly, false);
});

test("investment insight summaries keep contributions and withdrawals out of estimated performance", async () => {
  const snapshots = Array.from({ length: 8 }, (_, index) => ({
    account_id: "investment-account",
    security_id: "security-vti",
    snapshot_on: `2026-07-${String(index + 1).padStart(2, "0")}`,
    value_minor: index === 7 ? 125_000 : 100_000,
    currency_code: "USD",
  }));
  const performance = finding({
    id: "performance",
    family: "investments",
    type: "performance",
    generatedAt: "2026-07-08T18:00:00.000Z",
    metrics: {
      current_value: usd(125_000),
      week_value_change: usd(25_000),
      month_value_change: usd(25_000),
      since_first_snapshot_change: usd(25_000),
      external_cash_flow: usd(15_000),
      contributions: usd(20_000),
      withdrawals: usd(5_000),
      estimated_gain: usd(10_000),
      estimated_return_basis_points: 1_000,
    },
  });
  const service = createFinanceService({
    now: () => new Date("2026-07-08T23:00:00.000Z"),
    repository: repositoryWith({
      async getDataFreshness() {
        return {
          ...FRESHNESS,
          data_as_of: "2026-07-08T22:00:00.000Z",
        };
      },
      async listInsightFindings() {
        return [performance];
      },
      async getHoldings() {
        return [
          {
            id: "holding-vti",
            account_id: "investment-account",
            security_id: "security-vti",
            name: "Vanguard Total Stock Market ETF",
            ticker_symbol: "VTI",
            security_type: "equity",
            value_minor: 125_000,
            cost_basis_minor: 115_000,
            close_price_as_of: "2026-07-08",
            currency_code: "USD",
            quantity: 1,
          },
        ];
      },
      async getHoldingSnapshots() {
        return snapshots;
      },
      async getInvestmentTransactions() {
        return [
          {
            id: "deposit",
            account_id: "investment-account",
            transaction_type: "cash",
            subtype: "deposit",
            amount_minor: 20_000,
            posted_on: "2026-07-04",
            currency_code: "USD",
          },
          {
            id: "withdrawal",
            account_id: "investment-account",
            transaction_type: "cash",
            subtype: "withdrawal",
            amount_minor: 5_000,
            posted_on: "2026-07-06",
            currency_code: "USD",
          },
        ];
      },
    }),
  });

  const result = await service.getFinanceInsights({
    section: "investments",
    include_narratives: false,
  });
  const summary = result.data.investments.summary;

  assert.deepEqual(summary.current_value, usd(125_000));
  assert.deepEqual(summary.contributions, usd(20_000));
  assert.deepEqual(summary.withdrawals, usd(5_000));
  assert.deepEqual(summary.estimated_gain, usd(10_000));
  assert.equal(summary.estimated_return_basis_points, 1_000);
  assert.deepEqual(summary.one_week_change, usd(25_000));
  assert.deepEqual(summary.one_month_change, usd(25_000));
  assert.deepEqual(
    summary.since_first_snapshot_change,
    usd(25_000),
  );
});

test("subscription insight summaries exclude bills and non-USD amounts from USD totals", async () => {
  const streams = [
    recurringStream({
      id: "subscription-active",
      name: "Cloud storage",
      monthly: 6_000,
    }),
    recurringStream({
      id: "subscription-resumed",
      name: "Music",
      monthly: 2_000,
      status: "resumed",
    }),
    recurringStream({
      id: "subscription-eur",
      name: "European news",
      monthly: 7_000,
      currency: "EUR",
    }),
    recurringStream({
      id: "bill-active",
      name: "Electric bill",
      monthly: 10_000,
      type: "bill",
    }),
    recurringStream({
      id: "subscription-canceled",
      name: "Canceled video",
      monthly: 3_000,
      status: "canceled",
    }),
  ];
  const findings = [
    finding({
      id: "duplicate-1",
      family: "subscriptions",
      type: "possible_duplicate",
    }),
    finding({
      id: "duplicate-2",
      family: "subscriptions",
      type: "possible_duplicate",
    }),
    finding({
      id: "expensive-1",
      family: "subscriptions",
      type: "expensive",
    }),
    finding({
      id: "increase-1",
      family: "subscriptions",
      type: "price_increase",
    }),
  ];
  const service = createFinanceService({
    repository: repositoryWith({
      async listInsightFindings() {
        return findings;
      },
      async listRecurringStreams() {
        return streams;
      },
    }),
  });

  const result = await service.getFinanceInsights({
    section: "subscriptions",
    include_narratives: false,
  });

  assert.deepEqual(result.data.subscriptions.summary, {
    active_count: 3,
    monthly_equivalent: usd(8_000),
    annual_equivalent: usd(96_000),
    duplicate_count: 2,
    expensive_count: 1,
    price_increase_count: 1,
  });
});

function recurringStream({
  id,
  name,
  monthly,
  currency = "USD",
  type = "subscription",
  status = "active",
}) {
  return {
    id,
    display_name: name,
    service_family: name.toLowerCase().replaceAll(" ", "-"),
    stream_type: type,
    cadence: "monthly",
    expected_amount_minor: monthly,
    min_amount_minor: monthly,
    max_amount_minor: monthly,
    monthly_equivalent_minor: monthly,
    currency_code: currency,
    next_expected_on: "2026-08-01",
    confidence_basis_points: 9_000,
    status,
    duplicate_state: "unknown",
    account_id: "checking",
    account_name: "Checking",
  };
}
