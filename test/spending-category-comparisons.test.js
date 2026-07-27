import assert from "node:assert/strict";
import test from "node:test";

import { buildSpendingSummary } from "../app/services/analytics.js";
import { createFinanceService } from "../app/services/financeService.js";

const CURRENT = {
  start_on: "2026-07-01",
  end_on: "2026-07-27",
};
const PREVIOUS = {
  start_on: "2026-06-01",
  end_on: "2026-06-27",
};
const FRESHNESS = {
  data_as_of: "2026-07-26T18:42:00.000Z",
  partial: false,
  warnings: [],
};

function usd(amountMinor) {
  return { amount_minor: amountMinor, currency: "USD" };
}

function transaction(id, postedOn, amountMinor, category) {
  return {
    id,
    posted_on: postedOn,
    amount_minor: amountMinor,
    currency_code: "USD",
    category_primary: category,
    category_detailed: category,
    merchant_name: category,
    account_id: "checking",
    account_name: "Checking",
    pending: false,
    excluded_from_spending: false,
  };
}

const TRANSACTIONS = [
  transaction("dining-current", "2026-07-10", -12_000, "Dining"),
  transaction("dining-previous", "2026-06-10", -10_000, "Dining"),
  transaction("shopping-current", "2026-07-11", -8_000, "Shopping"),
  transaction("shopping-previous", "2026-06-11", -10_000, "Shopping"),
  transaction("housing-current", "2026-07-12", -5_000, "Housing"),
  transaction("housing-previous", "2026-06-12", -5_000, "Housing"),
  transaction("travel-current", "2026-07-13", -3_000, "Travel"),
];

function summary() {
  return buildSpendingSummary({
    transactions: TRANSACTIONS,
    currentPeriod: CURRENT,
    previousPeriod: PREVIOUS,
    groupBy: "category",
    currency: "USD",
  });
}

test("category segments include deterministic MoM comparisons", () => {
  const segments = new Map(
    summary().segments.map((segment) => [segment.label, segment]),
  );

  assert.deepEqual(segments.get("Dining"), {
    label: "Dining",
    amount: usd(12_000),
    previous_amount: usd(10_000),
    count: 1,
    share_basis_points: 4_286,
    trend: {
      amount: usd(2_000),
      percent_basis_points: 2_000,
      direction: "up",
    },
  });
  assert.deepEqual(segments.get("Shopping").trend, {
    amount: usd(-2_000),
    percent_basis_points: -2_000,
    direction: "down",
  });
  assert.deepEqual(segments.get("Housing").trend, {
    amount: usd(0),
    percent_basis_points: 0,
    direction: "flat",
  });
  assert.deepEqual(segments.get("Travel").trend, {
    amount: usd(3_000),
    percent_basis_points: null,
    direction: "up",
  });
  assert.deepEqual(segments.get("Travel").previous_amount, usd(0));
});

test("dashboard category mapping exposes display-ready MoM fields", async () => {
  const spending = summary();
  const service = createFinanceService({
    repository: {
      async getDataFreshness() {
        return FRESHNESS;
      },
    },
    now: () => new Date("2026-07-26T19:00:00.000Z"),
  });

  service.getFinanceOverview = async () => ({
    data: {
      account_count: 1,
      manual_asset_count: 0,
      net_worth: usd(100_000),
      cash_balance: usd(90_000),
      short_term_worth: usd(85_000),
      taxable_investments: usd(0),
      retirement_assets: usd(10_000),
      manual_asset_value: usd(0),
      credit_card_liabilities: usd(5_000),
      loan_liabilities: usd(0),
      assets: usd(100_000),
      liabilities: usd(5_000),
      cash: usd(90_000),
      portfolio: usd(10_000),
      spending: usd(28_000),
      income: usd(0),
      cash_flow: usd(-28_000),
      subscriptions_monthly: usd(0),
    },
  });
  service.getSpendingSummary = async () => ({ data: spending });
  service.getFinanceInsights = async () => ({
    data: {
      weekly: { findings: [] },
      investments: { findings: [] },
      subscriptions: { findings: [] },
    },
  });
  service.listTransactions = async () => ({
    data: {
      transactions: [],
      page_info: { has_more: false, next_cursor: null },
    },
  });
  service.getNetWorthHistory = async () => ({
    data: {
      currency: "USD",
      series: [
        {
          timestamp: "2026-06-26",
          cash_balance: usd(80_000),
          short_term_worth: usd(75_000),
          retirement_assets: usd(9_000),
          net_worth: usd(84_000),
        },
      ],
    },
  });

  const page = await service.getPageData("dashboard");
  const categories = new Map(
    page.categories.map((category) => [category.label, category]),
  );

  assert.equal(categories.get("Dining").momLabel, "+20.0% MoM");
  assert.equal(categories.get("Dining").momBasisPoints, 2_000);
  assert.equal(categories.get("Dining").momDirection, "up");
  assert.deepEqual(categories.get("Dining").previousAmount, usd(10_000));
  assert.equal(categories.get("Shopping").momLabel, "-20.0% MoM");
  assert.equal(categories.get("Housing").momLabel, "0.0% MoM");
  assert.equal(categories.get("Travel").momLabel, "New this month");
});
