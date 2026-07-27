import { randomUUID } from "node:crypto";

import {
  buildBudgetStatus,
  buildPlanningSnapshot,
  modelPlanningScenario,
  monthStart,
  nextScheduleDueOn,
  workspaceDate,
} from "./planningAnalytics.js";
import { shiftDateOnly } from "./analytics.js";

export function createDemoPlanningService({
  now = () => new Date("2026-07-27T19:00:00.000Z"),
} = {}) {
  const accounts = [
    {
      id: "demo-checking",
      type: "depository",
      subtype: "checking",
      balance_group: "cash",
      current_balance_minor: 2_887_780,
      currency_code: "USD",
      active: true,
    },
    {
      id: "demo-savings",
      type: "depository",
      subtype: "savings",
      balance_group: "cash",
      current_balance_minor: 1_600_000,
      currency_code: "USD",
      active: true,
    },
    {
      id: "demo-card",
      type: "credit",
      subtype: "credit_card",
      balance_group: "credit_card",
      current_balance_minor: 281_463,
      currency_code: "USD",
      active: true,
    },
    {
      id: "demo-brokerage",
      type: "investment",
      subtype: "brokerage",
      balance_group: "taxable_investment",
      current_balance_minor: 6_342_941,
      currency_code: "USD",
      active: true,
    },
  ];
  const goals = [
    {
      id: "goal_down_payment",
      name: "House down payment",
      target_amount_minor: 10_000_000,
      currency_code: "USD",
      target_on: "2029-06-01",
      status: "active",
      version: 1,
      allocations: [
        { source: "cash", amount_minor: 500_000 },
        { source: "brokerage", amount_minor: 1_500_000 },
      ],
      schedules: [
        {
          id: "schedule_down_payment",
          goal_id: "goal_down_payment",
          source: "brokerage",
          cadence: "monthly",
          amount_minor: 100_000,
          monthly_day: 15,
          anchor_on: null,
          next_run_on: "2026-08-15",
          status: "active",
          version: 1,
        },
      ],
    },
    {
      id: "goal_car_mods",
      name: "Car modifications",
      target_amount_minor: 1_200_000,
      currency_code: "USD",
      target_on: "2027-08-01",
      status: "active",
      version: 1,
      allocations: [{ source: "cash", amount_minor: 250_000 }],
      schedules: [
        {
          id: "schedule_car_mods",
          goal_id: "goal_car_mods",
          source: "cash",
          cadence: "biweekly_friday",
          amount_minor: 20_000,
          monthly_day: null,
          anchor_on: "2026-07-31",
          next_run_on: "2026-07-31",
          status: "active",
          version: 1,
        },
      ],
    },
  ];
  const budgetDefaults = new Map([
    ["Housing", 145_000],
    ["Groceries", 75_000],
    ["Dining", 45_000],
    ["Shopping", 40_000],
    ["Travel", 50_000],
    ["Utilities", 40_000],
    ["Fees & Interest", 5_000],
    ["Other", 20_000],
  ]);
  const budgetMonths = new Map();
  const auditEvents = [];
  const scheduleRuns = [];
  const idempotentWrites = new Map();
  const transactionSplits = new Map();

  const freshness = {
    data_as_of: "2026-07-27T18:48:00.000Z",
    partial: false,
  };

  function state(includeArchived = false) {
    return buildPlanningSnapshot({
      accounts,
      goals: goals.filter(
        (goal) => includeArchived || goal.status === "active",
      ),
      currency: "USD",
    });
  }

  function budget(monthOn) {
    const month = monthStart(monthOn);
    if (!budgetMonths.has(month)) {
      budgetMonths.set(month, new Map(budgetDefaults));
    }
    const values = budgetMonths.get(month);
    const actuals = new Map([
      ["Housing", 145_000],
      ["Groceries", 68_430],
      ["Dining", 52_146],
      ["Shopping", 47_890],
      ["Travel", 41_205],
      ["Utilities", 33_913],
      ["Fees & Interest", 11_600],
      ["Other", 12_500],
    ]);
    const transactions = [...actuals.entries()].map(
      ([category, amount], index) => ({
        id: `demo-budget-${index}`,
        posted_on: `${month.slice(0, 8)}${String(index + 2).padStart(2, "0")}`,
        pending: false,
        excluded_from_spending: false,
        currency_code: "USD",
        amount_minor: -amount,
        category_primary: category,
      }),
    );
    return buildBudgetStatus({
      monthOn: month,
      budgetLines: [...values.entries()].map(([category, amount_minor]) => ({
        category,
        amount_minor,
      })),
      transactions,
      currency: "USD",
    });
  }

  function actor(actorInput) {
    return actorInput?.type === "openwebui"
      ? { type: "openwebui", id: actorInput.id ?? "openwebui" }
      : { type: "member", id: actorInput?.id ?? "demo-user" };
  }

  function audit(eventType, subjectType, subjectId, actorValue, before, after) {
    const event = {
      id: `audit_${randomUUID()}`,
      event_type: eventType,
      subject_type: subjectType,
      subject_id: subjectId,
      actor_type: actorValue.type,
      actor_id: actorValue.id,
      before,
      after,
      created_at: now().toISOString(),
    };
    auditEvents.unshift(event);
    return event.id;
  }

  function change(title, changed, auditEventId) {
    return {
      title,
      changed,
      safe_to_spend: state().safe_to_spend,
      goals: state().goals,
      audit_event_id: auditEventId,
      data_as_of: freshness.data_as_of,
      source: { label: "Money", url: "/plan" },
    };
  }

  const service = {
    async getSafeToSpend() {
      const snapshot = state();
      return {
        data: snapshot,
        ...freshness,
        warnings: [],
        title: "Safe to Spend",
        subtitle: "2 active goals",
        source: { label: "Money", url: "/plan" },
        summary: "Safe to Spend reflects liquid cash after card balances and cash-backed goals.",
      };
    },

    async listFinanceGoals({ include_archived = false } = {}) {
      const snapshot = state(include_archived);
      return {
        data: {
          currency: "USD",
          goals: snapshot.goals,
          brokerage_backing_basis_points:
            snapshot.brokerage_backing_basis_points,
          taxable_brokerage_value: snapshot.taxable_brokerage_value,
        },
        ...freshness,
        warnings: [],
        title: "Finance goals",
        subtitle: `${snapshot.active_goal_count} active`,
        source: { label: "Money", url: "/plan#goals" },
        summary: "Shared household goals are funded from cash and brokerage earmarks.",
      };
    },

    async getBudgetStatus({ month_on = null } = {}) {
      const month = monthStart(
        month_on ?? workspaceDate(now(), "America/Los_Angeles"),
      );
      const data = budget(month);
      data.has_exact_month_lines = budgetMonths.has(month);
      data.source = data.has_exact_month_lines
        ? "month"
        : "future_default";
      return {
        data,
        ...freshness,
        warnings: [],
        title: "Monthly budget",
        subtitle: month.slice(0, 7),
        source: { label: "Money", url: `/plan?month=${month}` },
        summary: "The monthly budget is an independent scoreboard with no rollover.",
      };
    },

    async modelFinancePlan(input = {}) {
      const data = modelPlanningScenario({
        snapshot: state(),
        goalId: input.goal_id ?? null,
        monthlyContributionMinor:
          Number(input.monthly_contribution_minor) || 0,
        biweeklyContributionMinor:
          Number(input.biweekly_contribution_minor) || 0,
        oneTimeContributionMinor:
          Number(input.one_time_contribution_minor) || 0,
        brokerageChangeBasisPoints:
          Number(input.brokerage_change_basis_points) || 0,
        asOf: now(),
      });
      return {
        data,
        ...freshness,
        warnings: [],
        title: "Finance plan scenario",
        subtitle: data.goal_name,
        source: { label: "Money", url: "/plan#scenario" },
        summary: "Scenario calculated from explicit contributions and market assumptions.",
      };
    },

    async getPlanningOverview({ month_on = null } = {}) {
      const safeToSpend = state();
      return {
        safeToSpend,
        goals: safeToSpend.goals,
        budget: budget(
          month_on ?? workspaceDate(now(), "America/Los_Angeles"),
        ),
        scheduleRuns,
        auditEvents,
        alerts: safeToSpend.alerts,
        freshness: freshness.data_as_of,
      };
    },

    async getTransactionSplit({ transaction_id }) {
      return {
        transaction_id,
        lines: structuredClone(
          transactionSplits.get(transaction_id) ?? [],
        ),
      };
    },

    async createFinanceGoal(input, actorInput) {
      const actorValue = actor(actorInput);
      const goal = {
        id: `goal_${randomUUID()}`,
        name: String(input.name).trim(),
        target_amount_minor: Number(input.target_amount_minor),
        currency_code: "USD",
        target_on: input.target_on || null,
        status: "active",
        version: 1,
        allocations: [],
        schedules: [],
      };
      goals.push(goal);
      const auditId = audit(
        "goal.created",
        "goal",
        goal.id,
        actorValue,
        null,
        goal,
      );
      return change(
        "Goal created",
        { before: null, after: goal, goal },
        auditId,
      );
    },

    async updateFinanceGoal(input, actorInput) {
      const goal = findGoal(goals, input.goal_id);
      assertVersion(goal, input.expected_version);
      const before = structuredClone(goal);
      if (input.name != null) goal.name = String(input.name).trim();
      if (input.target_amount_minor != null) {
        goal.target_amount_minor = Number(input.target_amount_minor);
      }
      if (Object.hasOwn(input, "target_on")) {
        goal.target_on = input.target_on || null;
      }
      goal.version += 1;
      const auditId = audit(
        "goal.updated",
        "goal",
        goal.id,
        actor(actorInput),
        before,
        goal,
      );
      return change(
        "Goal updated",
        { before, after: goal, goal },
        auditId,
      );
    },

    async allocateFinanceGoal(input, actorInput) {
      const goal = findGoal(goals, input.goal_id);
      assertVersion(goal, input.expected_version);
      const before = structuredClone(goal);
      const source = input.source;
      const allocation =
        goal.allocations.find((entry) => entry.source === source) ??
        { source, amount_minor: 0 };
      if (!goal.allocations.includes(allocation)) {
        goal.allocations.push(allocation);
      }
      const delta =
        (input.direction ?? "allocate") === "release"
          ? -Number(input.amount_minor)
          : Number(input.amount_minor);
      allocation.amount_minor += delta;
      if (allocation.amount_minor < 0) {
        throw demoConflict("The release exceeds the earmarked amount.");
      }
      goal.version += 1;
      const auditId = audit(
        delta > 0 ? "goal.allocation_added" : "goal.allocation_released",
        "goal",
        goal.id,
        actor(actorInput),
        before,
        goal,
      );
      return change(
        delta > 0 ? "Goal allocation added" : "Goal allocation released",
        { before, after: goal, goal },
        auditId,
      );
    },

    async setGoalFundingSchedule(input, actorInput) {
      const goal = findGoal(goals, input.goal_id);
      const existing = input.schedule_id
        ? goal.schedules.find(
            (schedule) => schedule.id === input.schedule_id,
          )
        : null;
      if (existing) assertVersion(existing, input.expected_version);
      const before = existing ? structuredClone(existing) : null;
      const schedule = existing ?? {
        id: `schedule_${randomUUID()}`,
        goal_id: goal.id,
        version: 0,
      };
      Object.assign(schedule, {
        source: input.source,
        cadence: input.cadence,
        amount_minor: Number(input.amount_minor),
        monthly_day:
          input.cadence === "monthly"
            ? Number(input.monthly_day)
            : null,
        anchor_on:
          input.cadence === "biweekly_friday"
            ? input.anchor_on
            : null,
        status: input.status ?? "active",
      });
      schedule.next_run_on = nextScheduleDueOn(
        schedule,
        shiftDateOnly(
          workspaceDate(now(), "America/Los_Angeles"),
          -1,
        ),
      );
      schedule.version += 1;
      if (!existing) goal.schedules.push(schedule);
      const auditId = audit(
        existing ? "goal.schedule_updated" : "goal.schedule_created",
        "goal_schedule",
        schedule.id,
        actor(actorInput),
        before,
        schedule,
      );
      return change(
        "Goal schedule saved",
        { before, after: schedule, schedule },
        auditId,
      );
    },

    async archiveFinanceGoal(input, actorInput) {
      const goal = findGoal(goals, input.goal_id);
      assertVersion(goal, input.expected_version);
      if (
        goal.allocations.some((entry) => entry.amount_minor !== 0)
      ) {
        throw demoConflict("Release goal earmarks before archiving.");
      }
      const before = structuredClone(goal);
      goal.status = "archived";
      goal.version += 1;
      const auditId = audit(
        "goal.archived",
        "goal",
        goal.id,
        actor(actorInput),
        before,
        goal,
      );
      return change(
        "Goal archived",
        { before, after: goal, goal },
        auditId,
      );
    },

    async setCategoryBudget(input, actorInput) {
      const month = monthStart(
        input.month_on ??
          workspaceDate(now(), "America/Los_Angeles"),
      );
      const target =
        input.scope === "future_default"
          ? budgetDefaults
          : ensureBudgetMonth(budgetMonths, month, budgetDefaults);
      const before = target.has(input.category)
        ? {
            category: input.category,
            amount_minor: target.get(input.category),
          }
        : null;
      target.set(input.category, Number(input.amount_minor));
      const after = {
        category: input.category,
        amount_minor: Number(input.amount_minor),
      };
      const auditId = audit(
        input.scope === "future_default"
          ? "budget.default_set"
          : "budget.month_set",
        "budget_line",
        `${month}:${input.category}`,
        actor(actorInput),
        before,
        after,
      );
      return change("Budget saved", { before, after }, auditId);
    },

    async copyBudgetMonth(input, actorInput) {
      const target = monthStart(input.month_on);
      const source = monthStart(input.source_month_on);
      const sourceValues = budgetMonths.get(source) ?? budgetDefaults;
      budgetMonths.set(target, new Map(sourceValues));
      const auditId = audit(
        "budget.month_copied",
        "budget_month",
        target,
        actor(actorInput),
        null,
        [...sourceValues],
      );
      return change(
        "Budget copied",
        { before: null, after: [...sourceValues] },
        auditId,
      );
    },

    async splitTransaction(_input, actorInput) {
      const before = structuredClone(
        transactionSplits.get(_input.transaction_id) ?? [],
      );
      transactionSplits.set(
        _input.transaction_id,
        structuredClone(_input.lines ?? []),
      );
      const auditId = audit(
        "transaction.splits_replaced",
        "transaction",
        _input.transaction_id,
        actor(actorInput),
        before,
        _input.lines,
      );
      return change(
        _input.lines?.length
          ? "Transaction split saved"
          : "Transaction split cleared",
        {
          before,
          after: _input.lines ?? [],
          splits: _input.lines ?? [],
        },
        auditId,
      );
    },

    async executeIdempotentWrite(operation, input, actorInput) {
      const methods = {
        create_finance_goal: "createFinanceGoal",
        update_finance_goal: "updateFinanceGoal",
        allocate_finance_goal: "allocateFinanceGoal",
        set_goal_funding_schedule: "setGoalFundingSchedule",
        archive_finance_goal: "archiveFinanceGoal",
        set_category_budget: "setCategoryBudget",
        copy_budget_month: "copyBudgetMonth",
        split_transaction: "splitTransaction",
      };
      const method = methods[operation];
      if (!method) throw demoConflict("Unsupported planning write.");
      const actorValue = actor(actorInput);
      const key = `${actorValue.type}:${actorValue.id}:${operation}:${input.idempotency_key}`;
      const request = JSON.stringify(input);
      const existing = idempotentWrites.get(key);
      if (existing && existing.request !== request) {
        throw demoConflict(
          "That idempotency key was already used for a different request.",
        );
      }
      if (existing) return existing.response;
      const response = await service[method](input, actorValue);
      idempotentWrites.set(key, { request, response });
      return response;
    },

    async processDueGoalSchedules() {
      return { processed: 0, runs: [] };
    },
  };
  return service;
}

function findGoal(goals, id) {
  const goal = goals.find((entry) => entry.id === id);
  if (!goal) throw demoNotFound("Goal not found.");
  return goal;
}

function assertVersion(record, expectedVersion) {
  if (record.version !== Number(expectedVersion)) {
    throw demoConflict("The planning record changed; refresh and try again.");
  }
}

function ensureBudgetMonth(months, month, defaults) {
  if (!months.has(month)) months.set(month, new Map(defaults));
  return months.get(month);
}

function demoConflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.status = 409;
  error.code = "conflict";
  error.expose = true;
  return error;
}

function demoNotFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  error.status = 404;
  error.code = "not_found";
  error.expose = true;
  return error;
}
