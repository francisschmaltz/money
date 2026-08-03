import assert from "node:assert/strict";
import test from "node:test";

import { createFinanceService } from "../app/services/financeService.js";

const NOW = new Date("2026-07-26T19:00:00.000Z");
const FRESHNESS = {
  data_as_of: "2026-07-26T18:42:00.000Z",
  partial: false,
  warnings: [],
};

function usd(amountMinor) {
  return { amount_minor: amountMinor, currency: "USD" };
}

function overviewData() {
  return {
    account_count: 1,
    manual_asset_count: 0,
    net_worth: usd(18_427_000),
    cash_balance: usd(10_830_721),
    short_term_worth: usd(10_549_258),
    taxable_investments: usd(6_342_941),
    retirement_assets: usd(6_024_608),
    manual_asset_value: usd(0),
    credit_card_liabilities: usd(281_463),
    loan_liabilities: usd(1_618_327),
    assets: usd(20_326_790),
    liabilities: usd(1_899_790),
    cash: usd(4_487_780),
    portfolio: usd(12_367_549),
    spending: usd(412_684),
    income: usd(930_000),
    cash_flow: usd(517_316),
    subscriptions_monthly: usd(23_864),
  };
}

function historyPoint(timestamp, offset = 0) {
  return {
    timestamp,
    cash_balance: usd(10_000_000 + offset),
    short_term_worth: usd(9_700_000 + offset),
    retirement_assets: usd(5_800_000 + offset),
    net_worth: usd(18_000_000 + offset),
  };
}

function createDashboardHarness() {
  const calls = {
    spending: [],
    transactions: [],
    history: [],
  };
  const service = createFinanceService({
    repository: {
      async getDataFreshness() {
        return FRESHNESS;
      },
    },
    now: () => NOW,
  });

  service.getFinanceOverview = async () => ({
    data: overviewData(),
  });
  service.getSpendingSummary = async (options) => {
    calls.spending.push(options);
    return {
      data: {
        period: {
          start_on: "2026-07-01",
          end_on: "2026-07-27",
        },
        previous_period: {
          start_on: "2026-06-01",
          end_on: "2026-06-27",
        },
        total: usd(412_684),
        previous_total: usd(460_500),
        trend: {
          amount: usd(-47_816),
          percent_basis_points: -1_038,
          direction: "down",
        },
        segments: [
          {
            label: "Housing",
            amount: usd(145_000),
            share_basis_points: 3_500,
            count: 2,
          },
        ],
        series: [],
        transaction_count: 38,
        currency: "USD",
      },
    };
  };
  service.getFinanceInsights = async () => ({
    data: {
      weekly: { findings: [] },
      investments: { findings: [] },
      subscriptions: { findings: [] },
    },
  });
  service.listTransactions = async (options) => {
    calls.transactions.push(options);
    return {
      data: {
        transactions: [],
        page_info: { has_more: false, next_cursor: null },
      },
    };
  };
  service.getNetWorthHistory = async (options) => {
    calls.history.push(options);
    return {
      data: {
        currency: "USD",
        series: [historyPoint(options.startOn)],
      },
    };
  };

  return { calls, service };
}

const PERIOD_CASES = [
  {
    name: "1m",
    query: {},
    history: {
      startOn: "2026-06-26",
      endOn: "2026-07-27",
      interval: "day",
      limit: 31,
      includeComponents: true,
    },
  },
  {
    name: "1w",
    query: { period: "1w" },
    history: {
      startOn: "2026-07-19",
      endOn: "2026-07-27",
      interval: "day",
      limit: 8,
      includeComponents: true,
    },
  },
  {
    name: "1y",
    query: { period: "1y" },
    history: {
      startOn: "2025-07-26",
      endOn: "2026-07-27",
      interval: "day",
      limit: 366,
      includeComponents: true,
    },
  },
  {
    name: "all",
    query: { period: "all" },
    history: {
      startOn: "1970-01-01",
      endOn: "2026-07-27",
      interval: "month",
      limit: 366,
      includeComponents: true,
    },
  },
];

for (const periodCase of PERIOD_CASES) {
  test(`dashboard ${periodCase.name} period scopes balance history without changing other sections`, async () => {
    const { calls, service } = createDashboardHarness();

    const result = await service.getPageData("dashboard", {
      query: periodCase.query,
    });

    assert.deepEqual(calls.history, [periodCase.history]);
    assert.equal(result.dashboardPeriod.name, periodCase.name);
    assert.equal(
      result.dashboardPeriod.start_on,
      periodCase.history.startOn,
    );
    assert.equal(
      result.dashboardPeriod.end_on,
      periodCase.history.endOn,
    );
    assert.equal(typeof result.dashboardPeriod.label, "string");
    assert.ok(result.dashboardPeriod.label.length > 0);
    assert.equal(
      typeof result.dashboardPeriod.comparison_label,
      "string",
    );
    assert.ok(result.dashboardPeriod.comparison_label.length > 0);

    assert.deepEqual(calls.transactions, [{ limit: 6 }]);
    assert.equal(calls.spending.length, 1);
    assert.equal(calls.spending[0].segmentLimit, 7);
    assert.equal(
      calls.spending[0].previousStartOn,
      "2026-06-01",
    );
    assert.equal(
      calls.spending[0].previousEndOn,
      "2026-06-27",
    );

    assert.equal(result.wealthLabels.at(-1), "2026-07-26");
    assert.equal(
      result.wealthSeries.cash.at(-1),
      overviewData().cash_balance.amount_minor,
    );
    assert.equal(
      result.wealthSeries.short_term.at(-1),
      overviewData().short_term_worth.amount_minor,
    );
    assert.equal(
      result.wealthSeries.retirement.at(-1),
      overviewData().retirement_assets.amount_minor,
    );
    assert.equal(
      result.wealthSeries.net_worth.at(-1),
      overviewData().net_worth.amount_minor,
    );
  });
}

test("dashboard cold loads share one freshness read across nested models", async () => {
  let freshnessReads = 0;
  const service = createFinanceService({
    repository: {
      async getDataFreshness() {
        freshnessReads += 1;
        return FRESHNESS;
      },
      async listAccounts() {
        return [];
      },
      async getTransactionsForPeriod() {
        return [];
      },
      async getHoldings() {
        return [];
      },
      async listRecurringStreams() {
        return [];
      },
    },
    now: () => NOW,
  });
  service.getSpendingSummary = async () => ({
    data: {
      period: { start_on: "2026-07-01", end_on: "2026-07-27" },
      previous_period: { start_on: "2026-06-01", end_on: "2026-06-27" },
      total: usd(0),
      previous_total: usd(0),
      trend: {
        amount: usd(0),
        percent_basis_points: 0,
        direction: "flat",
      },
      segments: [],
      series: [],
      transaction_count: 0,
      currency: "USD",
    },
  });
  service.getFinanceInsights = async () => ({
    data: {
      weekly: { findings: [] },
      investments: { findings: [] },
      subscriptions: { findings: [] },
    },
  });
  service.listTransactions = async () => ({
    data: { transactions: [], page_info: {} },
  });
  service.getNetWorthHistory = async () => ({
    data: { currency: "USD", series: [] },
  });

  await service.getPageData("dashboard", { query: {} });

  assert.equal(freshnessReads, 1);
});

test("dashboard rejects unknown period names by falling back to one month", async () => {
  const { calls, service } = createDashboardHarness();

  const result = await service.getPageData("dashboard", {
    query: { period: "forever-ish" },
  });

  assert.equal(result.dashboardPeriod.name, "1m");
  assert.deepEqual(calls.history, [PERIOD_CASES[0].history]);
});

test("dashboard spending options produce true current and prior month-to-date periods", async () => {
  const transactionCalls = [];
  const service = createFinanceService({
    repository: {
      async getTransactionsForPeriod(_workspaceId, options) {
        transactionCalls.push(options);
        return [];
      },
      async getDataFreshness() {
        return FRESHNESS;
      },
    },
    now: () => NOW,
  });

  const result = await service.getSpendingSummary({
    segmentLimit: 7,
    previousStartOn: "2026-06-01",
    previousEndOn: "2026-06-27",
  });

  assert.deepEqual(transactionCalls, [
    {
      startOn: "2026-06-01",
      endOn: "2026-07-27",
      accountId: null,
      category: null,
    },
  ]);
  assert.deepEqual(result.data.period, {
    start_on: "2026-07-01",
    end_on: "2026-07-27",
  });
  assert.deepEqual(result.data.previous_period, {
    start_on: "2026-06-01",
    end_on: "2026-06-27",
  });
});
