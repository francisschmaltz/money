import assert from "node:assert/strict";
import test from "node:test";

import { createDemoPlanningService } from "../app/services/demoPlanningService.js";
import { createDemoFinanceService } from "../app/services/demoFinanceService.js";
import { DEMO_IDS } from "../app/demo/fixtureIds.js";

test("demo planning keeps finished vacation actuals and purpose insights", async () => {
  const service = createDemoPlanningService();
  const active = await service.listFinanceGoals();
  const all = await service.listFinanceGoals({
    status: "all",
  });

  assert.equal(
    active.data.goals.some((goal) => goal.status === "archived"),
    false,
  );
  assert.deepEqual(active.data.history_insights, []);
  assert.deepEqual(active.data.page_info, {
    returned_count: 2,
    total_count: 2,
    has_more: false,
    next_cursor: null,
  });
  const summer = all.data.goals.find(
    (goal) => goal.id === "goal_summer_vacation",
  );
  assert.equal(summer.purpose, "vacation");
  assert.equal(summer.archive_outcome, "completed");
  assert.equal(summer.planned.amount_minor, 300_000);
  assert.equal(summer.actual.amount_minor, 330_000);
  assert.equal(summer.plan_remaining.amount_minor, 0);
  assert.equal(summer.over_by.amount_minor, 30_000);
  assert.equal(summer.used_basis_points, 11_000);
  assert.deepEqual(all.data.history_insights, [
    {
      kind: "purpose_actual_variance",
      purpose: "vacation",
      completed_goal_count: 3,
      median_actual_variance_basis_points: 1_000,
      evidence_goal_ids_truncated: false,
      evidence_goal_ids: [
        "goal_beach_getaway",
        "goal_family_road_trip",
        "goal_summer_vacation",
      ],
    },
  ]);

  const overview = await service.getPlanningOverview();
  assert.equal(overview.archivedGoals.length, 3);
  assert.deepEqual(overview.obligations, [
    {
      id: "rec_wells_fargo_auto",
      name: "Wells Fargo Auto",
      account_id: "account_checking",
      account_name: "Everyday checking",
      expected_amount: {
        amount_minor: 100_000,
        currency: "USD",
      },
      cadence: "monthly",
      next_due_on: "2026-08-16",
      status: "paid",
      stream_status: "active",
      last_payment: {
        status: "paid",
        transaction_id: "txn_wells_fargo_auto",
        paid_on: "2026-07-16",
        amount: {
          amount_minor: 100_000,
          currency: "USD",
        },
      },
    },
  ]);
  assert.deepEqual(
    overview.historyInsights,
    all.data.history_insights,
  );
});

test("demo role edits immediately update obligations and Safe to Spend", async () => {
  const financeService = createDemoFinanceService();
  const planningService = createDemoPlanningService({ financeService });
  const before = await planningService.getPlanningOverview();

  await financeService.batchEditTransactions({
    transaction_ids: [DEMO_IDS.transactions.wellsFargoAuto],
    changes: { cash_flow_role: "transfer" },
  });
  const after = await planningService.getPlanningOverview();

  assert.equal(before.obligations.length, 1);
  assert.deepEqual(after.obligations, []);
  assert.equal(
    after.safeToSpend.expected_bills.amount_minor,
    before.safeToSpend.expected_bills.amount_minor - 100_000,
  );
});

test("demo goal spending follows the live cash-flow role", async () => {
  const financeService = createDemoFinanceService();
  const planningService = createDemoPlanningService({ financeService });
  const transactionId = DEMO_IDS.transactions.wholeFoods;

  const before = await planningService.getTransactionGoalSpending({
    transaction_id: transactionId,
  });
  assert.equal(before.data.eligible, true);

  await financeService.batchEditTransactions({
    transaction_ids: [transactionId],
    changes: { cash_flow_role: "obligation" },
  });
  const obligation = await planningService.getTransactionGoalSpending({
    transaction_id: transactionId,
  });
  assert.equal(obligation.data.eligible, false);
  assert.equal(
    obligation.data.ineligible_reason,
    "Only Spending outflows can be spent from a goal.",
  );
  await assert.rejects(
    planningService.spendFromFinanceGoal({
      transaction_id: transactionId,
      goal_id: "goal_emergency_fund",
      source: "cash",
      amount_minor: 100,
      expected_goal_version: 1,
      expected_transaction_version: 0,
    }),
    /Only Spending outflows can be spent from a goal/,
  );

  await financeService.batchEditTransactions({
    transaction_ids: [transactionId],
    changes: { cash_flow_role: "spending" },
  });
  const restored = await planningService.getTransactionGoalSpending({
    transaction_id: transactionId,
  });
  assert.equal(restored.data.eligible, true);
  assert.equal(restored.data.ineligible_reason, null);
});

test("demo goal reads validate and scope history pagination", async () => {
  const service = createDemoPlanningService();
  const vacation = await service.listFinanceGoals({
    status: "archived",
    purpose: "vacation",
    limit: 2,
  });
  assert.equal(vacation.data.goals.length, 2);
  assert.equal(vacation.data.page_info.total_count, 3);
  assert.match(vacation.data.page_info.next_cursor, /^goal\./);
  assert.deepEqual(
    vacation.data.history_insights.map(
      (insight) => insight.purpose,
    ),
    ["vacation"],
  );
  const next = await service.listFinanceGoals({
    limit: 2,
    cursor: vacation.data.page_info.next_cursor,
  });
  assert.equal(next.data.goals.length, 1);
  assert.equal(next.data.page_info.next_cursor, null);

  for (const input of [
    { status: "finished" },
    { purpose: "retirement" },
    { limit: 0 },
    { limit: 9 },
    { cursor: "" },
    { cursor: null },
    { cursor: "goal:-1" },
    {
      cursor: vacation.data.page_info.next_cursor,
      status: "active",
    },
    {
      cursor: vacation.data.page_info.next_cursor,
      purpose: "home",
    },
  ]) {
    await assert.rejects(
      service.listFinanceGoals(input),
      (error) =>
        error.statusCode === 400 &&
        error.code === "invalid_request",
    );
  }
});

test("budget batches add siblings together, expand parents, and preserve headroom", async () => {
  const service = createDemoPlanningService();
  const initial = await service.getBudgetStatus({
    include_available_categories: true,
  });
  const versionFor = (name, budget = initial.data) =>
    budget.available_categories.find(
      (category) => category.name === name,
    ).budget_version;

  const added = await service.setCategoryBudgets({
    lines: [
      {
        category_id: "category_car",
        amount_minor: 30_000,
        tracking_mode: "tracked",
        expected_version: versionFor("Car"),
      },
      {
        category_id: "category_rent",
        amount_minor: 180_000,
        tracking_mode: "tracked",
        expected_version: versionFor("Rent"),
      },
    ],
  });
  const home = added.budget.lines.find(
    (line) => line.category_id === "category_home",
  );
  assert.deepEqual(
    added.changed.adjusted_parent_ids,
    ["category_home"],
  );
  assert.equal(home.planned.amount_minor, 220_000);
  assert.equal(home.child_planned_total.amount_minor, 220_000);
  assert.equal(home.unallocated_planned.amount_minor, 0);

  const rent = added.budget.lines.find(
    (line) => line.category_id === "category_rent",
  );
  const reduced = await service.setCategoryBudget({
    category_id: "category_rent",
    amount_minor: 100_000,
    tracking_mode: "tracked",
    expected_version: rent.version,
  });
  const reducedHome = reduced.budget.lines.find(
    (line) => line.category_id === "category_home",
  );
  assert.equal(reducedHome.planned.amount_minor, 220_000);
  assert.equal(reducedHome.child_planned_total.amount_minor, 140_000);
  assert.equal(reducedHome.unallocated_planned.amount_minor, 80_000);

  await assert.rejects(
    service.setCategoryBudget({
      category_id: "category_home",
      amount_minor: 130_000,
      tracking_mode: "tracked",
      expected_version: reducedHome.version,
    }),
    /cannot be lower than its child allocation total/i,
  );
});

test("removed Home exposes its real version when re-added", async () => {
  const service = createDemoPlanningService();
  const initial = await service.getBudgetStatus({
    include_available_categories: true,
  });
  const homeVersion = initial.data.available_categories.find(
    (category) => category.name === "Home",
  ).budget_version;
  await service.setCategoryBudget({
    category_id: "category_home",
    amount_minor: 50_000,
    expected_version: homeVersion,
  });
  await service.clearCategoryBudget({
    category_id: "category_home",
    expected_version: 1,
    confirm_descendants: true,
  });

  const removed = await service.getBudgetStatus({
    include_available_categories: true,
  });
  const removedHome = removed.data.available_categories.find(
    (category) => category.name === "Home",
  );
  assert.equal(removedHome.budget_version, 2);
  const readded = await service.setCategoryBudgets({
    lines: [
      {
        category_id: removedHome.id,
        amount_minor: 35_000,
        tracking_mode: "tracked",
        expected_version: removedHome.budget_version,
      },
    ],
  });
  assert.equal(
    readded.budget.lines.find(
      (line) => line.category_id === removedHome.id,
    ).planned.amount_minor,
    35_000,
  );
});

test("demo goal overspending and undo never manufacture earmarks", async () => {
  const service = createDemoPlanningService();
  const created = await service.createFinanceGoal({
    name: "Unfunded vacation",
    purpose: "vacation",
    target_amount_minor: 10_000,
  });
  const goalId = created.changed.goal.id;

  const spent = await service.spendFromFinanceGoal({
    transaction_id: "txn_whole_foods",
    goal_id: goalId,
    source: "cash",
    amount_minor: 13_842,
    expected_goal_version: 1,
    expected_transaction_version: 0,
  });
  const afterSpend = await service.listFinanceGoals();
  const overPlan = afterSpend.data.goals.find(
    (goal) => goal.id === goalId,
  );
  assert.equal(overPlan.cash_earmarked.amount_minor, 0);
  assert.equal(overPlan.actual.amount_minor, 13_842);
  assert.equal(overPlan.plan_remaining.amount_minor, 0);
  assert.equal(overPlan.over_by.amount_minor, 3_842);
  assert.equal(overPlan.used_basis_points, 13_842);
  assert.equal(overPlan.unfunded_spend.amount_minor, 13_842);

  await service.reverseGoalSpend({
    transaction_id: "txn_whole_foods",
    goal_spend_id: spent.changed.goal_spends[0].id,
    expected_goal_version: 2,
    expected_transaction_version: 1,
  });
  const afterUndo = await service.listFinanceGoals();
  const restored = afterUndo.data.goals.find(
    (goal) => goal.id === goalId,
  );
  assert.equal(restored.cash_earmarked.amount_minor, 0);
  assert.equal(restored.actual.amount_minor, 0);
  assert.equal(restored.unfunded_spend.amount_minor, 0);
});

test("demo source overruns consume the other funding source", async () => {
  const overService = createDemoPlanningService();
  const overCreated = await overService.createFinanceGoal({
    name: "Cross-source vacation",
    purpose: "vacation",
    target_amount_minor: 10_000,
  });
  await overService.allocateFinanceGoal({
    goal_id: overCreated.changed.goal.id,
    source: "cash",
    amount_minor: 10_000,
    expected_version: 1,
  });
  await overService.spendFromFinanceGoal({
    transaction_id: "txn_whole_foods",
    goal_id: overCreated.changed.goal.id,
    source: "brokerage",
    amount_minor: 13_842,
    expected_goal_version: 2,
    expected_transaction_version: 0,
  });
  const beforeFinish = await overService.getSafeToSpend();
  const overGoals = await overService.listFinanceGoals();
  const overGoal = overGoals.data.goals.find(
    (goal) => goal.id === overCreated.changed.goal.id,
  );
  assert.equal(overGoal.cash_earmarked.amount_minor, 0);
  assert.equal(overGoal.brokerage_earmarked.amount_minor, 0);
  assert.equal(overGoal.unfunded_spend.amount_minor, 3_842);
  const finished = await overService.finishFinanceGoal({
    goal_id: overGoal.id,
    expected_version: 3,
  });
  assert.equal(
    finished.safe_to_spend.amount_minor,
    beforeFinish.data.safe_to_spend.amount_minor,
  );

  const partialService = createDemoPlanningService();
  const partialCreated = await partialService.createFinanceGoal({
    name: "Partially used mixed funding",
    purpose: "vacation",
    target_amount_minor: 10_000,
  });
  await partialService.allocateFinanceGoal({
    goal_id: partialCreated.changed.goal.id,
    source: "cash",
    amount_minor: 5_000,
    expected_version: 1,
  });
  await partialService.allocateFinanceGoal({
    goal_id: partialCreated.changed.goal.id,
    source: "brokerage",
    amount_minor: 5_000,
    expected_version: 2,
  });
  await partialService.spendFromFinanceGoal({
    transaction_id: "txn_whole_foods",
    goal_id: partialCreated.changed.goal.id,
    source: "brokerage",
    amount_minor: 8_000,
    expected_goal_version: 3,
    expected_transaction_version: 0,
  });
  const partialGoals = await partialService.listFinanceGoals();
  const partialGoal = partialGoals.data.goals.find(
    (goal) => goal.id === partialCreated.changed.goal.id,
  );
  assert.equal(partialGoal.cash_earmarked.amount_minor, 2_000);
  assert.equal(partialGoal.brokerage_earmarked.amount_minor, 0);
});

test("demo finished goals keep outcome and cannot be rewritten", async () => {
  const service = createDemoPlanningService();
  const finished = await service.finishFinanceGoal({
    goal_id: "goal_down_payment",
    expected_version: 1,
    outcome: "cancelled",
  });
  assert.equal(finished.changed.goal.archive_outcome, "cancelled");
  assert.deepEqual(finished.changed.goal.allocations, []);
  assert.equal(
    finished.changed.goal.recorded_allocations.find(
      (entry) => entry.source === "cash",
    ).amount_minor,
    500_000,
  );

  await assert.rejects(
    service.updateFinanceGoal({
      goal_id: "goal_down_payment",
      expected_version: 2,
      purpose: "other",
    }),
    /Archived goals cannot be edited/,
  );
});
