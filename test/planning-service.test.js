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
    status: "active",
    version: 1,
    allocations: [
      { source: "cash", amount_minor: 500 },
      { source: "brokerage", amount_minor: 800 },
    ],
    schedules: [],
  };
  const savedSplits = [];
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
      goal.version += 1;
      return {
        event: { id: "allocation-1" },
        goal: structuredClone(goal),
        audit_event_id: "audit-1",
      };
    },
    async listResolvedBudgetLines() {
      return [];
    },
    async listTransactionSplits() {
      return [];
    },
    async listGoalScheduleRuns() {
      return [];
    },
    async listAuditEvents() {
      return [];
    },
    async replaceTransactionSplits(
      _workspaceId,
      _transactionId,
      lines,
    ) {
      savedSplits.splice(0, savedSplits.length, ...structuredClone(lines));
      return {
        splits: structuredClone(savedSplits),
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
      },
    ],
  ]);
  const financeRepository = {
    async listAccounts() {
      return [
        {
          id: "checking",
          balance_group: "cash",
          current_balance_minor: 2_000,
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

test("transaction splits are posted-only, exact, signed, and reversible", async () => {
  const { service, savedSplits } = fixture();
  await assert.rejects(
    service.splitTransaction({
      transaction_id: "pending",
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
      lines: [
        { category: "Dining", amount_minor: -500 },
        { category: "Other", amount_minor: -499 },
      ],
    }),
    /sum exactly/,
  );

  await service.splitTransaction({
    transaction_id: "posted",
    lines: [
      { category: "Dining", amount_minor: -400 },
      { category: "Groceries", amount_minor: -600 },
    ],
  });
  assert.deepEqual(
    savedSplits.map((line) => line.amount_minor),
    [-400, -600],
  );

  await service.splitTransaction({
    transaction_id: "posted",
    lines: [],
  });
  assert.deepEqual(savedSplits, []);
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
