import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBudgetStatus,
  buildPlanningSnapshot,
  modelPlanningScenario,
  nextBiweeklyFridayDueOn,
  nextMonthlyDueOn,
} from "../app/services/planningAnalytics.js";

const account = (
  id,
  balanceGroup,
  currentBalanceMinor,
  currencyCode = "USD",
) => ({
  id,
  balance_group: balanceGroup,
  current_balance_minor: currentBalanceMinor,
  currency_code: currencyCode,
  active: true,
});

const goal = (id, cash, brokerage, target = 2_000) => ({
  id,
  name: id,
  status: "active",
  target_amount_minor: target,
  currency_code: "USD",
  version: 1,
  allocations: [
    { source: "cash", amount_minor: cash },
    { source: "brokerage", amount_minor: brokerage },
  ],
});

test("Safe to Spend excludes brokerage, ignores card overpayments, and may be negative", () => {
  const snapshot = buildPlanningSnapshot({
    accounts: [
      account("checking", "cash", 100_000),
      account("savings", "cash", 50_000),
      account("card", "credit_card", 20_000),
      account("overpaid-card", "credit_card", -5_000),
      account("brokerage", "taxable_investment", 900_000),
      account("foreign-cash", "cash", 80_000, "CAD"),
      account("missing", "cash", null),
    ],
    goals: [goal("roof", 140_000, 100_000, 500_000)],
  });

  assert.equal(snapshot.liquid_cash.amount_minor, 150_000);
  assert.equal(snapshot.current_card_liabilities.amount_minor, 20_000);
  assert.equal(snapshot.cash_goal_earmarks.amount_minor, 140_000);
  assert.equal(snapshot.safe_to_spend.amount_minor, -10_000);
  assert.equal(snapshot.taxable_brokerage_value.amount_minor, 900_000);
  assert.equal(snapshot.excluded_currency_count, 1);
  assert.equal(snapshot.unknown_balance_count, 1);
  assert.ok(
    snapshot.alerts.some(
      (entry) => entry.code === "safe_to_spend_negative",
    ),
  );
});

test("brokerage losses and recovery back every goal proportionally without consuming upside", () => {
  const goals = [
    goal("a", 0, 60_000, 100_000),
    goal("b", 0, 60_000, 100_000),
  ];
  const loss = buildPlanningSnapshot({
    accounts: [account("brokerage", "taxable_investment", 90_000)],
    goals,
  });
  assert.deepEqual(
    loss.goals.map((entry) => entry.brokerage_backed.amount_minor),
    [45_000, 45_000],
  );
  assert.equal(loss.brokerage_backing_basis_points, 7_500);

  const recovery = buildPlanningSnapshot({
    accounts: [account("brokerage", "taxable_investment", 150_000)],
    goals,
  });
  assert.deepEqual(
    recovery.goals.map(
      (entry) => entry.brokerage_backed.amount_minor,
    ),
    [60_000, 60_000],
  );
  assert.equal(
    recovery.brokerage_unallocated_value.amount_minor,
    30_000,
  );
});

test("monthly schedules clamp to month end and biweekly schedules preserve Friday parity", () => {
  assert.equal(nextMonthlyDueOn("2027-01-31", 31), "2027-02-28");
  assert.equal(nextMonthlyDueOn("2028-01-31", 31), "2028-02-29");
  assert.equal(
    nextBiweeklyFridayDueOn("2026-07-31", "2026-07-17"),
    "2026-08-14",
  );
  assert.throws(
    () => nextBiweeklyFridayDueOn("2026-07-31", "2026-07-16"),
    /Fridays/,
  );
});

test("budgets use posted splits, let refunds reduce spending, and ignore transfers", () => {
  const budget = buildBudgetStatus({
    monthOn: "2026-07-01",
    budgetLines: [
      { category: "Dining", amount_minor: 8_000 },
      { category: "Groceries", amount_minor: 10_000 },
    ],
    transactions: [
      {
        id: "purchase",
        posted_on: "2026-07-03",
        amount_minor: -10_000,
        currency_code: "USD",
        category_primary: "Dining",
        pending: false,
        excluded_from_spending: false,
      },
      {
        id: "refund",
        posted_on: "2026-07-05",
        amount_minor: 2_000,
        currency_code: "USD",
        category_primary: "Dining",
        pending: false,
        excluded_from_spending: false,
      },
      {
        id: "transfer",
        posted_on: "2026-07-06",
        amount_minor: -50_000,
        currency_code: "USD",
        category_primary: "Transfer",
        pending: false,
        excluded_from_spending: true,
      },
    ],
    splits: [
      {
        id: "split-1",
        transaction_id: "purchase",
        category: "Dining",
        amount_minor: -4_000,
      },
      {
        id: "split-2",
        transaction_id: "purchase",
        category: "Groceries",
        amount_minor: -6_000,
      },
    ],
  });
  const dining = budget.lines.find((line) => line.category === "Dining");
  const groceries = budget.lines.find(
    (line) => line.category === "Groceries",
  );
  assert.equal(dining.actual.amount_minor, 2_000);
  assert.equal(groceries.actual.amount_minor, 6_000);
  assert.equal(budget.actual_total.amount_minor, 8_000);
  assert.equal(budget.remaining_total.amount_minor, 10_000);
});

test("scenario market shocks reduce effective goal funding while Safe to Spend stays unchanged", () => {
  const snapshot = buildPlanningSnapshot({
    accounts: [
      account("cash", "cash", 50_000),
      account("brokerage", "taxable_investment", 100_000),
    ],
    goals: [goal("down-payment", 10_000, 100_000, 200_000)],
  });
  const scenario = modelPlanningScenario({
    snapshot,
    goalId: "down-payment",
    monthlyContributionMinor: 10_000,
    brokerageChangeBasisPoints: -3_000,
    asOf: new Date("2026-07-27T12:00:00Z"),
  });
  assert.equal(scenario.current_funded.amount_minor, 110_000);
  assert.equal(
    scenario.funded_after_brokerage_change.amount_minor,
    80_000,
  );
  assert.equal(
    scenario.safe_to_spend_after.amount_minor,
    snapshot.safe_to_spend.amount_minor,
  );
  assert.equal(scenario.months_to_target, 12);
});
