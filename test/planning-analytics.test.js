import assert from "node:assert/strict";
import test from "node:test";

import {
  buildArchivedGoalSnapshot,
  buildBudgetStatus,
  buildGoalHistoryInsights,
  buildPlanningSnapshot,
  expandTransactionsWithSplits,
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

test("goal spending releases current earmarks while preserving funded progress", () => {
  const snapshot = buildPlanningSnapshot({
    accounts: [
      account("checking", "cash", 100_000),
      account("brokerage", "taxable_investment", 50_000),
    ],
    goals: [
      {
        ...goal("trip", 20_000, 30_000, 80_000),
        spending: [
          { source: "cash", amount_minor: 10_000 },
          { source: "brokerage", amount_minor: 5_000 },
        ],
      },
    ],
  });

  assert.equal(snapshot.cash_goal_earmarks.amount_minor, 20_000);
  assert.equal(snapshot.safe_to_spend.amount_minor, 80_000);
  assert.equal(snapshot.goals[0].spent.amount_minor, 15_000);
  assert.equal(snapshot.goals[0].funded.amount_minor, 65_000);
  assert.equal(snapshot.goals[0].shortfall.amount_minor, 15_000);
});

test("goal usage stays nonnegative and uncapped when spending exceeds both funding and plan", () => {
  const snapshot = buildPlanningSnapshot({
    accounts: [account("checking", "cash", 100_000)],
    goals: [
      {
        id: "vacation",
        name: "Vacation",
        purpose: "vacation",
        status: "active",
        target_amount_minor: 10_000,
        currency_code: "USD",
        allocations: [
          { source: "cash", amount_minor: 0 },
          { source: "brokerage", amount_minor: 0 },
        ],
        recorded_allocations: [
          { source: "cash", amount_minor: 8_000 },
        ],
        spending: [
          { source: "cash", amount_minor: 11_000 },
        ],
      },
    ],
  });
  const vacation = snapshot.goals[0];

  assert.equal(vacation.planned.amount_minor, 10_000);
  assert.equal(vacation.actual.amount_minor, 11_000);
  assert.equal(vacation.plan_remaining.amount_minor, 0);
  assert.equal(vacation.over_by.amount_minor, 1_000);
  assert.equal(vacation.unfunded_spend.amount_minor, 3_000);
  assert.equal(vacation.used_basis_points, 11_000);
  assert.equal(vacation.cash_earmarked.amount_minor, 0);
});

test("source overruns spill across funding without inventing unused money", () => {
  const snapshot = buildPlanningSnapshot({
    accounts: [account("checking", "cash", 20_000)],
    goals: [
      {
        id: "cross-source-over",
        name: "Cross-source over",
        status: "active",
        target_amount_minor: 10_000,
        currency_code: "USD",
        allocations: [
          { source: "cash", amount_minor: 10_000 },
          { source: "brokerage", amount_minor: 0 },
        ],
        recorded_allocations: [
          { source: "cash", amount_minor: 10_000 },
          { source: "brokerage", amount_minor: 0 },
        ],
        spending: [
          { source: "brokerage", amount_minor: 11_000 },
        ],
      },
      {
        id: "cross-source-partial",
        name: "Cross-source partial",
        status: "active",
        target_amount_minor: 10_000,
        currency_code: "USD",
        allocations: [
          { source: "cash", amount_minor: 5_000 },
          { source: "brokerage", amount_minor: 5_000 },
        ],
        recorded_allocations: [
          { source: "cash", amount_minor: 5_000 },
          { source: "brokerage", amount_minor: 5_000 },
        ],
        spending: [
          { source: "brokerage", amount_minor: 8_000 },
        ],
      },
    ],
  });
  const over = snapshot.goals.find(
    (goal) => goal.id === "cross-source-over",
  );
  const partial = snapshot.goals.find(
    (goal) => goal.id === "cross-source-partial",
  );

  assert.equal(over.cash_earmarked.amount_minor, 0);
  assert.equal(over.brokerage_earmarked.amount_minor, 0);
  assert.equal(over.unfunded_spend.amount_minor, 1_000);
  assert.equal(partial.cash_earmarked.amount_minor, 2_000);
  assert.equal(partial.brokerage_earmarked.amount_minor, 0);
  assert.equal(partial.unfunded_spend.amount_minor, 0);

  const archived = buildArchivedGoalSnapshot({
    ...over,
    status: "archived",
  });
  assert.equal(archived.unused_cash_funding.amount_minor, 0);
  assert.equal(archived.unused_brokerage_funding.amount_minor, 0);
  assert.equal(archived.unused_funding.amount_minor, 0);
});

test("archived goals use recorded history instead of today's brokerage value", () => {
  const archived = buildArchivedGoalSnapshot(
    {
      id: "trip",
      name: "Trip",
      purpose: "vacation",
      status: "archived",
      archive_outcome: "completed",
      archived_at: "2026-07-27T12:00:00.000Z",
      target_amount_minor: 100_000,
      currency_code: "USD",
      allocations: [
        { source: "brokerage", amount_minor: 5_000 },
      ],
      recorded_allocations: [
        { source: "brokerage", amount_minor: 100_000 },
      ],
      spending: [
        { source: "brokerage", amount_minor: 95_000 },
      ],
    },
    { currency: "USD" },
  );

  assert.equal(archived.status, "archived");
  assert.deepEqual(archived.allocations, []);
  assert.equal(archived.brokerage_earmarked_minor, 0);
  assert.equal(archived.brokerage_earmarked.amount_minor, 0);
  assert.equal(archived.brokerage_backed.amount_minor, 0);
  assert.equal(
    archived.recorded_brokerage_funding.amount_minor,
    100_000,
  );
  assert.equal(archived.unused_brokerage_funding.amount_minor, 5_000);
  assert.equal(archived.planned.amount_minor, 100_000);
  assert.equal(archived.actual.amount_minor, 95_000);
  assert.equal(archived.plan_remaining.amount_minor, 5_000);
  assert.equal(archived.over_by.amount_minor, 0);
  assert.equal(archived.used_basis_points, 9_500);
});

test("goal history insights require three completed goals and remain deterministic", () => {
  const archivedGoal = (
    id,
    purpose,
    target,
    spent,
    archiveOutcome = "completed",
  ) => ({
    id,
    name: id,
    purpose,
    status: "archived",
    archive_outcome: archiveOutcome,
    target_amount_minor: target,
    currency_code: "USD",
    allocations: [],
    recorded_allocations: [
      { source: "cash", amount_minor: Math.min(target, spent) },
    ],
    spending: [{ source: "cash", amount_minor: spent }],
  });
  const insights = buildGoalHistoryInsights([
    archivedGoal("trip-c", "vacation", 10_000, 12_000),
    archivedGoal("trip-a", "vacation", 10_000, 9_000),
    archivedGoal("trip-b", "vacation", 10_000, 11_000),
    archivedGoal("cancelled", "vacation", 10_000, 50_000, "cancelled"),
    archivedGoal("house-a", "home", 10_000, 10_000),
    archivedGoal("house-b", "home", 10_000, 10_000),
    archivedGoal("empty-a", "event", 10_000, 0),
    archivedGoal("empty-b", "event", 10_000, 0),
    archivedGoal("empty-c", "event", 10_000, 0),
    archivedGoal("other-a", "other", 10_000, 20_000),
    archivedGoal("other-b", "other", 10_000, 20_000),
    archivedGoal("other-c", "other", 10_000, 20_000),
  ]);

  assert.deepEqual(insights, [
    {
      kind: "purpose_actual_variance",
      purpose: "vacation",
      completed_goal_count: 3,
      median_actual_variance_basis_points: 1_000,
      evidence_goal_ids_truncated: false,
      evidence_goal_ids: ["trip-a", "trip-b", "trip-c"],
    },
  ]);
});

test("retirement accounts never back spending or goals despite unsafe overrides", () => {
  const snapshot = buildPlanningSnapshot({
    accounts: [
      {
        id: "retirement-as-cash",
        type: "investment",
        subtype: "401k",
        balance_group: "cash",
        balance_group_override: "cash",
        current_balance_minor: 500_000,
        currency_code: "USD",
        active: true,
      },
      {
        id: "retirement-as-brokerage",
        type: "investment",
        subtype: "roth ira",
        balance_group: "taxable_investment",
        balance_group_override: "taxable_investment",
        current_balance_minor: 700_000,
        currency_code: "USD",
        active: true,
      },
    ],
    goals: [goal("future", 0, 100_000, 500_000)],
  });

  assert.equal(snapshot.liquid_cash.amount_minor, 0);
  assert.equal(snapshot.safe_to_spend.amount_minor, 0);
  assert.equal(snapshot.taxable_brokerage_value.amount_minor, 0);
  assert.equal(snapshot.goals[0].brokerage_backed.amount_minor, 0);
  assert.equal(snapshot.goals[0].brokerage_under_backed, true);
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
      { category: "Dining", amount_minor: 8_000, version: 3 },
      { category: "Groceries", amount_minor: 10_000, version: 5 },
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
  assert.equal(dining.version, 3);
  assert.equal(groceries.version, 5);
  assert.equal(dining.actual.amount_minor, 2_000);
  assert.equal(groceries.actual.amount_minor, 6_000);
  assert.equal(budget.actual_total.amount_minor, 8_000);
  assert.equal(budget.remaining_total.amount_minor, 10_000);
});

test("refunds can make net spending negative and increase actual leftover", () => {
  const budget = buildBudgetStatus({
    monthOn: "2026-07-01",
    categories: [
      {
        id: "category_shopping",
        name: "Shopping",
        path: "Shopping",
        parent_category_id: null,
      },
      {
        id: "category_income",
        name: "Income",
        path: "Income",
        parent_category_id: null,
      },
    ],
    budgetLines: [
      {
        category_id: "category_shopping",
        category: "Shopping",
        amount_minor: 5_000,
      },
    ],
    transactions: [
      {
        id: "refund",
        category_id: "category_shopping",
        category_primary: "Shopping",
        posted_on: "2026-07-05",
        amount_minor: 8_000,
        currency_code: "USD",
        pending: false,
        excluded_from_spending: false,
      },
    ],
    income: {
      average_monthly_minor: 20_000,
      actual_month_minor: 20_000,
      month_count: 4,
      category_ids: ["category_income"],
    },
  });

  assert.equal(budget.actual_total.amount_minor, -8_000);
  assert.equal(budget.actual_leftover.amount_minor, 28_000);
});

test("budget categories stay alphabetical with Other last across months", () => {
  const build = (monthOn, otherActualMinor) =>
    buildBudgetStatus({
      monthOn,
      budgetLines: [
        { category: "Other", amount_minor: 20_000, version: 8 },
        { category: "Travel", amount_minor: 30_000, version: 4 },
        { category: "Dining", amount_minor: 10_000, version: 2 },
      ],
      transactions: [
        {
          id: `${monthOn}-other`,
          posted_on: `${monthOn.slice(0, 8)}05`,
          amount_minor: -otherActualMinor,
          currency_code: "USD",
          category_primary: "Other",
          pending: false,
          excluded_from_spending: false,
        },
        {
          id: `${monthOn}-groceries`,
          posted_on: `${monthOn.slice(0, 8)}06`,
          amount_minor: -2_000,
          currency_code: "USD",
          category_primary: "Groceries",
          pending: false,
          excluded_from_spending: false,
        },
      ],
    });

  const current = build("2026-07-01", 12_500);
  const previous = build("2026-06-01", 7_500);
  const expectedOrder = ["Dining", "Groceries", "Travel", "Other"];

  assert.deepEqual(
    current.lines.map((line) => line.category),
    expectedOrder,
  );
  assert.deepEqual(
    previous.lines.map((line) => line.category),
    expectedOrder,
  );
  assert.equal(current.lines.at(-1).actual.amount_minor, 12_500);
  assert.equal(previous.lines.at(-1).actual.amount_minor, 7_500);
});

test("hierarchical budgets count roots once and carve informational children out of variance", () => {
  const budget = buildBudgetStatus({
    monthOn: "2026-07-01",
    categories: [
      {
        id: "category_transport",
        name: "Transportation",
        path: "Transportation",
        parent_category_id: null,
      },
      {
        id: "category_service",
        name: "Car service",
        path: "Transportation / Car service",
        parent_category_id: "category_transport",
      },
      {
        id: "category_gas",
        name: "Gas",
        path: "Transportation / Gas",
        parent_category_id: "category_transport",
      },
      {
        id: "category_airlines",
        name: "Airlines",
        path: "Airlines",
        parent_category_id: null,
      },
    ],
    budgetLines: [
      {
        category_id: "category_transport",
        category: "Transportation",
        amount_minor: 100_000,
        tracking_mode: "tracked",
      },
      {
        category_id: "category_service",
        category: "Transportation / Car service",
        amount_minor: 30_000,
        tracking_mode: "informational",
      },
      {
        category_id: "category_gas",
        category: "Transportation / Gas",
        amount_minor: 40_000,
        tracking_mode: "tracked",
      },
    ],
    transactions: [
      {
        id: "service",
        category_id: "category_service",
        category_primary: "Transportation / Car service",
        posted_on: "2026-07-04",
        amount_minor: -50_000,
        currency_code: "USD",
        pending: false,
        excluded_from_spending: false,
      },
      {
        id: "gas",
        category_id: "category_gas",
        category_primary: "Transportation / Gas",
        posted_on: "2026-07-05",
        amount_minor: -45_000,
        currency_code: "USD",
        pending: false,
        excluded_from_spending: false,
      },
      {
        id: "airline",
        category_id: "category_airlines",
        category_primary: "Airlines",
        posted_on: "2026-07-06",
        amount_minor: -20_000,
        currency_code: "USD",
        pending: false,
        excluded_from_spending: false,
      },
    ],
    income: {
      average_monthly_minor: 500_000,
      actual_month_minor: 480_000,
      month_count: 4,
      category_ids: [],
    },
  });

  const transportation = budget.lines.find(
    (line) => line.category_id === "category_transport",
  );
  const service = budget.lines.find(
    (line) => line.category_id === "category_service",
  );
  assert.equal(budget.planned_total.amount_minor, 100_000);
  assert.equal(budget.actual_total.amount_minor, 115_000);
  assert.equal(transportation.actual.amount_minor, 95_000);
  assert.equal(
    transportation.child_planned_total.amount_minor,
    70_000,
  );
  assert.equal(
    transportation.unallocated_planned.amount_minor,
    30_000,
  );
  assert.equal(transportation.tracked_planned.amount_minor, 70_000);
  assert.equal(transportation.tracked_actual.amount_minor, 45_000);
  assert.equal(service.remaining, null);
  assert.equal(budget.estimated_leftover.amount_minor, 400_000);
  assert.equal(budget.actual_leftover.amount_minor, 365_000);
  assert.equal(
    budget.lines.some((line) => line.category === "Airlines"),
    false,
  );
});

test("nested planned and actual totals bubble through every ancestor exactly once", () => {
  const budget = buildBudgetStatus({
    monthOn: "2026-07-01",
    categories: [
      {
        id: "home",
        name: "Home",
        path: "Home",
        parent_category_id: null,
      },
      {
        id: "utilities",
        name: "Utilities",
        path: "Home / Utilities",
        parent_category_id: "home",
      },
      {
        id: "electric",
        name: "Electric",
        path: "Home / Utilities / Electric",
        parent_category_id: "utilities",
      },
    ],
    budgetLines: [
      {
        category_id: "home",
        category: "Home",
        amount_minor: 100_000,
      },
      {
        category_id: "utilities",
        category: "Home / Utilities",
        amount_minor: 100_000,
      },
      {
        category_id: "electric",
        category: "Home / Utilities / Electric",
        amount_minor: 70_000,
      },
    ],
    transactions: [
      {
        id: "power-bill",
        category_id: "electric",
        category_primary: "Home / Utilities / Electric",
        posted_on: "2026-07-08",
        amount_minor: -25_000,
        currency_code: "USD",
        pending: false,
        excluded_from_spending: false,
      },
    ],
  });

  const byId = new Map(
    budget.lines.map((line) => [line.category_id, line]),
  );
  assert.equal(budget.planned_total.amount_minor, 100_000);
  assert.equal(budget.actual_total.amount_minor, 25_000);
  assert.equal(byId.get("home").actual.amount_minor, 25_000);
  assert.equal(byId.get("utilities").actual.amount_minor, 25_000);
  assert.equal(byId.get("electric").actual.amount_minor, 25_000);
  assert.equal(byId.get("home").direct_actual.amount_minor, 0);
  assert.equal(byId.get("utilities").direct_actual.amount_minor, 0);
  assert.equal(byId.get("electric").direct_actual.amount_minor, 25_000);
  assert.equal(
    byId.get("home").child_planned_total.amount_minor,
    100_000,
  );
  assert.equal(
    byId.get("utilities").unallocated_planned.amount_minor,
    30_000,
  );
});

test("invalidated split sets fall back to the corrected provider transaction", () => {
  const parent = {
    id: "purchase",
    posted_on: "2026-07-03",
    amount_minor: -12_000,
    currency_code: "USD",
    category_primary: "Shopping",
    pending: false,
    excluded_from_spending: false,
  };
  const staleSplits = [
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
  ];

  assert.deepEqual(
    expandTransactionsWithSplits([parent], staleSplits),
    [parent],
  );
});

test("valid split lines use their category classification", () => {
  const parent = {
    id: "purchase",
    posted_on: "2026-07-03",
    amount_minor: -12_000,
    currency_code: "USD",
    category_primary: "Shopping",
    pending: false,
    excluded_from_spending: false,
    is_fixed: false,
  };
  const expanded = expandTransactionsWithSplits(
    [parent],
    [
      {
        id: "split-1",
        transaction_id: "purchase",
        category: "Car / Auto Loan",
        amount_minor: -8_000,
        is_fixed: true,
      },
      {
        id: "split-2",
        transaction_id: "purchase",
        category: "Car / Gas",
        amount_minor: -4_000,
        is_fixed: false,
      },
    ],
  );

  assert.deepEqual(
    expanded.map((transaction) => [
      transaction.category_primary,
      transaction.is_fixed,
    ]),
    [
      ["Car / Auto Loan", true],
      ["Car / Gas", false],
    ],
  );
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
