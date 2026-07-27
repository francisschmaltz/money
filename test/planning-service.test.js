import assert from "node:assert/strict";
import test from "node:test";

import { PlanningService } from "../app/services/planningService.js";

function fixture() {
  const goal = {
    id: "goal-house",
    name: "House",
    target_amount_minor: 5_000,
    currency_code: "USD",
    target_on: null,
    purpose: "home",
    status: "active",
    archived_at: null,
    archive_outcome: null,
    version: 1,
    allocations: [
      { source: "cash", amount_minor: 500 },
      { source: "brokerage", amount_minor: 800 },
    ],
    recorded_allocations: [
      { source: "cash", amount_minor: 500 },
      { source: "brokerage", amount_minor: 800 },
    ],
    spending: [],
    schedules: [],
  };
  const savedSplits = [];
  let splitVersion = 0;
  let goalSpendVersion = 0;
  let goalSpends = [];
  const budgetVersions = new Map();
  const budgetLines = new Map();
  const calls = {
    budgetSnapshots: 0,
    budgetWrite: null,
    planningLocks: 0,
    goalCreate: null,
    goalUpdate: null,
    goalArchive: null,
    checkingBalanceMinor: 2_000,
    cardBalanceMinor: 0,
  };
  const repository = {
    async getWorkspaceTimezone() {
      return "America/Los_Angeles";
    },
    async listGoals() {
      return [structuredClone(goal)];
    },
    async getGoal(_workspaceId, goalId) {
      return goalId === goal.id ? structuredClone(goal) : null;
    },
    async createGoal(_workspaceId, input) {
      calls.goalCreate = structuredClone(input);
      return {
        goal: {
          ...structuredClone(input),
          status: "active",
          version: 1,
          allocations: [],
          recorded_allocations: [],
          spending: [],
          schedules: [],
        },
        audit_event_id: input.audit_event_id,
      };
    },
    async updateGoal(
      _workspaceId,
      goalId,
      changes,
      expectedVersion,
    ) {
      calls.goalUpdate = structuredClone(changes);
      if (goalId !== goal.id) return null;
      if (goal.version !== expectedVersion) {
        return { conflict: true, current: structuredClone(goal) };
      }
      const before = structuredClone(goal);
      Object.assign(goal, changes);
      goal.version += 1;
      return {
        before,
        after: structuredClone(goal),
        goal: structuredClone(goal),
        audit_event_id: "audit-update",
      };
    },
    async archiveGoal(
      _workspaceId,
      goalId,
      expectedVersion,
      _actor,
      ids,
    ) {
      calls.goalArchive = structuredClone(ids);
      if (goalId !== goal.id) return null;
      if (goal.version !== expectedVersion || goal.status !== "active") {
        return { conflict: true, current: structuredClone(goal) };
      }
      const before = structuredClone(goal);
      goal.status = "archived";
      goal.archive_outcome = ids.outcome;
      goal.archived_at = "2026-07-27T12:00:00.000Z";
      goal.version += 1;
      return {
        before,
        after: structuredClone(goal),
        goal: structuredClone(goal),
        audit_event_id: ids.auditEventId,
      };
    },
    async addGoalAllocation(
      _workspaceId,
      {
        source,
        amountDeltaMinor,
        expectedVersion,
      },
    ) {
      if (goal.version !== expectedVersion) {
        return { conflict: true, current: structuredClone(goal) };
      }
      const allocation = goal.allocations.find(
        (entry) => entry.source === source,
      );
      allocation.amount_minor += amountDeltaMinor;
      const recorded = goal.recorded_allocations.find(
        (entry) => entry.source === source,
      );
      recorded.amount_minor += amountDeltaMinor;
      goal.version += 1;
      return {
        event: { id: "allocation-1" },
        goal: structuredClone(goal),
        audit_event_id: "audit-1",
      };
    },
    async withWorkspacePlanningLock(_workspaceId, operation) {
      calls.planningLocks += 1;
      return operation({ query: async () => ({ rows: [] }) });
    },
    async listResolvedBudgetLines() {
      return [...budgetLines.entries()].map(
        ([category, amount_minor]) => ({
          category,
          amount_minor,
          currency_code: "USD",
          version: budgetVersions.get(category) ?? 0,
          exact_month: false,
        }),
      );
    },
    async listBudgetCategoryVersions() {
      return [...budgetVersions.entries()].map(
        ([category, version]) => ({ category, version }),
      );
    },
    async ensureBudgetMonthSnapshot() {
      calls.budgetSnapshots += 1;
      return { created: true };
    },
    async setBudgetLine(_workspaceId, input) {
      calls.budgetWrite = structuredClone(input);
      const currentVersion =
        budgetVersions.get(input.category) ?? 0;
      const before = budgetLines.has(input.category)
        ? {
            category: input.category,
            amount_minor: budgetLines.get(input.category),
            currency_code: "USD",
            version: currentVersion,
          }
        : null;
      if (currentVersion !== input.expectedVersion) {
        return { conflict: true, current: before };
      }
      const nextVersion = currentVersion + 1;
      budgetVersions.set(input.category, nextVersion);
      budgetLines.set(input.category, input.amountMinor);
      const after = {
        category: input.category,
        amount_minor: input.amountMinor,
        currency_code: "USD",
        version: nextVersion,
      };
      return {
        before,
        after,
        line: after,
        audit_event_id: "audit-budget",
      };
    },
    async listTransactionSplits(_workspaceId, filters = {}) {
      if (
        Array.isArray(filters.transactionIds) &&
        !filters.transactionIds.includes("posted")
      ) {
        return [];
      }
      return structuredClone(savedSplits);
    },
    async getTransactionGoalSpending(_workspaceId, transactionId) {
      const transaction = transactions.get(transactionId);
      if (!transaction) return null;
      return {
        transaction: structuredClone(transaction),
        goal_spend_version: goalSpendVersion,
        goal_spends: structuredClone(goalSpends),
      };
    },
    async replaceTransactionGoalSpending(
      _workspaceId,
      transactionId,
      lines,
      expectedTransactionVersion,
      expectedGoalVersions,
    ) {
      if (goalSpendVersion !== expectedTransactionVersion) {
        return {
          conflict: true,
          current: {
            goal_spend_version: goalSpendVersion,
            goal_spends: structuredClone(goalSpends),
          },
        };
      }
      if (
        Object.hasOwn(expectedGoalVersions, goal.id) &&
        goal.version !== expectedGoalVersions[goal.id]
      ) {
        return { conflict: true, current: structuredClone(goal) };
      }
      const before = structuredClone(goalSpends);
      for (const source of ["cash", "brokerage"]) {
        const previous = before
          .filter(
            (line) =>
              line.goal_id === goal.id && line.source === source,
          )
          .reduce((sum, line) => sum + line.amount_minor, 0);
        const next = lines
          .filter(
            (line) =>
              line.goal_id === goal.id && line.source === source,
          )
          .reduce((sum, line) => sum + line.amount_minor, 0);
        const delta = next - previous;
        if (delta === 0) continue;
        const allocation =
          goal.allocations.find((entry) => entry.source === source) ??
          { source, amount_minor: 0 };
        if (!goal.allocations.includes(allocation)) {
          goal.allocations.push(allocation);
        }
        const spending =
          goal.spending.find((entry) => entry.source === source) ??
          { source, amount_minor: 0 };
        if (!goal.spending.includes(spending)) {
          goal.spending.push(spending);
        }
        spending.amount_minor += delta;
        const recordedMinor = Number(
          goal.recorded_allocations.find(
            (entry) => entry.source === source,
          )?.amount_minor ?? 0,
        );
        allocation.amount_minor = Math.max(
          0,
          recordedMinor - spending.amount_minor,
        );
      }
      goal.spending = goal.spending.filter(
        (entry) => entry.amount_minor > 0,
      );
      goalSpends = structuredClone(lines);
      goalSpendVersion += 1;
      goal.version += 1;
      transactions.get(transactionId).goal_spend_version =
        goalSpendVersion;
      return {
        before,
        after: structuredClone(goalSpends),
        goal_spends: structuredClone(goalSpends),
        goal_spend_version: goalSpendVersion,
        goals: [
          {
            id: goal.id,
            version: goal.version,
            status: goal.status,
          },
        ],
        audit_event_id: "audit-goal-spend",
      };
    },
    async listGoalScheduleRuns() {
      return [];
    },
    async listAuditEvents() {
      return [];
    },
    async replaceTransactionSplits(
      _workspaceId,
      transactionId,
      lines,
      expectedVersion,
    ) {
      if (splitVersion !== expectedVersion) {
        return {
          conflict: true,
          current: {
            split_version: splitVersion,
            splits: structuredClone(savedSplits),
          },
        };
      }
      const before = structuredClone(savedSplits);
      splitVersion += 1;
      savedSplits.splice(0, savedSplits.length, ...structuredClone(lines));
      transactions.get(transactionId).split_version = splitVersion;
      return {
        before,
        after: structuredClone(savedSplits),
        splits: structuredClone(savedSplits),
        split_version: splitVersion,
        audit_event_id: "audit-split",
      };
    },
  };
  const transactions = new Map([
    [
      "posted",
      {
        id: "posted",
        posted_on: "2026-07-20",
        pending: false,
        amount_minor: -1_000,
        currency_code: "USD",
        category_primary: "Dining",
        excluded_from_spending: false,
        split_version: 0,
        goal_spend_version: 0,
      },
    ],
    [
      "pending",
      {
        id: "pending",
        posted_on: "2026-07-20",
        pending: true,
        amount_minor: -1_000,
        currency_code: "USD",
        category_primary: "Dining",
        excluded_from_spending: false,
        split_version: 0,
        goal_spend_version: 0,
      },
    ],
  ]);
  const financeRepository = {
    async listAccounts() {
      return [
        {
          id: "checking",
          balance_group: "cash",
          current_balance_minor: calls.checkingBalanceMinor,
          currency_code: "USD",
          active: true,
        },
        {
          id: "brokerage",
          balance_group: "taxable_investment",
          current_balance_minor: 1_000,
          currency_code: "USD",
          active: true,
        },
        {
          id: "card",
          balance_group: "credit_card",
          current_balance_minor: calls.cardBalanceMinor,
          currency_code: "USD",
          active: true,
        },
      ];
    },
    async getDataFreshness() {
      return {
        data_as_of: "2026-07-27T12:00:00.000Z",
        partial: false,
      };
    },
    async getTransactionsForPeriod() {
      return [];
    },
    async getTransaction(_workspaceId, id) {
      return structuredClone(transactions.get(id) ?? null);
    },
  };
  return {
    service: new PlanningService({
      repository,
      financeRepository,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    }),
    goal,
    savedSplits,
    calls,
    transactions,
  };
}

test("brokerage allocations cannot consume value already earmarked to other goals", async () => {
  const { service, goal } = fixture();
  await assert.rejects(
    service.allocateFinanceGoal({
      goal_id: goal.id,
      source: "brokerage",
      amount_minor: 201,
      expected_version: 1,
      idempotency_key: "allocation-attempt-1",
    }),
    /unallocated taxable brokerage/,
  );

  const result = await service.allocateFinanceGoal({
    goal_id: goal.id,
    source: "cash",
    amount_minor: 1_000,
    expected_version: 1,
    idempotency_key: "allocation-attempt-2",
  });
  assert.equal(result.safe_to_spend.amount_minor, 500);
});

test("goal purposes persist and finished goals keep an explicit outcome", async () => {
  const { service, goal, calls } = fixture();

  await service.createFinanceGoal({
    name: "Family trip",
    target_amount_minor: 10_000,
  });
  assert.equal(calls.goalCreate.purpose, "other");

  await service.updateFinanceGoal({
    goal_id: goal.id,
    purpose: "vacation",
    expected_version: 1,
  });
  assert.equal(calls.goalUpdate.purpose, "vacation");

  const finished = await service.finishFinanceGoal({
    goal_id: goal.id,
    expected_version: 2,
  });
  assert.equal(calls.goalArchive.outcome, "completed");
  assert.equal(goal.status, "archived");
  assert.equal(goal.allocations[0].amount_minor, 500);
  assert.equal(finished.safe_to_spend.amount_minor, 2_000);

  await assert.rejects(
    service.updateFinanceGoal({
      goal_id: goal.id,
      name: "Rewritten history",
      expected_version: 3,
    }),
    /Archived goals cannot be edited/,
  );

  const cancelledFixture = fixture();
  await cancelledFixture.service.finishFinanceGoal({
    goal_id: cancelledFixture.goal.id,
    expected_version: 1,
    outcome: "cancelled",
  });
  assert.equal(
    cancelledFixture.calls.goalArchive.outcome,
    "cancelled",
  );
});

test("finishing releases only unused cash while overspending already hits Safe to Spend", async () => {
  const underused = fixture();
  underused.calls.checkingBalanceMinor = 20_000;
  underused.calls.cardBalanceMinor = 9_000;
  underused.goal.target_amount_minor = 10_000;
  underused.goal.allocations = [
    { source: "cash", amount_minor: 1_000 },
    { source: "brokerage", amount_minor: 0 },
  ];
  underused.goal.recorded_allocations = [
    { source: "cash", amount_minor: 10_000 },
    { source: "brokerage", amount_minor: 0 },
  ];
  underused.goal.spending = [
    { source: "cash", amount_minor: 9_000 },
  ];
  const beforeUnderused = await underused.service.getSafeToSpend();
  const underusedGoals =
    await underused.service.listFinanceGoals();
  assert.equal(
    underusedGoals.data.goals[0].plan_remaining.amount_minor,
    1_000,
  );
  assert.equal(underusedGoals.data.goals[0].over_by.amount_minor, 0);
  assert.equal(underusedGoals.data.goals[0].used_basis_points, 9_000);
  const finishedUnderused =
    await underused.service.finishFinanceGoal({
      goal_id: underused.goal.id,
      expected_version: 1,
      outcome: "completed",
    });
  assert.equal(beforeUnderused.data.safe_to_spend.amount_minor, 10_000);
  assert.equal(finishedUnderused.safe_to_spend.amount_minor, 11_000);

  const over = fixture();
  over.calls.checkingBalanceMinor = 20_000;
  over.calls.cardBalanceMinor = 11_000;
  over.goal.target_amount_minor = 10_000;
  over.goal.allocations = [
    { source: "cash", amount_minor: 0 },
    { source: "brokerage", amount_minor: 0 },
  ];
  over.goal.recorded_allocations = [
    { source: "cash", amount_minor: 10_000 },
    { source: "brokerage", amount_minor: 0 },
  ];
  over.goal.spending = [
    { source: "brokerage", amount_minor: 11_000 },
  ];
  const beforeOverFinish = await over.service.getSafeToSpend();
  assert.equal(beforeOverFinish.data.safe_to_spend.amount_minor, 9_000);
  assert.equal(
    beforeOverFinish.data.safe_to_spend.amount_minor,
    10_000 - 1_000,
  );
  const goals = await over.service.listFinanceGoals();
  assert.equal(goals.data.goals[0].plan_remaining.amount_minor, 0);
  assert.equal(goals.data.goals[0].over_by.amount_minor, 1_000);
  assert.equal(goals.data.goals[0].used_basis_points, 11_000);

  const finishedOver = await over.service.finishFinanceGoal({
    goal_id: over.goal.id,
    expected_version: 1,
    outcome: "completed",
  });
  assert.equal(finishedOver.safe_to_spend.amount_minor, 9_000);
});

test("transaction splits are posted-only, exact, signed, and reversible", async () => {
  const { service, savedSplits } = fixture();
  await assert.rejects(
    service.splitTransaction({
      transaction_id: "pending",
      expected_version: 0,
      lines: [
        { category: "Dining", amount_minor: -500 },
        { category: "Other", amount_minor: -500 },
      ],
    }),
    /Pending transactions/,
  );
  await assert.rejects(
    service.splitTransaction({
      transaction_id: "posted",
      expected_version: 0,
      lines: [
        { category: "Dining", amount_minor: -500 },
        { category: "Other", amount_minor: -499 },
      ],
    }),
    /sum exactly/,
  );

  await service.splitTransaction({
    transaction_id: "posted",
    expected_version: 0,
    lines: [
      { category: "Dining", amount_minor: -400 },
      { category: "Groceries", amount_minor: -600 },
    ],
  });
  assert.deepEqual(
    savedSplits.map((line) => line.amount_minor),
    [-400, -600],
  );
  const saved = await service.getTransactionSplit({
    transaction_id: "posted",
  });
  assert.equal(saved.split_version, 1);
  assert.deepEqual(
    saved.lines.map((line) => line.amount_minor),
    [-400, -600],
  );

  await assert.rejects(
    service.splitTransaction({
      transaction_id: "posted",
      expected_version: 0,
      lines: [
        { category: "Dining", amount_minor: -500 },
        { category: "Other", amount_minor: -500 },
      ],
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      return true;
    },
  );

  await service.splitTransaction({
    transaction_id: "posted",
    expected_version: 1,
    lines: [],
  });
  assert.deepEqual(savedSplits, []);
  const cleared = await service.getTransactionSplit({
    transaction_id: "posted",
  });
  assert.equal(cleared.split_version, 2);
  assert.deepEqual(cleared.lines, []);
});

test("transaction goal spending releases and restores earmarks without losing progress", async () => {
  const { service, goal } = fixture();

  await assert.rejects(
    service.spendFromFinanceGoal({
      transaction_id: "pending",
      goal_id: goal.id,
      source: "cash",
      amount_minor: 100,
      expected_goal_version: 1,
      expected_transaction_version: 0,
    }),
    /Pending transactions/,
  );

  const spent = await service.spendFromFinanceGoal({
    transaction_id: "posted",
    goal_id: goal.id,
    source: "cash",
    amount_minor: 400,
    expected_goal_version: 1,
    expected_transaction_version: 0,
  });
  assert.equal(spent.safe_to_spend.amount_minor, 1_900);

  const transaction = await service.getTransactionGoalSpending({
    transaction_id: "posted",
  });
  assert.equal(transaction.data.goal_spend_version, 1);
  assert.equal(transaction.data.goal_spends.length, 1);
  assert.equal(transaction.data.goal_spends[0].goal_version, 2);
  assert.equal(transaction.data.assigned.amount_minor, 400);
  assert.equal(transaction.data.remaining.amount_minor, 600);

  const goals = await service.listFinanceGoals();
  assert.equal(goals.data.goals[0].cash_earmarked.amount_minor, 100);
  assert.equal(goals.data.goals[0].spent.amount_minor, 400);
  assert.equal(goals.data.goals[0].funded.amount_minor, 1_300);

  const reversed = await service.reverseGoalSpend({
    transaction_id: "posted",
    goal_spend_id: transaction.data.goal_spends[0].id,
    expected_goal_version: 2,
    expected_transaction_version: 1,
  });
  assert.equal(reversed.safe_to_spend.amount_minor, 1_500);

  const cleared = await service.getTransactionGoalSpending({
    transaction_id: "posted",
  });
  assert.equal(cleared.data.goal_spend_version, 2);
  assert.deepEqual(cleared.data.goal_spends, []);
});

test("transaction goal spending may overrun funding but not the transaction", async () => {
  const { service, goal } = fixture();

  await service.spendFromFinanceGoal({
    transaction_id: "posted",
    goal_id: goal.id,
    source: "cash",
    amount_minor: 1_000,
    expected_goal_version: 1,
    expected_transaction_version: 0,
  });
  const goals = await service.listFinanceGoals();
  assert.equal(goals.data.goals[0].cash_earmarked.amount_minor, 0);
  assert.equal(
    goals.data.goals[0].brokerage_earmarked.amount_minor,
    300,
  );
  assert.equal(goals.data.goals[0].unfunded_spend.amount_minor, 0);

  await assert.rejects(
    service.spendFromFinanceGoal({
      transaction_id: "posted",
      goal_id: goal.id,
      source: "brokerage",
      amount_minor: 1,
      expected_goal_version: 2,
      expected_transaction_version: 1,
    }),
    /cannot exceed the transaction amount/,
  );
});

test("explicit goal spending survives later cleanup exclusion until reversed", async () => {
  const { service, goal, transactions } = fixture();
  await service.spendFromFinanceGoal({
    transaction_id: "posted",
    goal_id: goal.id,
    source: "cash",
    amount_minor: 400,
    expected_goal_version: 1,
    expected_transaction_version: 0,
  });

  transactions.get("posted").excluded_from_spending = true;
  const retained = await service.getTransactionGoalSpending({
    transaction_id: "posted",
  });
  assert.equal(retained.data.eligible, false);
  assert.equal(retained.data.assigned.amount_minor, 400);
  assert.equal(retained.data.goal_spends.length, 1);

  const goals = await service.listFinanceGoals();
  assert.equal(goals.data.goals[0].actual.amount_minor, 400);
  await assert.rejects(
    service.spendFromFinanceGoal({
      transaction_id: "posted",
      goal_id: goal.id,
      source: "cash",
      amount_minor: 1,
      expected_goal_version: 2,
      expected_transaction_version: 1,
    }),
    /Transfers and excluded transactions/,
  );
});

test("maximum transaction splits return a bounded receipt", async () => {
  const { service } = fixture();
  const result = await service.splitTransaction({
    transaction_id: "posted",
    expected_version: 0,
    lines: Array.from({ length: 50 }, (_, index) => ({
      category: `Family category ${index} ${"x".repeat(60)}`,
      amount_minor: -20,
      note: `Planning note ${index} ${"y".repeat(180)}`,
    })),
  });

  assert.equal(result.changed.before.line_count, 0);
  assert.equal(result.changed.after.line_count, 50);
  assert.equal(result.changed.after.total_amount_minor, -1_000);
  assert.equal(result.changed.split_version, 1);
  assert.equal(Object.hasOwn(result.changed, "splits"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 4_000);
});

test("alternate-Friday schedule runs are idempotent, may make cash negative, and stop at target", async () => {
  const goal = {
    id: "goal-trip",
    name: "Trip",
    target_amount_minor: 300,
    currency_code: "USD",
    target_on: null,
    status: "active",
    version: 1,
    allocations: [{ source: "cash", amount_minor: 0 }],
    schedules: [],
  };
  const schedule = {
    id: "schedule-trip",
    goal_id: goal.id,
    source: "cash",
    cadence: "biweekly_friday",
    amount_minor: 100,
    monthly_day: null,
    anchor_on: "2026-07-31",
    next_run_on: "2026-07-31",
    status: "active",
    version: 1,
  };
  goal.schedules.push(schedule);
  const allocationKeys = new Map();
  const runKeys = new Set();
  const repository = {
    async getWorkspaceTimezone() {
      return "America/Los_Angeles";
    },
    async listGoals() {
      return [structuredClone(goal)];
    },
    async getGoal() {
      return structuredClone(goal);
    },
    async listDueGoalSchedules(_workspaceId, throughOn) {
      return schedule.status === "active" &&
        schedule.next_run_on <= throughOn
        ? [structuredClone(schedule)]
        : [];
    },
    async addGoalAllocation(
      _workspaceId,
      {
        amountDeltaMinor,
        idempotencyKey,
      },
    ) {
      if (allocationKeys.has(idempotencyKey)) {
        return allocationKeys.get(idempotencyKey);
      }
      goal.allocations[0].amount_minor += amountDeltaMinor;
      goal.version += 1;
      const value = {
        event: { id: `event-${allocationKeys.size + 1}` },
        goal: structuredClone(goal),
        audit_event_id: `audit-${allocationKeys.size + 1}`,
      };
      allocationKeys.set(idempotencyKey, value);
      return value;
    },
    async finishGoalScheduleRun(
      _workspaceId,
      _schedule,
      {
        dueOn,
        nextRunOn,
        pauseSchedule,
      },
    ) {
      const key = `${schedule.id}:${dueOn}`;
      if (runKeys.has(key)) return { replayed: true };
      runKeys.add(key);
      schedule.next_run_on = nextRunOn;
      if (pauseSchedule) schedule.status = "paused";
      return { replayed: false };
    },
  };
  const financeRepository = {
    async listAccounts() {
      return [
        {
          id: "checking",
          balance_group: "cash",
          current_balance_minor: 0,
          currency_code: "USD",
          active: true,
        },
      ];
    },
    async getDataFreshness() {
      return {
        data_as_of: "2026-08-28T12:00:00.000Z",
        partial: false,
      };
    },
  };
  const service = new PlanningService({
    repository,
    financeRepository,
    now: () => new Date("2026-08-28T12:00:00.000Z"),
  });

  const first = await service.processDueGoalSchedules({
    through_on: "2026-08-28",
  });
  const duplicate = await service.processDueGoalSchedules({
    through_on: "2026-08-28",
  });
  const safe = await service.getSafeToSpend();

  assert.equal(first.processed, 3);
  assert.equal(duplicate.processed, 0);
  assert.equal(goal.allocations[0].amount_minor, 300);
  assert.equal(schedule.status, "paused");
  assert.equal(safe.data.safe_to_spend.amount_minor, -300);
});

test("planning reads stay pure and budget edits update the current standing plan", async () => {
  const { service, calls } = fixture();

  const budget = await service.getBudgetStatus({
    month_on: "2026-07-19",
  });
  assert.equal(calls.budgetSnapshots, 0);
  assert.equal(
    budget.data.standing_effective_month_on,
    "2026-07-01",
  );

  await service.setCategoryBudget({
    category: "Groceries",
    amount_minor: 75_000,
    expected_version: 0,
  });
  assert.equal(calls.budgetSnapshots, 0);
  assert.equal(calls.budgetWrite.scope, "standing");
  assert.equal(calls.budgetWrite.monthOn, "2026-07-01");
  assert.equal(calls.budgetWrite.effectiveMonthOn, "2026-07-01");

  const historical = await service.getBudgetStatus({
    month_on: "2026-06-15",
  });
  assert.equal(
    historical.data.standing_effective_month_on,
    "2026-07-01",
  );
  await assert.rejects(
    service.setCategoryBudget({
      category: "Groceries",
      amount_minor: 80_000,
      expected_version: 0,
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      return true;
    },
  );
});

test("planning service rejects invalid calendar dates and non-Friday anchors", async () => {
  const { service, goal } = fixture();
  const invalidCalls = [
    () => service.getBudgetStatus({ month_on: "2026-99-01" }),
    () =>
      service.processDueGoalSchedules({
        through_on: "2026-02-29",
      }),
    () =>
      service.setGoalFundingSchedule({
        goal_id: goal.id,
        source: "cash",
        cadence: "biweekly_friday",
        amount_minor: 100,
        anchor_on: "2026-07-30",
      }),
  ];

  for (const call of invalidCalls) {
    await assert.rejects(call, (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "invalid_request");
      return true;
    });
  }
});

test("scenario reads reject missing goals and archived goal cards keep the full planning shape", async () => {
  const { service, goal } = fixture();
  await assert.rejects(
    service.modelFinancePlan({ goal_id: "goal-missing" }),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "not_found");
      return true;
    },
  );

  goal.status = "archived";
  const archived = await service.listFinanceGoals({
    status: "archived",
  });
  assert.equal(archived.data.goals.length, 1);
  assert.equal(archived.data.goals[0].archived, true);
  assert.equal(archived.data.goals[0].status, "archived");
  assert.deepEqual(archived.data.goals[0].allocations, []);
  assert.equal(archived.data.goals[0].cash_earmarked_minor, 0);
  assert.equal(
    archived.data.goals[0].brokerage_earmarked_minor,
    0,
  );
  assert.equal(archived.data.goals[0].funded.amount_minor, 1_300);
  assert.equal(
    archived.data.goals[0].cash_earmarked.amount_minor,
    0,
  );
  assert.equal(
    archived.data.goals[0].brokerage_earmarked.amount_minor,
    0,
  );
  assert.equal(
    archived.data.goals[0].recorded_cash_funding.amount_minor,
    500,
  );
  assert.equal(
    archived.data.goals[0].recorded_brokerage_funding.amount_minor,
    800,
  );
  assert.equal(
    archived.data.goals[0].unused_funding.amount_minor,
    1_300,
  );
  assert.equal(
    typeof archived.data.goals[0].progress_basis_points,
    "number",
  );
});

test("goal history pagination stays bounded and traverses a stable ordering", async () => {
  const activeGoals = Array.from({ length: 5 }, (_, index) => ({
    id: `goal-active-${String(index).padStart(2, "0")}`,
    name: `Active ${index} ${"a".repeat(100)}`,
    purpose: index % 2 === 0 ? "home" : "vacation",
    target_amount_minor: 100_000,
    currency_code: "USD",
    target_on: null,
    status: "active",
    version: 1,
    allocations: [],
    recorded_allocations: [],
    spending: [],
    schedules: [],
    archived_at: null,
    archive_outcome: null,
  }));
  const archivedGoals = Array.from(
    { length: 21 },
    (_, index) => ({
      id: `goal-archived-${String(index).padStart(2, "0")}`,
      name: `Archived ${index} ${"z".repeat(96)}`,
      purpose: index % 2 === 0 ? "vacation" : "home",
      target_amount_minor: 100_000,
      currency_code: "USD",
      target_on: null,
      status: "archived",
      version: 2,
      allocations: [],
      recorded_allocations: [
        { source: "cash", amount_minor: 100_000 },
      ],
      spending: [
        {
          source: "cash",
          amount_minor: 105_000 + index * 100,
        },
      ],
      schedules: [],
      archived_at: new Date(
        Date.UTC(2026, 6, index + 1),
      ).toISOString(),
      archive_outcome: "completed",
    }),
  );
  const includeArchivedReads = [];
  const repository = {
    async listGoals(_workspaceId, { includeArchived }) {
      includeArchivedReads.push(includeArchived);
      return structuredClone(
        includeArchived
          ? activeGoals.concat(archivedGoals)
          : activeGoals,
      );
    },
  };
  const financeRepository = {
    async listAccounts() {
      return [];
    },
    async getDataFreshness() {
      return {
        data_as_of: "2026-07-27T12:00:00.000Z",
        partial: false,
      };
    },
  };
  const service = new PlanningService({
    repository,
    financeRepository,
  });

  const defaultPage = await service.listFinanceGoals();
  assert.deepEqual(defaultPage.data.history_insights, []);
  assert.equal(includeArchivedReads.at(-1), false);

  const traversed = [];
  let cursor;
  do {
    const page = await service.listFinanceGoals(
      cursor
        ? { limit: 8, cursor }
        : { status: "all", limit: 8 },
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(page), "utf8") < 20_000,
    );
    assert.ok(page.data.goals.length <= 8);
    assert.ok(
      page.data.history_insights.every(
        (insight) => insight.evidence_goal_ids.length <= 8,
      ),
    );
    assert.ok(
      page.data.history_insights.every(
        (insight) =>
          insight.evidence_goal_ids_truncated === true &&
          insight.evidence_goal_ids.length === 8,
      ),
    );
    traversed.push(...page.data.goals.map((goal) => goal.id));
    cursor = page.data.page_info.next_cursor;
  } while (cursor);

  assert.deepEqual(traversed, [
    ...activeGoals.map((goal) => goal.id),
    ...[...archivedGoals]
      .reverse()
      .map((goal) => goal.id),
  ]);
  assert.ok(includeArchivedReads.slice(1).every(Boolean));

  const vacation = await service.listFinanceGoals({
    status: "archived",
    purpose: "vacation",
    limit: 8,
  });
  assert.equal(vacation.data.page_info.total_count, 11);
  assert.ok(
    vacation.data.goals.every(
      (goal) =>
        goal.status === "archived" &&
        goal.purpose === "vacation",
    ),
  );
  assert.ok(vacation.data.history_insights.length > 0);
  assert.ok(
    vacation.data.history_insights.every(
      (insight) => insight.purpose === "vacation",
    ),
  );

  for (const input of [
    { status: "finished" },
    { purpose: "retirement" },
    { limit: 0 },
    { limit: 9 },
    { limit: 1.5 },
    { cursor: "" },
    { cursor: null },
    { cursor: "goal:-1" },
    { cursor: "goal:01" },
    { cursor: "page:8" },
    {
      cursor: vacation.data.page_info.next_cursor,
      status: "active",
    },
    {
      cursor: vacation.data.page_info.next_cursor,
      purpose: "home",
    },
    {
      cursor: `goal.${Buffer.from(
        JSON.stringify({
          v: 1,
          offset: 8,
          status: "archived",
          purpose: "vacation",
          extra: true,
        }),
      ).toString("base64url")}`,
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

test("scenario baseline includes the selected goal's active funding schedule", async () => {
  const { service, goal } = fixture();
  goal.schedules = [
    {
      id: "schedule-house",
      goal_id: goal.id,
      source: "cash",
      cadence: "monthly",
      amount_minor: 1_000,
      monthly_day: 15,
      anchor_on: null,
      next_run_on: "2026-08-15",
      status: "active",
      version: 1,
    },
  ];

  const modeled = await service.modelFinancePlan({
    goal_id: goal.id,
  });

  assert.equal(
    modeled.data.scheduled_monthly_contribution.amount_minor,
    1_000,
  );
  assert.equal(modeled.data.monthly_contribution.amount_minor, 1_000);
  assert.equal(modeled.data.months_to_target, 4);
  assert.match(
    modeled.data.assumptions[0],
    /funding schedules continue/,
  );
});
