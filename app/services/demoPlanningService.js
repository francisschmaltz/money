import { randomUUID } from "node:crypto";

import {
  buildArchivedGoalSnapshot,
  buildBudgetStatus,
  buildGoalHistoryInsights,
  buildPlanningSnapshot,
  modelPlanningScenario,
  monthStart,
  nextScheduleDueOn,
  workspaceDate,
} from "./planningAnalytics.js";
import { shiftDateOnly } from "./analytics.js";
import {
  buildUxStressTransactions,
  UX_STRESS_SPLIT_TRANSACTION_ID,
} from "../demo/uxStressScenario.js";
import {
  buildDefaultBudgetActuals,
  buildDefaultBudgetDefaults,
  buildDefaultGoals,
  buildDefaultPlanningAccounts,
  buildDefaultTransactions,
} from "../demo/defaultScenario.js";

const GOAL_PURPOSES = new Set([
  "vacation",
  "home",
  "vehicle",
  "education",
  "emergency",
  "event",
  "purchase",
  "other",
]);
const GOAL_ARCHIVE_OUTCOMES = new Set(["completed", "cancelled"]);
const GOAL_LIST_STATUSES = new Set(["active", "archived", "all"]);

export function createDemoPlanningService({
  now = () => new Date("2026-07-27T19:00:00.000Z"),
  scenario = "default",
} = {}) {
  const stressTransactions =
    scenario === "ux-stress"
      ? buildUxStressTransactions()
      : [];
  const accounts = buildDefaultPlanningAccounts();
  const goals = buildDefaultGoals();
  if (scenario === "ux-stress") {
    goals[0].name =
      "House down payment for the long-term multigenerational family home";
    goals[0].target_amount_minor = 123_456_789;
    goals[0].target_on = "2034-12-31";
  }
  const budgetDefaults = buildDefaultBudgetDefaults();
  const budgetMonths = new Map();
  const budgetVersions = new Map(
    [...budgetDefaults.keys()].map((category) => [category, 1]),
  );
  const budgetModes = new Map(
    [...budgetDefaults.keys()].map((category) => [category, "tracked"]),
  );
  let budgetSettingsVersion = 1;
  let incomeCategoryIds = ["category_income"];
  const auditEvents = [];
  const scheduleRuns = [];
  const idempotentWrites = new Map();
  const transactionSplits = new Map();
  const transactionSplitVersions = new Map();
  const transactionGoalSpends = new Map();
  const transactionGoalSpendVersions = new Map();
  const demoTransactions = new Map([
    ...buildDefaultTransactions().map((transaction) => [
      transaction.id,
      {
        amount_minor: transaction.amount.amount_minor,
        currency_code: transaction.amount.currency,
        pending: transaction.pending,
        excluded_from_spending:
          transaction.excluded_from_spending,
      },
    ]),
    ...stressTransactions.map((transaction) => [
      transaction.id,
      {
        amount_minor: transaction.amount.amount_minor,
        currency_code: transaction.amount.currency,
        pending: transaction.pending,
        excluded_from_spending:
          transaction.excluded_from_spending,
      },
    ]),
  ]);
  if (scenario === "ux-stress") {
    const splitTransaction = stressTransactions.find(
      (transaction) =>
        transaction.id === UX_STRESS_SPLIT_TRANSACTION_ID,
    );
    if (splitTransaction) {
      const amountMinor = splitTransaction.amount.amount_minor;
      const firstAmount = Math.trunc(amountMinor / 2);
      transactionSplits.set(splitTransaction.id, [
        {
          category: "Groceries",
          amount_minor: firstAmount,
          split_version: 1,
        },
        {
          category: "Home / Repairs",
          amount_minor: amountMinor - firstAmount,
          split_version: 1,
        },
      ]);
      transactionSplitVersions.set(splitTransaction.id, 1);
    }
  }

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

  function goalCatalog(snapshot = state()) {
    const activeGoals = [...snapshot.goals].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const archivedRecords = goals.filter(
      (goal) => goal.status === "archived",
    );
    const archivedGoals = archivedRecords
      .map((goal) =>
        buildArchivedGoalSnapshot(goal, { currency: "USD" }),
      )
      .sort(compareDemoArchivedGoals);
    return {
      goals: activeGoals.concat(archivedGoals),
      archivedGoals,
      historyInsights: buildGoalHistoryInsights(archivedRecords, {
        currency: "USD",
      }),
    };
  }

  function budget(monthOn) {
    const month = monthStart(monthOn);
    const currentMonth = monthStart(
      workspaceDate(now(), "America/Los_Angeles"),
    );
    const values =
      month < currentMonth && budgetMonths.has(month)
        ? budgetMonths.get(month)
        : budgetDefaults;
    const isPreviousMonth = month === previousMonth(currentMonth);
    const actuals = buildDefaultBudgetActuals({
      previousMonth: isPreviousMonth,
    });
    const transactions = [...actuals.entries()].map(
      ([category, amount], index) => ({
        id: `demo-budget-${index}`,
        posted_on: `${month.slice(0, 8)}${String(index + 2).padStart(2, "0")}`,
        pending: false,
        excluded_from_spending: false,
        currency_code: "USD",
        amount_minor: -amount,
        category_primary: category,
        category_id: demoBudgetCategoryId(category),
      }),
    );
    return buildBudgetStatus({
      monthOn: month,
      categories: demoBudgetCategories(),
      budgetLines: [...values.entries()].map(([category, amount_minor]) => ({
        category_id: demoBudgetCategoryId(category),
        category,
        amount_minor,
        tracking_mode: budgetModes.get(category) ?? "tracked",
        version: budgetVersions.get(category) ?? 0,
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
      changed: compactPlanChange(changed),
      safe_to_spend: state().safe_to_spend,
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

    async listFinanceGoals(input = {}) {
      const cursor = parseDemoGoalCursor(input.cursor);
      const hasStatus =
        Object.hasOwn(input, "status") && input.status !== undefined;
      const hasPurpose =
        Object.hasOwn(input, "purpose") && input.purpose !== undefined;
      const suppliedStatus = hasStatus
        ? demoReadEnum(
            input.status,
            GOAL_LIST_STATUSES,
            "status",
          )
        : null;
      const suppliedPurpose = hasPurpose
        ? demoReadEnum(input.purpose, GOAL_PURPOSES, "purpose")
        : null;
      if (
        cursor &&
        ((hasStatus && suppliedStatus !== cursor.status) ||
          (hasPurpose && suppliedPurpose !== cursor.purpose))
      ) {
        throw demoBadRequest(
          "cursor does not match the requested goal filters.",
        );
      }
      const status = cursor?.status ?? suppliedStatus ?? "active";
      const purpose = cursor?.purpose ?? suppliedPurpose;
      const limit =
        input.limit === undefined
          ? 8
          : demoReadInteger(input.limit, 1, 8, "limit");
      const offset = cursor?.offset ?? 0;
      const snapshot = state();
      const catalog =
        status === "active"
          ? {
              goals: [...snapshot.goals].sort((left, right) =>
                left.id.localeCompare(right.id),
              ),
              historyInsights: [],
            }
          : goalCatalog(snapshot);
      const filtered = catalog.goals.filter(
        (goal) =>
          (status === "all" || goal.status === status) &&
          (purpose == null || goal.purpose === purpose),
      );
      const page = filtered.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const hasMore = nextOffset < filtered.length;
      const scopedHistoryInsights =
        status === "active"
          ? []
          : catalog.historyInsights.filter(
              (insight) =>
                purpose == null || insight.purpose === purpose,
            );
      return {
        data: {
          currency: "USD",
          goals: page,
          brokerage_backing_basis_points:
            snapshot.brokerage_backing_basis_points,
          taxable_brokerage_value: snapshot.taxable_brokerage_value,
          history_insights: boundedDemoGoalHistoryInsights(
            scopedHistoryInsights,
          ),
          page_info: {
            returned_count: page.length,
            total_count: filtered.length,
            has_more: hasMore,
            next_cursor: hasMore
              ? encodeDemoGoalCursor({
                  offset: nextOffset,
                  status,
                  purpose,
                })
              : null,
          },
        },
        ...freshness,
        warnings: [],
        title: "Finance goals",
        subtitle: `${filtered.length} matching`,
        source: { label: "Money", url: "/plan#goals" },
        summary: `${page.length} of ${filtered.length} matching household goals returned.`,
      };
    },

    async getBudgetStatus({
      month_on = null,
      include_available_categories = false,
    } = {}) {
      const month = monthStart(
        month_on ?? workspaceDate(now(), "America/Los_Angeles"),
      );
      const currentMonth = monthStart(
        workspaceDate(now(), "America/Los_Angeles"),
      );
      const data = budget(month);
      delete data.groups;
      const demoAvailableCategories = demoBudgetCategories();
      if (include_available_categories) {
        data.available_categories = demoAvailableCategories.map(
          (category) => ({
            ...category,
            budget_version:
              budgetVersions.get(category.name) ?? 0,
          }),
        );
      }
      data.settings_version = budgetSettingsVersion;
      data.income_category_ids = incomeCategoryIds;
      data.average_monthly_income = {
        amount_minor: 930_000,
        currency: "USD",
      };
      data.actual_income = {
        amount_minor: 930_000,
        currency: "USD",
      };
      data.estimated_leftover = {
        amount_minor:
          930_000 - data.planned_total.amount_minor,
        currency: "USD",
      };
      data.actual_leftover = {
        amount_minor: 930_000 - data.actual_total.amount_minor,
        currency: "USD",
      };
      data.plan_status =
        data.estimated_leftover.amount_minor < 0 ||
        data.over_budget_category_count
          ? "needs_attention"
          : "on_track";
      data.is_current_month = month === currentMonth;
      data.has_exact_month_lines =
        month < currentMonth && budgetMonths.has(month);
      data.standing_effective_month_on =
        month > currentMonth ? month : currentMonth;
      data.source = data.has_exact_month_lines
        ? "month"
        : "standing";
      return {
        data,
        ...freshness,
        warnings: [],
        title: "Monthly budget",
        subtitle: month.slice(0, 7),
        source: { label: "Money", url: "/plan#budget" },
        summary: "Monthly actuals are compared with a standing plan that persists until edited.",
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
        source: { label: "Money", url: "/plan#goals" },
        summary: "Scenario calculated from explicit contributions and market assumptions.",
      };
    },

    async getPlanningOverview({ month_on = null } = {}) {
      const safeToSpend = state();
      const history = goalCatalog(safeToSpend);
      const budgetStatus = await service.getBudgetStatus({
        month_on,
        include_available_categories: true,
      });
      const previousBudgetStatus = await service.getBudgetStatus({
        month_on: previousMonth(budgetStatus.data.month_on),
      });
      return {
        safeToSpend,
        goals: safeToSpend.goals,
        archivedGoals: history.archivedGoals,
        historyInsights: history.historyInsights,
        budget: budgetStatus.data,
        previousBudget: previousBudgetStatus.data,
        scheduleRuns,
        auditEvents,
        alerts: safeToSpend.alerts,
        freshness: freshness.data_as_of,
      };
    },

    async getTransactionSplit({ transaction_id }) {
      return {
        transaction_id,
        split_version:
          transactionSplitVersions.get(transaction_id) ?? 0,
        lines: structuredClone(
          transactionSplits.get(transaction_id) ?? [],
        ),
      };
    },

    async getTransactionGoalSpending({ transaction_id }) {
      const transaction = demoTransactions.get(transaction_id);
      if (!transaction) throw demoNotFound("Transaction not found.");
      const goalSpends = structuredClone(
        transactionGoalSpends.get(transaction_id) ?? [],
      ).map((spend) => {
        const goal = findGoal(goals, spend.goal_id);
        return {
          ...spend,
          goal_name: goal.name,
          goal_version: goal.version,
        };
      });
      const assignedMinor = goalSpends.reduce(
        (sum, spend) => sum + Number(spend.amount_minor),
        0,
      );
      const eligible =
        transaction.pending === false &&
        transaction.currency_code === "USD" &&
        transaction.amount_minor < 0 &&
        transaction.excluded_from_spending !== true;
      return {
        data: {
          transaction_id,
          goal_spend_version:
            transactionGoalSpendVersions.get(transaction_id) ?? 0,
          goal_spends: goalSpends,
          assigned: {
            amount_minor: assignedMinor,
            currency: "USD",
          },
          remaining: {
            amount_minor: Math.max(
              0,
              Math.abs(transaction.amount_minor) - assignedMinor,
            ),
            currency: "USD",
          },
          eligible,
          ineligible_reason: eligible
            ? null
            : transaction.pending
              ? "Pending transactions cannot be spent from a goal."
              : transaction.amount_minor >= 0
                ? "Only posted outflows can be spent from a goal."
                : "This transaction cannot be spent from a goal.",
        },
        ...freshness,
        warnings: [],
        title: "Transaction goal spending",
        subtitle: `${goalSpends.length} goal allocation${
          goalSpends.length === 1 ? "" : "s"
        }`,
        source: {
          label: "Money",
          url: `/transactions?transaction=${encodeURIComponent(transaction_id)}`,
        },
        summary: goalSpends.length
          ? "This transaction is spent from a finance goal."
          : "This transaction is not currently spent from a finance goal.",
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
        purpose: demoEnum(
          input.purpose ?? "other",
          GOAL_PURPOSES,
          "purpose",
        ),
        status: "active",
        archived_at: null,
        archive_outcome: null,
        version: 1,
        allocations: [],
        recorded_allocations: [],
        spending: [],
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
      if (goal.status !== "active") {
        throw demoConflict("Archived goals cannot be edited.");
      }
      const before = structuredClone(goal);
      if (input.name != null) goal.name = String(input.name).trim();
      if (input.target_amount_minor != null) {
        const nextTarget = Number(input.target_amount_minor);
        if (nextTarget < demoRecordedFunding(goal)) {
          throw demoConflict(
            "The target cannot be lower than the amount already funded or spent.",
          );
        }
        goal.target_amount_minor = nextTarget;
      }
      if (Object.hasOwn(input, "target_on")) {
        goal.target_on = input.target_on || null;
      }
      if (Object.hasOwn(input, "purpose")) {
        goal.purpose = demoEnum(
          input.purpose,
          GOAL_PURPOSES,
          "purpose",
        );
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
      const delta =
        (input.direction ?? "allocate") === "release"
          ? -Number(input.amount_minor)
          : Number(input.amount_minor);
      const proposedAmount = allocation.amount_minor + delta;
      if (proposedAmount < 0) {
        throw demoConflict("The release exceeds the earmarked amount.");
      }
      if (
        demoRecordedFunding(goal) + delta >
        goal.target_amount_minor
      ) {
        throw demoConflict(
          "The allocation would exceed the goal target.",
        );
      }
      if (!goal.allocations.includes(allocation)) {
        goal.allocations.push(allocation);
      }
      allocation.amount_minor = proposedAmount;
      const recorded = demoSourceAmount(
        goal.recorded_allocations,
        source,
      );
      if (!goal.recorded_allocations.includes(recorded)) {
        goal.recorded_allocations.push(recorded);
      }
      recorded.amount_minor += delta;
      syncDemoLiveEarmarks(goal);
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

    async spendFromFinanceGoal(input, actorInput) {
      const transaction = demoTransactions.get(input.transaction_id);
      if (!transaction) throw demoNotFound("Transaction not found.");
      if (transaction.pending) {
        throw demoConflict(
          "Pending transactions cannot be spent from a goal.",
        );
      }
      if (
        transaction.currency_code !== "USD" ||
        transaction.amount_minor >= 0
      ) {
        throw demoConflict(
          "Only posted USD outflows can be spent from a goal.",
        );
      }
      const currentTransactionVersion =
        transactionGoalSpendVersions.get(input.transaction_id) ?? 0;
      if (
        currentTransactionVersion !==
        Number(input.expected_transaction_version)
      ) {
        throw demoConflict(
          "The transaction goal allocations changed; refresh and try again.",
        );
      }
      const goal = findGoal(goals, input.goal_id);
      assertVersion(goal, input.expected_goal_version);
      if (goal.status !== "active") {
        throw demoConflict("Archived goals cannot fund transactions.");
      }
      const amount = Number(input.amount_minor);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw demoConflict("amount_minor must be a positive integer.");
      }
      const existing = transactionGoalSpends.get(input.transaction_id) ?? [];
      const assignedMinor = existing.reduce(
        (sum, spend) => sum + Number(spend.amount_minor),
        0,
      );
      if (
        assignedMinor + amount >
        Math.abs(transaction.amount_minor)
      ) {
        throw demoConflict(
          "Goal spending cannot exceed the transaction amount.",
        );
      }
      const before = structuredClone(existing);
      const matching = existing.find(
        (spend) =>
          spend.goal_id === goal.id &&
          spend.source === input.source,
      );
      if (matching) {
        matching.amount_minor += amount;
      } else {
        existing.push({
          id: `goal_spend_${randomUUID()}`,
          transaction_id: input.transaction_id,
          line_index: existing.length,
          goal_id: goal.id,
          source: input.source,
          amount_minor: amount,
        });
      }
      const spending =
        goal.spending.find(
          (entry) => entry.source === input.source,
        ) ?? { source: input.source, amount_minor: 0 };
      if (!goal.spending.includes(spending)) {
        goal.spending.push(spending);
      }
      spending.amount_minor += amount;
      syncDemoLiveEarmarks(goal);
      goal.version += 1;
      transactionGoalSpends.set(input.transaction_id, existing);
      transactionGoalSpendVersions.set(
        input.transaction_id,
        currentTransactionVersion + 1,
      );
      const after = structuredClone(existing);
      const auditId = audit(
        "goal.transaction_spent",
        "transaction",
        input.transaction_id,
        actor(actorInput),
        before,
        after,
      );
      return change(
        "Spent from goal",
        {
          before,
          after,
          goal_spends: after,
          goal_spend_version: currentTransactionVersion + 1,
          goals: [
            {
              id: goal.id,
              version: goal.version,
              status: goal.status,
            },
          ],
        },
        auditId,
      );
    },

    async reverseGoalSpend(input, actorInput) {
      const existing =
        transactionGoalSpends.get(input.transaction_id) ?? [];
      const spendIndex = existing.findIndex(
        (spend) => spend.id === input.goal_spend_id,
      );
      if (spendIndex < 0) throw demoNotFound("Goal spend not found.");
      const currentTransactionVersion =
        transactionGoalSpendVersions.get(input.transaction_id) ?? 0;
      if (
        currentTransactionVersion !==
        Number(input.expected_transaction_version)
      ) {
        throw demoConflict(
          "The transaction goal allocations changed; refresh and try again.",
        );
      }
      const spend = existing[spendIndex];
      const goal = findGoal(goals, spend.goal_id);
      assertVersion(goal, input.expected_goal_version);
      const before = structuredClone(existing);
      existing.splice(spendIndex, 1);
      existing.forEach((entry, index) => {
        entry.line_index = index;
      });
      const spending = goal.spending.find(
        (entry) => entry.source === spend.source,
      );
      if (spending) spending.amount_minor -= spend.amount_minor;
      goal.spending = goal.spending.filter(
        (entry) => entry.amount_minor > 0,
      );
      syncDemoLiveEarmarks(goal);
      if (goal.status === "archived") {
        goal.status = "active";
        goal.archived_at = null;
        goal.archive_outcome = null;
      }
      goal.version += 1;
      transactionGoalSpends.set(input.transaction_id, existing);
      transactionGoalSpendVersions.set(
        input.transaction_id,
        currentTransactionVersion + 1,
      );
      const after = structuredClone(existing);
      const auditId = audit(
        "goal.transaction_spend_reversed",
        "transaction",
        input.transaction_id,
        actor(actorInput),
        before,
        after,
      );
      return change(
        "Goal spend reversed",
        {
          before,
          after,
          goal_spends: after,
          goal_spend_version: currentTransactionVersion + 1,
          goals: [
            {
              id: goal.id,
              version: goal.version,
              status: goal.status,
            },
          ],
        },
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

    async finishFinanceGoal(input, actorInput) {
      const goal = findGoal(goals, input.goal_id);
      assertVersion(goal, input.expected_version);
      if (goal.status !== "active") {
        throw demoConflict("Only active goals can be finished.");
      }
      const before = structuredClone(goal);
      goal.status = "archived";
      goal.archived_at = now().toISOString();
      goal.archive_outcome = demoEnum(
        input.outcome ?? "completed",
        GOAL_ARCHIVE_OUTCOMES,
        "outcome",
      );
      goal.allocations = [];
      for (const schedule of goal.schedules) {
        if (schedule.status === "active") {
          schedule.status = "paused";
          schedule.version += 1;
        }
      }
      goal.version += 1;
      const auditId = audit(
        "goal.finished",
        "goal",
        goal.id,
        actor(actorInput),
        before,
        goal,
      );
      return change(
        "Goal finished",
        { before, after: goal, goal },
        auditId,
      );
    },

    async setCategoryBudget(input, actorInput) {
      return service.setCategoryBudgets(
        { lines: [input] },
        actorInput,
      );
    },

    async setCategoryBudgets(input, actorInput) {
      if (
        !Array.isArray(input.lines) ||
        input.lines.length < 1 ||
        input.lines.length > 100
      ) {
        throw demoBadRequest(
          "lines must contain between 1 and 100 budgets.",
        );
      }
      const month = monthStart(
        workspaceDate(now(), "America/Los_Angeles"),
      );
      const requested = new Map();
      for (const line of input.lines) {
        const category =
          line.category ??
          demoBudgetCategoryName(line.category_id) ??
          line.category_id;
        if (!demoBudgetCategories().some(
          (candidate) => candidate.name === category,
        )) {
          throw demoBadRequest("Budget category not found.");
        }
        if (requested.has(category)) {
          throw demoBadRequest(
            "A budget category can only appear once.",
          );
        }
        const currentVersion = budgetVersions.get(category) ?? 0;
        if (currentVersion !== Number(line.expected_version)) {
          throw demoConflict(
            "The planning record changed; refresh and try again.",
          );
        }
        const requestedSubtree = new Set(
          demoBudgetDescendantNames(category),
        );
        if (
          incomeCategoryIds.some((categoryId) => {
            const incomeName = demoBudgetCategoryName(categoryId);
            return (
              requestedSubtree.has(incomeName) ||
              demoBudgetDescendantNames(incomeName).includes(category)
            );
          })
        ) {
          throw demoBadRequest(
            "An income category cannot also be an expense budget.",
          );
        }
        requested.set(category, {
          category,
          amount_minor: Number(line.amount_minor),
          tracking_mode: line.tracking_mode ?? "tracked",
          expected_version: currentVersion,
        });
      }

      const desired = new Map(
        [...budgetDefaults.entries()].map(([category, amount]) => [
          category,
          {
            category,
            amount_minor: amount,
            tracking_mode:
              budgetModes.get(category) ?? "tracked",
          },
        ]),
      );
      for (const [category, line] of requested) {
        desired.set(category, line);
      }
      const ancestors = new Set();
      for (const category of requested.keys()) {
        let parent = demoBudgetParentName(category);
        while (parent) {
          ancestors.add(parent);
          if (!desired.has(parent)) {
            desired.set(parent, {
              category: parent,
              amount_minor: 0,
              tracking_mode: "tracked",
            });
          }
          parent = demoBudgetParentName(parent);
        }
      }
      const parentsToEvaluate = new Set(ancestors);
      for (const category of requested.keys()) {
        if (
          [...desired.values()].some(
            (line) =>
              demoBudgetParentName(line.category) === category,
          )
        ) {
          parentsToEvaluate.add(category);
        }
      }
      const adjustedParents = [];
      for (const parent of [...parentsToEvaluate].sort(
        (left, right) =>
          demoBudgetDepth(right) - demoBudgetDepth(left),
      )) {
        const childTotal = [...desired.values()]
          .filter(
            (line) =>
              demoBudgetParentName(line.category) === parent,
          )
          .reduce(
            (sum, line) => sum + Number(line.amount_minor),
            0,
          );
        const parentLine = desired.get(parent);
        if (
          requested.has(parent) &&
          parentLine.amount_minor < childTotal
        ) {
          throw demoBadRequest(
            `${parent} cannot be lower than its child allocation total.`,
          );
        }
        if (parentLine.amount_minor < childTotal) {
          parentLine.amount_minor = childTotal;
          adjustedParents.push(parent);
        }
      }

      const changedNames = new Set(requested.keys());
      for (const parent of ancestors) {
        if (
          !budgetDefaults.has(parent) ||
          budgetDefaults.get(parent) !==
            desired.get(parent).amount_minor
        ) {
          changedNames.add(parent);
        }
      }
      const changes = [];
      let auditId = null;
      for (const category of changedNames) {
        const line = desired.get(category);
        const currentVersion = budgetVersions.get(category) ?? 0;
        const before = budgetDefaults.has(category)
          ? {
              category,
              amount_minor: budgetDefaults.get(category),
              version: currentVersion,
            }
          : null;
        budgetDefaults.set(category, Number(line.amount_minor));
        budgetModes.set(category, line.tracking_mode);
        const nextVersion = currentVersion + 1;
        budgetVersions.set(category, nextVersion);
        const after = {
          category,
          category_id: demoBudgetCategoryId(category),
          amount_minor: Number(line.amount_minor),
          tracking_mode: line.tracking_mode,
          version: nextVersion,
        };
        auditId = audit(
          "budget.standing_set",
          "budget_line",
          `${month}:${category}`,
          actor(actorInput),
          before,
          after,
        );
        changes.push({ before, after, line: after });
      }
      const response = change(
        input.lines.length === 1
          ? "Budget saved"
          : "Budgets saved",
        {
          before: changes.map((entry) => entry.before),
          after: changes.map((entry) => entry.after),
          lines: changes.map((entry) => entry.line),
          adjusted_parent_ids: adjustedParents.map(
            demoBudgetCategoryId,
          ),
        },
        auditId,
      );
      response.budget = (
        await service.getBudgetStatus({
          include_available_categories: true,
        })
      ).data;
      return response;
    },

    async clearCategoryBudget(input, actorInput) {
      const category =
        demoBudgetCategoryName(input.category_id) ?? input.category_id;
      const descendantNames = demoBudgetDescendantNames(category).filter(
        (name) => name !== category && budgetDefaults.has(name),
      );
      if (
        descendantNames.length &&
        input.confirm_descendants !== true
      ) {
        throw demoBadRequest(
          `Confirm removal of descendant budgets: ${descendantNames
            .map(
              (name) =>
                demoBudgetCategories().find(
                  (candidate) => candidate.name === name,
                )?.path ?? name,
            )
            .join(", ")}.`,
        );
      }
      const currentVersion = budgetVersions.get(category) ?? 0;
      if (currentVersion !== Number(input.expected_version)) {
        throw demoConflict(
          "The planning record changed; refresh and try again.",
        );
      }
      const before = budgetDefaults.has(category)
        ? {
            category,
            amount_minor: budgetDefaults.get(category),
            version: currentVersion,
          }
        : null;
      budgetDefaults.delete(category);
      budgetModes.delete(category);
      budgetVersions.set(category, currentVersion + 1);
      for (const descendant of descendantNames) {
        budgetDefaults.delete(descendant);
        budgetModes.delete(descendant);
        budgetVersions.set(
          descendant,
          (budgetVersions.get(descendant) ?? 0) + 1,
        );
      }
      const auditId = audit(
        "budget.standing_removed",
        "budget_line",
        category,
        actor(actorInput),
        before,
        null,
      );
      return change("Budget removed", { before, after: null }, auditId);
    },

    async setBudgetIncomeCategories(input, actorInput) {
      if (budgetSettingsVersion !== Number(input.expected_version)) {
        throw demoConflict(
          "The planning record changed; refresh and try again.",
        );
      }
      const before = {
        income_category_ids: incomeCategoryIds,
        version: budgetSettingsVersion,
      };
      const nextIncomeCategoryIds = [
        ...new Set(input.income_category_ids),
      ];
      const selectedIncomeNames = new Set(
        nextIncomeCategoryIds.flatMap((categoryId) =>
          demoBudgetDescendantNames(
            demoBudgetCategoryName(categoryId),
          ),
        ),
      );
      if (
        [...budgetDefaults.keys()].some(
          (budgetName) =>
            selectedIncomeNames.has(budgetName) ||
            nextIncomeCategoryIds.some((categoryId) =>
              demoBudgetDescendantNames(budgetName).includes(
                demoBudgetCategoryName(categoryId),
              ),
            ),
        )
      ) {
        throw demoBadRequest(
          "Remove a category from the expense budget before using it as income.",
        );
      }
      incomeCategoryIds = nextIncomeCategoryIds;
      budgetSettingsVersion += 1;
      const after = {
        income_category_ids: incomeCategoryIds,
        version: budgetSettingsVersion,
      };
      const auditId = audit(
        "budget.income_categories_set",
        "budget_settings",
        "shared",
        actor(actorInput),
        before,
        after,
      );
      return change("Income categories saved", { before, after }, auditId);
    },

    async splitTransaction(_input, actorInput) {
      const currentVersion =
        transactionSplitVersions.get(_input.transaction_id) ?? 0;
      if (currentVersion !== Number(_input.expected_version)) {
        throw demoConflict(
          "The planning record changed; refresh and try again.",
        );
      }
      const before = structuredClone(
        transactionSplits.get(_input.transaction_id) ?? [],
      );
      const nextVersion = currentVersion + 1;
      transactionSplits.set(
        _input.transaction_id,
        structuredClone(_input.lines ?? []).map((line) => ({
          ...line,
          split_version: nextVersion,
        })),
      );
      transactionSplitVersions.set(
        _input.transaction_id,
        nextVersion,
      );
      const after = structuredClone(
        transactionSplits.get(_input.transaction_id) ?? [],
      );
      const auditId = audit(
        "transaction.splits_replaced",
        "transaction",
        _input.transaction_id,
        actor(actorInput),
        before,
        after,
      );
      return change(
        _input.lines?.length
          ? "Transaction split saved"
          : "Transaction split cleared",
        {
          before,
          after,
          splits: after,
          split_version: nextVersion,
        },
        auditId,
      );
    },

    async executeIdempotentWrite(operation, input, actorInput) {
      const methods = {
        create_finance_goal: "createFinanceGoal",
        update_finance_goal: "updateFinanceGoal",
        allocate_finance_goal: "allocateFinanceGoal",
        spend_from_finance_goal: "spendFromFinanceGoal",
        reverse_goal_spend: "reverseGoalSpend",
        set_goal_funding_schedule: "setGoalFundingSchedule",
        finish_finance_goal: "finishFinanceGoal",
        set_category_budget: "setCategoryBudget",
        set_category_budgets: "setCategoryBudgets",
        clear_category_budget: "clearCategoryBudget",
        set_budget_income_categories: "setBudgetIncomeCategories",
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

function demoRecordedFunding(goal) {
  const recorded = Array.isArray(goal.recorded_allocations)
    ? goal.recorded_allocations
    : [...(goal.allocations ?? []), ...(goal.spending ?? [])];
  return recorded.reduce(
    (sum, entry) => sum + Number(entry.amount_minor),
    0,
  );
}

function demoSourceAmount(entries, source) {
  return (
    entries.find((entry) => entry.source === source) ?? {
      source,
      amount_minor: 0,
    }
  );
}

function syncDemoLiveEarmarks(goal) {
  const cashRecorded = Number(
    demoSourceAmount(goal.recorded_allocations, "cash")
      .amount_minor,
  );
  const brokerageRecorded = Number(
    demoSourceAmount(goal.recorded_allocations, "brokerage")
      .amount_minor,
  );
  const cashSpent = Number(
    demoSourceAmount(goal.spending, "cash").amount_minor,
  );
  const brokerageSpent = Number(
    demoSourceAmount(goal.spending, "brokerage").amount_minor,
  );
  const remaining = {
    cash: Math.max(
      0,
      cashRecorded -
        cashSpent -
        Math.max(0, brokerageSpent - brokerageRecorded),
    ),
    brokerage: Math.max(
      0,
      brokerageRecorded -
        brokerageSpent -
        Math.max(0, cashSpent - cashRecorded),
    ),
  };
  for (const source of ["cash", "brokerage"]) {
    const allocation = demoSourceAmount(goal.allocations, source);
    if (!goal.allocations.includes(allocation)) {
      goal.allocations.push(allocation);
    }
    allocation.amount_minor = remaining[source];
  }
}

function demoEnum(value, allowed, name) {
  const normalized = String(value ?? "").trim();
  if (!allowed.has(normalized)) {
    throw demoConflict(`${name} is invalid.`);
  }
  return normalized;
}

function demoReadEnum(value, allowed, name) {
  const normalized = String(value ?? "").trim();
  if (!allowed.has(normalized)) {
    throw demoBadRequest(`${name} is invalid.`);
  }
  return normalized;
}

function demoReadInteger(value, minimum, maximum, name) {
  const normalized = Number(value);
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < minimum ||
    normalized > maximum
  ) {
    throw demoBadRequest(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return normalized;
}

function parseDemoGoalCursor(value) {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^goal\.[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw demoBadRequest("cursor is invalid.");
  }
  const encoded = value.slice("goal.".length);
  let decoded;
  let parsed;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) {
      throw new TypeError("Non-canonical cursor.");
    }
    parsed = JSON.parse(decoded);
  } catch {
    throw demoBadRequest("cursor is invalid.");
  }
  if (
    parsed == null ||
    Array.isArray(parsed) ||
    typeof parsed !== "object" ||
    Object.keys(parsed).sort().join(",") !==
      "offset,purpose,status,v" ||
    parsed.v !== 1 ||
    !Number.isSafeInteger(parsed.offset) ||
    parsed.offset < 0 ||
    !GOAL_LIST_STATUSES.has(parsed.status) ||
    !(
      parsed.purpose === null ||
      GOAL_PURPOSES.has(parsed.purpose)
    )
  ) {
    throw demoBadRequest("cursor is invalid.");
  }
  return {
    offset: parsed.offset,
    status: parsed.status,
    purpose: parsed.purpose,
  };
}

function encodeDemoGoalCursor({ offset, status, purpose }) {
  return `goal.${Buffer.from(
    JSON.stringify({
      v: 1,
      offset,
      status,
      purpose: purpose ?? null,
    }),
    "utf8",
  ).toString("base64url")}`;
}

function compareDemoArchivedGoals(left, right) {
  const leftArchivedAt = String(left.archived_at ?? "");
  const rightArchivedAt = String(right.archived_at ?? "");
  return (
    rightArchivedAt.localeCompare(leftArchivedAt) ||
    left.id.localeCompare(right.id)
  );
}

function boundedDemoGoalHistoryInsights(insights) {
  return insights.map((insight) => {
    const evidenceGoalIds = insight.evidence_goal_ids.slice(0, 8);
    return {
      ...insight,
      evidence_goal_ids_truncated:
        insight.evidence_goal_ids.length > evidenceGoalIds.length,
      evidence_goal_ids: evidenceGoalIds,
    };
  });
}

function ensureBudgetMonth(months, month, defaults) {
  if (!months.has(month)) months.set(month, new Map(defaults));
  return months.get(month);
}

function compactPlanChange(changed) {
  if (Array.isArray(changed?.splits)) {
    const nextVersion = Number(changed.split_version ?? 0);
    return {
      before: splitChangeSummary(
        changed.before,
        Math.max(0, nextVersion - 1),
      ),
      after: splitChangeSummary(changed.after, nextVersion),
      split_version: nextVersion,
      audit_event_id: changed.audit_event_id ?? null,
    };
  }
  if (Array.isArray(changed?.goal_spends)) {
    const before = Array.isArray(changed.before)
      ? changed.before
      : [];
    const after = changed.goal_spends;
    const beforeByKey = new Map(
      before.map((line) => [goalSpendReceiptKey(line), line]),
    );
    const afterByKey = new Map(
      after.map((line) => [goalSpendReceiptKey(line), line]),
    );
    return {
      before: goalSpendChangeSummary(before),
      after: goalSpendChangeSummary(after),
      goal_spends: after
        .filter((line) => {
          const previous = beforeByKey.get(
            goalSpendReceiptKey(line),
          );
          return (
            !previous ||
            Number(previous.amount_minor) !==
              Number(line.amount_minor)
          );
        })
        .map(compactGoalSpend),
      reversed_goal_spend_ids: before
        .filter((line) => {
          const next = afterByKey.get(goalSpendReceiptKey(line));
          return (
            !next ||
            Number(next.amount_minor) !== Number(line.amount_minor)
          );
        })
        .map((line) => line.id),
      goal_spend_version: Number(
        changed.goal_spend_version ?? 0,
      ),
      goals: (changed.goals ?? []).map((goal) => ({
        id: goal.id,
        status: goal.status,
        version: Number(goal.version),
      })),
      audit_event_id: changed.audit_event_id ?? null,
    };
  }
  return changed;
}

function splitChangeSummary(lines, fallbackVersion) {
  const values = Array.isArray(lines) ? lines : [];
  return {
    line_count: values.length,
    total_amount_minor: values.reduce(
      (sum, line) => sum + Number(line.amount_minor ?? 0),
      0,
    ),
    split_version: Number(
      values[0]?.split_version ?? fallbackVersion,
    ),
  };
}

function goalSpendReceiptKey(line) {
  return `${line.goal_id}:${line.source}`;
}

function compactGoalSpend(line) {
  return {
    id: line.id,
    goal_id: line.goal_id,
    source: line.source,
    amount_minor: Number(line.amount_minor),
  };
}

function goalSpendChangeSummary(lines) {
  const values = Array.isArray(lines) ? lines : [];
  return {
    line_count: values.length,
    total_amount_minor: values.reduce(
      (sum, line) => sum + Number(line.amount_minor ?? 0),
      0,
    ),
  };
}

function previousMonth(monthOn) {
  const date = new Date(`${monthStart(monthOn)}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7) + "-01";
}

function demoBudgetCategoryId(name) {
  return `category_${String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")}`;
}

function demoBudgetCategories() {
  return [
    "Income",
    "Car",
    "Home",
    "Rent",
    "Housing",
    "Groceries",
    "Dining",
    "Shopping",
    "Travel",
    "Airlines",
    "Utilities",
    "Fees & Interest",
    "Other",
  ].map((name) => ({
    id: demoBudgetCategoryId(name),
    name,
    path:
      name === "Airlines"
        ? "Travel / Airlines"
        : name,
    parent_category_id:
      name === "Airlines"
        ? demoBudgetCategoryId("Travel")
        : name === "Rent" || name === "Utilities"
          ? demoBudgetCategoryId("Home")
        : null,
    is_system: name === "Other",
  }));
}

function demoBudgetCategoryName(categoryId) {
  return demoBudgetCategories().find(
    (category) => category.id === categoryId,
  )?.name;
}

function demoBudgetDescendantNames(name) {
  if (!name) return [];
  if (name === "Travel") return ["Travel", "Airlines"];
  if (name === "Home") return ["Home", "Rent", "Utilities"];
  return [name];
}

function demoBudgetParentName(name) {
  if (name === "Airlines") return "Travel";
  if (name === "Rent" || name === "Utilities") return "Home";
  return null;
}

function demoBudgetDepth(name) {
  let depth = 0;
  let current = name;
  while (demoBudgetParentName(current)) {
    depth += 1;
    current = demoBudgetParentName(current);
  }
  return depth;
}

function demoBadRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.status = 400;
  error.code = "invalid_request";
  error.expose = true;
  return error;
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
