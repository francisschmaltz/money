import { createHash, randomUUID } from "node:crypto";

import { formatMinorMoney } from "../currency.js";
import { money, shiftDateOnly } from "./analytics.js";
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

const DEFAULT_WORKSPACE_ID = "shared";
const DEFAULT_CURRENCY = "USD";
const GOAL_PURPOSES = Object.freeze([
  "vacation",
  "home",
  "vehicle",
  "education",
  "emergency",
  "event",
  "purchase",
  "other",
]);
const GOAL_ARCHIVE_OUTCOMES = Object.freeze([
  "completed",
  "cancelled",
]);
const IDEMPOTENT_WRITE_METHODS = Object.freeze({
  create_finance_goal: "createFinanceGoal",
  update_finance_goal: "updateFinanceGoal",
  allocate_finance_goal: "allocateFinanceGoal",
  spend_from_finance_goal: "spendFromFinanceGoal",
  reverse_goal_spend: "reverseGoalSpend",
  set_goal_funding_schedule: "setGoalFundingSchedule",
  finish_finance_goal: "finishFinanceGoal",
  set_category_budget: "setCategoryBudget",
  split_transaction: "splitTransaction",
});

export class PlanningService {
  #repository;
  #financeRepository;
  #workspaceId;
  #currency;
  #now;
  #baseUrl;

  constructor({
    repository,
    financeRepository,
    workspaceId = DEFAULT_WORKSPACE_ID,
    currency = DEFAULT_CURRENCY,
    now = () => new Date(),
    baseUrl = "https://money.example.com",
  } = {}) {
    if (!repository) throw new TypeError("repository is required");
    if (!financeRepository) {
      throw new TypeError("financeRepository is required");
    }
    this.#repository = repository;
    this.#financeRepository = financeRepository;
    this.#workspaceId = workspaceId;
    this.#currency = currency;
    this.#now = now;
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  async getSafeToSpend() {
    const state = await this.#planningState();
    return result({
      data: state.snapshot,
      freshness: state.freshness,
      title: "Safe to Spend",
      subtitle: `${state.snapshot.active_goal_count} active goal${
        state.snapshot.active_goal_count === 1 ? "" : "s"
      }`,
      path: "/plan",
      summary: `${formatMoney(state.snapshot.safe_to_spend)} is safe to spend after current card balances and cash-backed goals.`,
    });
  }

  async listFinanceGoals(input = {}) {
    const cursor = parseGoalCursor(input.cursor);
    const hasStatus =
      Object.hasOwn(input, "status") && input.status !== undefined;
    const hasPurpose =
      Object.hasOwn(input, "purpose") && input.purpose !== undefined;
    const suppliedStatus = hasStatus
      ? enumValue(
          input.status,
          ["active", "archived", "all"],
          "status",
        )
      : null;
    const suppliedPurpose = hasPurpose
      ? enumValue(input.purpose, GOAL_PURPOSES, "purpose")
      : null;
    if (
      cursor &&
      ((hasStatus && suppliedStatus !== cursor.status) ||
        (hasPurpose && suppliedPurpose !== cursor.purpose))
    ) {
      throw badRequest(
        "cursor does not match the requested goal filters.",
      );
    }
    const status = cursor?.status ?? suppliedStatus ?? "active";
    const purpose = cursor?.purpose ?? suppliedPurpose;
    const limit =
      input.limit === undefined
        ? 8
        : boundedInteger(input.limit, 1, 8, "limit");
    const offset = cursor?.offset ?? 0;
    const state = await this.#planningState({
      includeArchived: status !== "active",
    });
    const catalog = this.#goalCatalog(state);
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
    return result({
      data: {
        currency: this.#currency,
        goals: page,
        brokerage_backing_basis_points:
          state.snapshot.brokerage_backing_basis_points,
        taxable_brokerage_value:
          state.snapshot.taxable_brokerage_value,
        history_insights: boundedGoalHistoryInsights(
          scopedHistoryInsights,
        ),
        page_info: {
          returned_count: page.length,
          total_count: filtered.length,
          has_more: hasMore,
          next_cursor: hasMore
            ? encodeGoalCursor({
                offset: nextOffset,
                status,
                purpose,
              })
            : null,
        },
      },
      freshness: state.freshness,
      title: "Finance goals",
      subtitle: `${filtered.length} matching`,
      path: "/plan#goals",
      summary: `${page.length} of ${filtered.length} matching household goals returned.`,
    });
  }

  async getBudgetStatus({ month_on = null } = {}) {
    const timeZone = await this.#repository.getWorkspaceTimezone(
      this.#workspaceId,
    );
    const month = monthStart(
      month_on == null
        ? workspaceDate(this.#now(), timeZone)
        : requiredDate(month_on, "month_on"),
    );
    const currentMonth = monthStart(
      workspaceDate(this.#now(), timeZone),
    );
    const endOn = nextMonth(month);
    const [
      budgetLines,
      budgetVersions,
      transactions,
      splits,
      freshness,
    ] =
      await Promise.all([
        this.#repository.listResolvedBudgetLines(
          this.#workspaceId,
          month,
          null,
          { includeExact: month < currentMonth },
        ),
        typeof this.#repository.listBudgetCategoryVersions ===
        "function"
          ? this.#repository.listBudgetCategoryVersions(
              this.#workspaceId,
            )
          : [],
        this.#financeRepository.getTransactionsForPeriod(
          this.#workspaceId,
          { startOn: month, endOn },
        ),
        this.#repository.listTransactionSplits(this.#workspaceId, {
          startOn: month,
          endOn,
        }),
        this.#financeRepository.getDataFreshness(this.#workspaceId),
      ]);
    const data = buildBudgetStatus({
      monthOn: month,
      budgetLines,
      transactions,
      splits,
      currency: this.#currency,
    });
    const versionByCategory = new Map(
      budgetVersions.map((entry) => [
        entry.category,
        Number(entry.version),
      ]),
    );
    for (const line of data.lines) {
      line.version =
        versionByCategory.get(line.category) ?? line.version ?? 0;
    }
    data.has_exact_month_lines = budgetLines.some(
      (line) => line.exact_month,
    );
    data.standing_effective_month_on =
      month > currentMonth ? month : currentMonth;
    data.source = data.has_exact_month_lines
      ? "month"
      : budgetLines.length
        ? "standing"
        : "empty";
    return result({
      data,
      freshness,
      title: "Monthly budget",
      subtitle: formatMonth(month),
      path: "/plan#budget",
      summary: `${formatMoney(data.actual_total)} spent against ${formatMoney(data.planned_total)} planned for ${formatMonth(month)}; ${data.over_budget_category_count} categor${
        data.over_budget_category_count === 1 ? "y is" : "ies are"
      } over budget.`,
    });
  }

  async modelFinancePlan(input = {}) {
    const state = await this.#planningState();
    const goalId = optionalId(input.goal_id);
    if (
      goalId &&
      !state.snapshot.goals.some((goal) => goal.id === goalId)
    ) {
      throw notFound("Goal not found.");
    }
    const selectedGoal =
      state.snapshot.goals.find((goal) => goal.id === goalId) ??
      (goalId == null ? state.snapshot.goals[0] : null);
    const activeSchedules = (selectedGoal?.schedules ?? []).filter(
      (schedule) => schedule.status === "active",
    );
    const scheduledMonthlyMinor = activeSchedules
      .filter((schedule) => schedule.cadence === "monthly")
      .reduce(
        (sum, schedule) => sum + Number(schedule.amount_minor),
        0,
      );
    const scheduledBiweeklyMinor = activeSchedules
      .filter(
        (schedule) => schedule.cadence === "biweekly_friday",
      )
      .reduce(
        (sum, schedule) => sum + Number(schedule.amount_minor),
        0,
      );
    const additionalMonthlyMinor = nonnegativeMinor(
      input.monthly_contribution_minor ?? 0,
      "monthly_contribution_minor",
    );
    const additionalBiweeklyMinor = nonnegativeMinor(
      input.biweekly_contribution_minor ?? 0,
      "biweekly_contribution_minor",
    );
    const modeledMonthlyMinor = nonnegativeMinor(
      scheduledMonthlyMinor + additionalMonthlyMinor,
      "scheduled plus monthly_contribution_minor",
    );
    const modeledBiweeklyMinor = nonnegativeMinor(
      scheduledBiweeklyMinor + additionalBiweeklyMinor,
      "scheduled plus biweekly_contribution_minor",
    );
    const scenario = modelPlanningScenario({
      snapshot: state.snapshot,
      goalId,
      monthlyContributionMinor: modeledMonthlyMinor,
      biweeklyContributionMinor: modeledBiweeklyMinor,
      oneTimeContributionMinor: nonnegativeMinor(
        input.one_time_contribution_minor ?? 0,
        "one_time_contribution_minor",
      ),
      brokerageChangeBasisPoints: boundedInteger(
        input.brokerage_change_basis_points ?? 0,
        -10_000,
        100_000,
        "brokerage_change_basis_points",
      ),
      asOf: this.#now(),
    });
    scenario.scheduled_monthly_contribution = money(
      scheduledMonthlyMinor,
      this.#currency,
    );
    scenario.scheduled_biweekly_contribution = money(
      scheduledBiweeklyMinor,
      this.#currency,
    );
    scenario.additional_monthly_contribution = money(
      additionalMonthlyMinor,
      this.#currency,
    );
    scenario.additional_biweekly_contribution = money(
      additionalBiweeklyMinor,
      this.#currency,
    );
    if (activeSchedules.length > 0) {
      scenario.assumptions.unshift(
        "Active goal funding schedules continue alongside scenario contributions.",
      );
    }
    return result({
      data: scenario,
      freshness: state.freshness,
      title: "Finance plan scenario",
      subtitle: scenario.goal_name ?? "Household",
      path: "/plan#goals",
      summary:
        scenario.months_to_target == null
          ? "The selected contributions do not reach the goal because no recurring contribution was supplied."
          : `${scenario.goal_name ?? "The goal"} reaches its target in approximately ${scenario.months_to_target} month${scenario.months_to_target === 1 ? "" : "s"} under the supplied assumptions.`,
    });
  }

  async getTransactionSplit({ transaction_id } = {}) {
    const transactionId = requiredId(
      transaction_id,
      "transaction_id",
    );
    const [transaction, lines] = await Promise.all([
      this.#financeRepository.getTransaction(
        this.#workspaceId,
        transactionId,
      ),
      this.#repository.listTransactionSplits(
        this.#workspaceId,
        { transactionIds: [transactionId] },
      ),
    ]);
    if (!transaction) throw notFound("Transaction not found.");
    return {
      transaction_id: transactionId,
      split_version: Number(transaction.split_version ?? 0),
      lines,
    };
  }

  async getTransactionGoalSpending({ transaction_id } = {}) {
    const transactionId = requiredId(
      transaction_id,
      "transaction_id",
    );
    const [transaction, goalSpending, goals, freshness] =
      await Promise.all([
        this.#financeRepository.getTransaction(
          this.#workspaceId,
          transactionId,
        ),
        this.#repository.getTransactionGoalSpending(
          this.#workspaceId,
          transactionId,
        ),
        this.#repository.listGoals(this.#workspaceId, {
          includeArchived: true,
        }),
        this.#financeRepository.getDataFreshness(this.#workspaceId),
      ]);
    if (!transaction || !goalSpending) {
      throw notFound("Transaction not found.");
    }
    const goalById = new Map(
      goals.map((goal) => [goal.id, goal]),
    );
    const goalSpends = (goalSpending.goal_spends ?? []).map(
      (spend) => {
        const goal = goalById.get(spend.goal_id);
        return {
          ...spend,
          goal_name: goal?.name ?? spend.goal_name ?? "Archived goal",
          goal_version:
            goal?.version ?? Number(spend.goal_version ?? 0),
        };
      },
    );
    const assignedMinor = goalSpends.reduce(
      (sum, spend) => sum + Number(spend.amount_minor),
      0,
    );
    const providerAmountMinor = Number(
      transaction.provider_amount_minor ?? transaction.amount_minor,
    );
    const eligible =
      transaction.pending === false &&
      transaction.currency_code === this.#currency &&
      providerAmountMinor < 0 &&
      transaction.excluded_from_spending !== true;
    const data = {
      transaction_id: transactionId,
      goal_spend_version: Number(
        goalSpending.goal_spend_version ??
          transaction.goal_spend_version ??
          0,
      ),
      goal_spends: goalSpends,
      assigned: money(assignedMinor, this.#currency),
      remaining: money(
        Math.max(0, Math.abs(providerAmountMinor) - assignedMinor),
        this.#currency,
      ),
      eligible,
      ineligible_reason: eligible
        ? null
        : goalSpendIneligibleReason(transaction, providerAmountMinor),
    };
    return result({
      data,
      freshness,
      title: "Transaction goal spending",
      subtitle: `${goalSpends.length} goal allocation${
        goalSpends.length === 1 ? "" : "s"
      }`,
      path: `/transactions?transaction=${encodeURIComponent(transactionId)}`,
      summary: goalSpends.length
        ? `${formatMoney(data.assigned)} of this transaction is spent from finance goals.`
        : "This transaction is not currently spent from a finance goal.",
    });
  }

  async getPlanningOverview({ month_on = null } = {}) {
    const [
      safe,
      budget,
      goalState,
      scheduleRuns,
      auditEvents,
    ] = await Promise.all([
      this.getSafeToSpend(),
      this.getBudgetStatus({ month_on }),
      this.#planningState({ includeArchived: true }),
      this.#repository.listGoalScheduleRuns(this.#workspaceId, {
        limit: 20,
      }),
      this.#repository.listAuditEvents(this.#workspaceId, { limit: 30 }),
    ]);
    const previousBudget = await this.getBudgetStatus({
      month_on: previousMonth(budget.data.month_on),
    });
    const scheduleAlerts = scheduleRuns
      .filter((run) => run.status === "skipped_brokerage_capacity")
      .map((run) => ({
        code: "goal_schedule_missed",
        severity: "warning",
        goal_id: run.goal_id,
        due_on: run.due_on,
        message: "A brokerage goal allocation was skipped because the source was fully earmarked.",
      }));
    const budgetAlerts = budget.data.lines
      .filter((line) => line.over.amount_minor > 0)
      .map((line) => ({
        code: "budget_overspent",
        severity: "warning",
        category: line.category,
        message: `${line.category} is ${formatMoney(line.over)} over its ${formatMonth(budget.data.month_on)} plan.`,
      }));
    const goalCatalog = this.#goalCatalog(goalState);
    return {
      safeToSpend: safe.data,
      goals: safe.data.goals,
      archivedGoals: goalCatalog.archivedGoals,
      historyInsights: goalCatalog.historyInsights,
      budget: budget.data,
      previousBudget: previousBudget.data,
      scheduleRuns,
      auditEvents,
      alerts: [
        ...safe.data.alerts,
        ...scheduleAlerts,
        ...budgetAlerts,
      ],
      freshness: safe.data_as_of,
    };
  }

  async createFinanceGoal(input = {}, actorInput = null) {
    const actor = normalizeActor(actorInput);
    const name = requiredText(input.name, 120, "name");
    const targetAmountMinor = positiveMinor(
      input.target_amount_minor,
      "target_amount_minor",
    );
    const targetOn = optionalDate(input.target_on);
    const created = await this.#repository.createGoal(
      this.#workspaceId,
      {
        id: `goal_${randomUUID()}`,
        name,
        target_amount_minor: targetAmountMinor,
        currency_code: "USD",
        target_on: targetOn,
        purpose: enumValue(
          input.purpose ?? "other",
          GOAL_PURPOSES,
          "purpose",
        ),
        audit_event_id: `audit_${randomUUID()}`,
      },
      actor,
    );
    return this.#changeResult("Goal created", created);
  }

  async updateFinanceGoal(input = {}, actorInput = null) {
    const actor = normalizeActor(actorInput);
    const goalId = requiredId(input.goal_id, "goal_id");
    const expectedVersion = positiveInteger(
      input.expected_version,
      "expected_version",
    );
    const changes = {};
    if (Object.hasOwn(input, "name")) {
      changes.name = requiredText(input.name, 120, "name");
    }
    if (Object.hasOwn(input, "target_amount_minor")) {
      changes.target_amount_minor = positiveMinor(
        input.target_amount_minor,
        "target_amount_minor",
      );
    }
    if (Object.hasOwn(input, "target_on")) {
      changes.target_on = optionalDate(input.target_on);
    }
    if (Object.hasOwn(input, "purpose")) {
      changes.purpose = enumValue(
        input.purpose,
        GOAL_PURPOSES,
        "purpose",
      );
    }
    if (Object.keys(changes).length === 0) {
      throw badRequest("At least one goal field must change.");
    }
    const current = await this.#repository.getGoal(
      this.#workspaceId,
      goalId,
    );
    if (!current) throw notFound("Goal not found.");
    if (current.status !== "active") {
      throw conflict("Archived goals cannot be edited.");
    }
    const recorded = totalRecordedFunding(current);
    if (
      changes.target_amount_minor != null &&
      changes.target_amount_minor < recorded
    ) {
      throw conflict(
        "The target cannot be lower than the amount already funded or spent.",
      );
    }
    const updated = await this.#repository.updateGoal(
      this.#workspaceId,
      goalId,
      changes,
      expectedVersion,
      actor,
      { auditEventId: `audit_${randomUUID()}` },
    );
    assertMutation(updated);
    return this.#changeResult("Goal updated", updated);
  }

  async allocateFinanceGoal(input = {}, actorInput = null) {
    const actor = normalizeActor(actorInput);
    const goalId = requiredId(input.goal_id, "goal_id");
    const source = enumValue(
      input.source,
      ["cash", "brokerage"],
      "source",
    );
    const direction = enumValue(
      input.direction ?? "allocate",
      ["allocate", "release"],
      "direction",
    );
    const amount = positiveMinor(input.amount_minor, "amount_minor");
    const expectedVersion = positiveInteger(
      input.expected_version,
      "expected_version",
    );
    const idempotencyKey = optionalText(
      input.idempotency_key,
      160,
      "idempotency_key",
    );
    const delta = direction === "allocate" ? amount : -amount;
    const applyAllocation = async (client = null) => {
      const current = await this.#repository.getGoal(
        this.#workspaceId,
        goalId,
      );
      if (!current) throw notFound("Goal not found.");
      if (current.status !== "active") {
        throw conflict("Archived goals cannot receive allocations.");
      }
      const currentSource = sourceEarmarked(current, source);
      if (currentSource + delta < 0) {
        throw conflict("The release exceeds the goal's earmarked amount.");
      }
      if (
        totalRecordedFunding(current) + delta >
        current.target_amount_minor
      ) {
        throw conflict("The allocation would exceed the goal target.");
      }
      if (source === "brokerage" && delta > 0) {
        const available = await this.#brokerageAvailability(client);
        if (delta > available) {
          throw conflict(
            "The allocation exceeds currently unallocated taxable brokerage value.",
          );
        }
      }
      const changed = await this.#repository.addGoalAllocation(
        this.#workspaceId,
        {
          id: `allocation_${randomUUID()}`,
          goalId,
          source,
          amountDeltaMinor: delta,
          idempotencyKey,
          expectedVersion,
          auditEventId: `audit_${randomUUID()}`,
        },
        actor,
      );
      assertMutation(changed);
      return this.#changeResult(
        direction === "allocate"
          ? "Goal allocation added"
          : "Goal allocation released",
        changed,
      );
    };

    if (
      typeof this.#repository.withWorkspacePlanningLock === "function"
    ) {
      return this.#repository.withWorkspacePlanningLock(
        this.#workspaceId,
        applyAllocation,
      );
    }
    return applyAllocation();
  }

  async spendFromFinanceGoal(input = {}, actorInput = null) {
    const actor = normalizeActor(actorInput);
    const transactionId = requiredId(
      input.transaction_id,
      "transaction_id",
    );
    const goalId = requiredId(input.goal_id, "goal_id");
    const source = enumValue(
      input.source,
      ["cash", "brokerage"],
      "source",
    );
    const amount = positiveMinor(input.amount_minor, "amount_minor");
    const expectedGoalVersion = positiveInteger(
      input.expected_goal_version,
      "expected_goal_version",
    );
    const expectedTransactionVersion = nonnegativeMinor(
      input.expected_transaction_version,
      "expected_transaction_version",
    );
    const visibleTransaction =
      await this.#financeRepository.getTransaction(
        this.#workspaceId,
        transactionId,
      );
    assertGoalSpendEligible(visibleTransaction);

    const apply = async (client = null) => {
      const [current, goals] = await Promise.all([
        this.#repository.getTransactionGoalSpending(
          this.#workspaceId,
          transactionId,
          client,
        ),
        this.#repository.listGoals(
          this.#workspaceId,
          { includeArchived: true },
          client,
        ),
      ]);
      if (!current) throw notFound("Transaction not found.");
      const goalsById = new Map(
        goals.map((entry) => [entry.id, entry]),
      );
      const goal = goalsById.get(goalId);
      if (!goal) throw notFound("Goal not found.");
      if (goal.status !== "active") {
        throw conflict("Archived goals cannot fund transactions.");
      }
      if (goal.version !== expectedGoalVersion) {
        const error = conflict(
          "The goal changed; refresh and try again.",
        );
        error.current = goal;
        throw error;
      }
      const transactionVersion = Number(
        current.goal_spend_version ??
          current.transaction?.goal_spend_version ??
          0,
      );
      if (transactionVersion !== expectedTransactionVersion) {
        const error = conflict(
          "The transaction goal allocations changed; refresh and try again.",
        );
        error.current = current;
        throw error;
      }
      assertGoalSpendEligible(current.transaction);
      const currentLines = current.goal_spends ?? [];
      const assignedMinor = currentLines.reduce(
        (sum, line) => sum + Number(line.amount_minor),
        0,
      );
      if (
        assignedMinor + amount >
        Math.abs(Number(current.transaction.amount_minor))
      ) {
        throw conflict(
          "Goal spending cannot exceed the transaction amount.",
        );
      }
      const matchingIndex = currentLines.findIndex(
        (line) =>
          line.goal_id === goalId && line.source === source,
      );
      const lines = currentLines.map(goalSpendReplacementLine);
      if (matchingIndex >= 0) {
        lines[matchingIndex] = {
          ...lines[matchingIndex],
          id: `goal_spend_${randomUUID()}`,
          amount_minor:
            Number(lines[matchingIndex].amount_minor) + amount,
        };
      } else {
        lines.push({
          id: `goal_spend_${randomUUID()}`,
          line_index: lines.length,
          goal_id: goalId,
          source,
          amount_minor: amount,
        });
      }
      const changed =
        await this.#repository.replaceTransactionGoalSpending(
          this.#workspaceId,
          transactionId,
          lines.map((line, lineIndex) => ({
            ...line,
            line_index: lineIndex,
          })),
          expectedTransactionVersion,
          Object.fromEntries(
            [
              ...new Set(
                lines.map((line) => line.goal_id).concat(
                  currentLines.map((line) => line.goal_id),
                ),
              ),
            ].map((affectedGoalId) => [
              affectedGoalId,
              affectedGoalId === goalId
                ? expectedGoalVersion
                : goalsById.get(affectedGoalId)?.version,
            ]),
          ),
          actor,
          `audit_${randomUUID()}`,
        );
      assertGoalSpendMutation(changed);
      return this.#changeResult("Spent from goal", changed);
    };

    if (
      typeof this.#repository.withWorkspacePlanningLock === "function"
    ) {
      return this.#repository.withWorkspacePlanningLock(
        this.#workspaceId,
        apply,
      );
    }
    return apply();
  }

  async reverseGoalSpend(input = {}, actorInput = null) {
    const actor = normalizeActor(actorInput);
    const transactionId = requiredId(
      input.transaction_id,
      "transaction_id",
    );
    const goalSpendId = requiredId(
      input.goal_spend_id,
      "goal_spend_id",
    );
    const expectedGoalVersion = positiveInteger(
      input.expected_goal_version,
      "expected_goal_version",
    );
    const expectedTransactionVersion = nonnegativeMinor(
      input.expected_transaction_version,
      "expected_transaction_version",
    );

    const apply = async (client = null) => {
      const current =
        await this.#repository.getTransactionGoalSpending(
          this.#workspaceId,
          transactionId,
          client,
        );
      if (!current) throw notFound("Transaction not found.");
      const removed = (current.goal_spends ?? []).find(
        (line) => line.id === goalSpendId,
      );
      if (!removed) {
        throw notFound("Goal spend not found.");
      }
      const goals = await this.#repository.listGoals(
        this.#workspaceId,
        { includeArchived: true },
        client,
      );
      const goalsById = new Map(
        goals.map((entry) => [entry.id, entry]),
      );
      const goal = goalsById.get(removed.goal_id);
      if (!goal) throw notFound("Goal not found.");
      if (goal.version !== expectedGoalVersion) {
        const error = conflict(
          "The goal changed; refresh and try again.",
        );
        error.current = goal;
        throw error;
      }
      const transactionVersion = Number(
        current.goal_spend_version ??
          current.transaction?.goal_spend_version ??
          0,
      );
      if (transactionVersion !== expectedTransactionVersion) {
        const error = conflict(
          "The transaction goal allocations changed; refresh and try again.",
        );
        error.current = current;
        throw error;
      }
      const lines = (current.goal_spends ?? [])
        .filter((line) => line.id !== goalSpendId)
        .map(goalSpendReplacementLine)
        .map((line, lineIndex) => ({
          ...line,
          line_index: lineIndex,
        }));
      const changed =
        await this.#repository.replaceTransactionGoalSpending(
          this.#workspaceId,
          transactionId,
          lines,
          expectedTransactionVersion,
          Object.fromEntries(
            [
              ...new Set(
                (current.goal_spends ?? []).map(
                  (line) => line.goal_id,
                ),
              ),
            ].map((affectedGoalId) => [
              affectedGoalId,
              affectedGoalId === goal.id
                ? expectedGoalVersion
                : goalsById.get(affectedGoalId)?.version,
            ]),
          ),
          actor,
          `audit_${randomUUID()}`,
        );
      assertGoalSpendMutation(changed);
      return this.#changeResult("Goal spend reversed", changed);
    };

    if (
      typeof this.#repository.withWorkspacePlanningLock === "function"
    ) {
      return this.#repository.withWorkspacePlanningLock(
        this.#workspaceId,
        apply,
      );
    }
    return apply();
  }

  async setGoalFundingSchedule(input = {}, actorInput = null) {
    const actor = normalizeActor(actorInput);
    const goalId = requiredId(input.goal_id, "goal_id");
    const currentGoal = await this.#repository.getGoal(
      this.#workspaceId,
      goalId,
    );
    if (!currentGoal) throw notFound("Goal not found.");
    if (currentGoal.status !== "active") {
      throw conflict("Archived goals cannot have active schedules.");
    }
    const timeZone = await this.#repository.getWorkspaceTimezone(
      this.#workspaceId,
    );
    const today = workspaceDate(this.#now(), timeZone);
    const cadence = enumValue(
      input.cadence,
      ["monthly", "biweekly_friday"],
      "cadence",
    );
    const monthlyDay =
      cadence === "monthly"
        ? boundedInteger(input.monthly_day, 1, 31, "monthly_day")
        : null;
    const anchorOn =
      cadence === "biweekly_friday"
        ? requiredDate(input.anchor_on, "anchor_on")
        : null;
    if (
      anchorOn &&
      new Date(`${anchorOn}T00:00:00.000Z`).getUTCDay() !== 5
    ) {
      throw badRequest("anchor_on must be a Friday.");
    }
    const suppliedScheduleId = Boolean(input.schedule_id);
    const schedule = {
      id: suppliedScheduleId
        ? requiredId(input.schedule_id, "schedule_id")
        : `schedule_${randomUUID()}`,
      goal_id: goalId,
      source: enumValue(
        input.source,
        ["cash", "brokerage"],
        "source",
      ),
      cadence,
      amount_minor: positiveMinor(input.amount_minor, "amount_minor"),
      monthly_day: monthlyDay,
      anchor_on: anchorOn,
      status: enumValue(
        input.status ?? "active",
        ["active", "paused"],
        "status",
      ),
    };
    schedule.next_run_on = nextScheduleDueOn(
      schedule,
      shiftDateOnly(today, -1),
    );
    const expectedVersion = suppliedScheduleId
      ? positiveInteger(input.expected_version, "expected_version")
      : input.expected_version == null
        ? null
        : positiveInteger(input.expected_version, "expected_version");
    const changed = await this.#repository.upsertGoalSchedule(
      this.#workspaceId,
      schedule,
      expectedVersion,
      actor,
      `audit_${randomUUID()}`,
      { matchExistingGoal: !suppliedScheduleId },
    );
    assertMutation(changed);
    return this.#changeResult("Goal schedule saved", changed);
  }

  async finishFinanceGoal(input = {}, actorInput = null) {
    const actor = normalizeActor(actorInput);
    const goalId = requiredId(input.goal_id, "goal_id");
    const expectedVersion = positiveInteger(
      input.expected_version,
      "expected_version",
    );
    const outcome = enumValue(
      input.outcome ?? "completed",
      GOAL_ARCHIVE_OUTCOMES,
      "outcome",
    );
    const changed = await this.#repository.archiveGoal(
      this.#workspaceId,
      goalId,
      expectedVersion,
      actor,
      {
        auditEventId: `audit_${randomUUID()}`,
        outcome,
      },
    );
    assertMutation(changed);
    return this.#changeResult("Goal finished", changed);
  }

  async setCategoryBudget(input = {}, actorInput = null) {
    const actor = normalizeActor(actorInput);
    const expectedVersion = nonnegativeMinor(
      input.expected_version,
      "expected_version",
    );
    const timeZone = await this.#repository.getWorkspaceTimezone(
      this.#workspaceId,
    );
    const currentMonth = monthStart(
      workspaceDate(this.#now(), timeZone),
    );
    const requestedCategory = requiredText(
      input.category,
      500,
      "category",
    );
    const resolvedCategory =
      typeof this.#financeRepository.resolveSpendingCategory === "function"
        ? await this.#financeRepository.resolveSpendingCategory(
            this.#workspaceId,
            requestedCategory,
          )
        : null;
    const changed = await this.#repository.setBudgetLine(
      this.#workspaceId,
      {
        monthOn: currentMonth,
        effectiveMonthOn: currentMonth,
        category: resolvedCategory?.path ?? requestedCategory,
        amountMinor: nonnegativeMinor(
          input.amount_minor,
          "amount_minor",
        ),
        scope: "standing",
        expectedVersion,
        auditEventId: `audit_${randomUUID()}`,
      },
      actor,
    );
    assertMutation(changed);
    return this.#changeResult("Budget saved", changed);
  }

  async splitTransaction(input = {}, actorInput = null) {
    const actor = normalizeActor(actorInput);
    const transactionId = requiredId(
      input.transaction_id,
      "transaction_id",
    );
    const expectedVersion = nonnegativeMinor(
      input.expected_version,
      "expected_version",
    );
    const transaction = await this.#financeRepository.getTransaction(
      this.#workspaceId,
      transactionId,
    );
    if (!transaction) throw notFound("Transaction not found.");
    if (transaction.pending) {
      throw conflict("Pending transactions cannot be split.");
    }
    if (transaction.currency_code !== this.#currency) {
      throw conflict("Only USD transactions can be split in v1.");
    }
    if (!Array.isArray(input.lines) || input.lines.length > 50) {
      throw badRequest("lines must be an array with at most 50 entries.");
    }
    if (input.lines.length === 0) {
      const changed = await this.#repository.replaceTransactionSplits(
        this.#workspaceId,
        transactionId,
        [],
        expectedVersion,
        actor,
        `audit_${randomUUID()}`,
      );
      assertMutation(changed);
      return this.#changeResult("Transaction split cleared", changed);
    }
    if (input.lines.length === 1) {
      throw badRequest("Use at least two split lines or clear the split.");
    }
    const sign = Math.sign(transaction.amount_minor);
    const requestedLines = input.lines.map((line, index) => {
      const amount = nonzeroMinor(line.amount_minor, "line.amount_minor");
      if (Math.sign(amount) !== sign) {
        throw badRequest(
          "Every split amount must have the transaction's sign.",
        );
      }
      return {
        id: `split_${randomUUID()}`,
        line_index: index,
        category: requiredText(line.category, 500, "line.category"),
        amount_minor: amount,
        note: optionalText(line.note, 240, "line.note"),
      };
    });
    const lines = await Promise.all(
      requestedLines.map(async (line) => {
        const resolved =
          typeof this.#financeRepository.resolveSpendingCategory ===
          "function"
            ? await this.#financeRepository.resolveSpendingCategory(
                this.#workspaceId,
                line.category,
              )
            : null;
        return {
          ...line,
          category: resolved?.path ?? line.category,
        };
      }),
    );
    const total = lines.reduce(
      (sum, line) => sum + line.amount_minor,
      0,
    );
    if (total !== transaction.amount_minor) {
      throw badRequest(
        "Split amounts must sum exactly to the transaction amount.",
      );
    }
    const changed = await this.#repository.replaceTransactionSplits(
      this.#workspaceId,
      transactionId,
      lines,
      expectedVersion,
      actor,
      `audit_${randomUUID()}`,
    );
    assertMutation(changed);
    return this.#changeResult(
      lines.length ? "Transaction split saved" : "Transaction split cleared",
      changed,
    );
  }

  async executeIdempotentWrite(
    operation,
    input = {},
    actorInput = null,
  ) {
    const method = IDEMPOTENT_WRITE_METHODS[operation];
    if (!method) throw badRequest("Unsupported planning write.");
    const actor = normalizeActor(actorInput);
    const idempotencyKey = requiredText(
      input.idempotency_key,
      160,
      "idempotency_key",
    );
    const requestHash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    if (typeof this.#repository.executePlanWrite === "function") {
      const outcome = await this.#repository.executePlanWrite(
        this.#workspaceId,
        {
          actor,
          operation,
          idempotencyKey,
          requestHash,
        },
        () => this[method](input, actor),
      );
      if (outcome.replay || outcome.executed) return outcome.response;
      if (outcome.mismatch) {
        throw conflict(
          "That idempotency key was already used for a different request.",
        );
      }
      throw conflict(
        "A request with that idempotency key is still in progress.",
      );
    }

    const claim = await this.#repository.claimPlanWrite(
      this.#workspaceId,
      {
        actor,
        operation,
        idempotencyKey,
        requestHash,
      },
    );
    if (claim.replay) return claim.response;
    if (claim.mismatch) {
      throw conflict(
        "That idempotency key was already used for a different request.",
      );
    }
    if (claim.pending) {
      throw conflict(
        "A request with that idempotency key is still in progress.",
      );
    }

    let response;
    try {
      response = await this[method](input, actor);
    } catch (error) {
      await this.#repository.releasePlanWrite(this.#workspaceId, {
        actor,
        operation,
        idempotencyKey,
        requestHash,
      });
      throw error;
    }
    await this.#repository.completePlanWrite(this.#workspaceId, {
      actor,
      operation,
      idempotencyKey,
      requestHash,
      response,
    });
    return response;
  }

  async processDueGoalSchedules({ through_on = null } = {}) {
    const timeZone = await this.#repository.getWorkspaceTimezone(
      this.#workspaceId,
    );
    const throughOn =
      through_on == null
        ? workspaceDate(this.#now(), timeZone)
        : requiredDate(through_on, "through_on");
    const initial = await this.#repository.listDueGoalSchedules(
      this.#workspaceId,
      throughOn,
    );
    const actor = { type: "worker", id: "goal-scheduler" };
    const runs = [];
    for (const candidate of initial) {
      let schedule = candidate;
      for (let count = 0; count < 100; count += 1) {
        const dueOn = schedule.next_run_on;
        if (!dueOn || dueOn > throughOn) break;
        const finished = await this.#processGoalScheduleOccurrence({
          candidate: schedule,
          dueOn,
          throughOn,
          actor,
        });
        if (finished.ignored) break;
        runs.push({
          schedule_id: schedule.id,
          due_on: dueOn,
          status: finished.status,
          replayed: Boolean(finished.replayed),
        });
        if (finished.paused || finished.replayed) break;
        schedule = finished.schedule;
      }
    }
    return { processed: runs.length, runs };
  }

  async #processGoalScheduleOccurrence({
    candidate,
    dueOn,
    throughOn,
    actor,
  }) {
    const apply = async (client = null) => {
      let schedule = candidate;
      if (
        typeof this.#repository.lockGoalScheduleForRun === "function"
      ) {
        const locked = await this.#repository.lockGoalScheduleForRun(
          this.#workspaceId,
          {
            scheduleId: candidate.id,
            dueOn,
            throughOn,
            expectedVersion: candidate.version,
          },
        );
        if (locked.replayed) {
          return {
            ignored: true,
            replayed: true,
            status: locked.status,
          };
        }
        if (locked.missing || locked.stale) {
          return { ignored: true, replayed: false };
        }
        schedule = locked.schedule;
      }

      const current = await this.#repository.getGoal(
        this.#workspaceId,
        schedule.goal_id,
      );
      let status;
      let allocationEventId = null;
      let detail = {};
      let pauseSchedule = false;
      if (!current || current.status !== "active") {
        status = "skipped_inactive_goal";
        pauseSchedule = true;
      } else {
        const remaining = Math.max(
          0,
          current.target_amount_minor - totalRecordedFunding(current),
        );
        if (remaining === 0) {
          status = "skipped_goal_complete";
          pauseSchedule = true;
        } else {
          const amount = Math.min(schedule.amount_minor, remaining);
          if (schedule.source === "brokerage") {
            const available = await this.#brokerageAvailability(client);
            if (amount > available) {
              status = "skipped_brokerage_capacity";
              detail = {
                requested_amount_minor: amount,
                available_amount_minor: available,
              };
            }
          }
          if (!status) {
            const allocation =
              await this.#repository.addGoalAllocation(
                this.#workspaceId,
                {
                  id: `allocation_${randomUUID()}`,
                  goalId: current.id,
                  source: schedule.source,
                  amountDeltaMinor: amount,
                  idempotencyKey: `schedule:${schedule.id}:${dueOn}`,
                  expectedVersion: current.version,
                  auditEventId: `audit_${randomUUID()}`,
                },
                actor,
              );
            assertMutation(allocation);
            allocationEventId = allocation.event?.id ?? null;
            status = "applied";
            detail = { amount_minor: amount };
            pauseSchedule = amount === remaining;
          }
        }
      }
      const nextRunOn = nextScheduleDueOn(schedule, dueOn);
      const finished =
        await this.#repository.finishGoalScheduleRun(
          this.#workspaceId,
          schedule,
          {
            runId: `schedule_run_${randomUUID()}`,
            dueOn,
            status,
            allocationEventId,
            detail,
            nextRunOn,
            pauseSchedule,
            actorId: actor.id,
          },
        );
      return {
        ignored: false,
        replayed: Boolean(finished.replayed),
        status,
        paused: pauseSchedule,
        schedule:
          finished.schedule ?? {
            ...schedule,
            next_run_on: nextRunOn,
            status: pauseSchedule ? "paused" : schedule.status,
            version: schedule.version + 1,
          },
      };
    };

    if (
      typeof this.#repository.withWorkspacePlanningLock === "function"
    ) {
      return this.#repository.withWorkspacePlanningLock(
        this.#workspaceId,
        apply,
      );
    }
    return apply();
  }

  async #planningState({ includeArchived = false } = {}) {
    const [accounts, goals, freshness] = await Promise.all([
      this.#financeRepository.listAccounts(this.#workspaceId),
      this.#repository.listGoals(this.#workspaceId, {
        includeArchived,
      }),
      this.#financeRepository.getDataFreshness(this.#workspaceId),
    ]);
    const snapshot = buildPlanningSnapshot({
      accounts,
      goals,
      currency: this.#currency,
    });
    if (freshness.partial) {
      snapshot.alerts.push({
        code: "stale_source_balances",
        severity: "warning",
        message:
          "One or more source balances are stale or incomplete; Safe to Spend may change after refresh.",
      });
    }
    return {
      accounts,
      goals,
      freshness,
      snapshot,
    };
  }

  #goalCatalog(state) {
    const activeGoals = [...state.snapshot.goals].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const archivedRecords = state.goals.filter(
      (goal) => goal.status === "archived",
    );
    const archivedGoals = archivedRecords
      .map((goal) =>
        buildArchivedGoalSnapshot(goal, {
          currency: this.#currency,
        }),
      )
      .sort(compareArchivedGoals);
    return {
      goals: activeGoals.concat(archivedGoals),
      archivedGoals,
      historyInsights: buildGoalHistoryInsights(archivedRecords, {
        currency: this.#currency,
      }),
    };
  }

  async #brokerageAvailability(client = null) {
    const accounts = await this.#financeRepository.listAccounts(
      this.#workspaceId,
      {},
      client ?? undefined,
    );
    const goals = await this.#repository.listGoals(this.#workspaceId);
    const snapshot = buildPlanningSnapshot({
      accounts,
      goals,
      currency: this.#currency,
    });
    return Math.max(
      0,
      snapshot.taxable_brokerage_value.amount_minor -
        snapshot.brokerage_goal_earmarks.amount_minor,
    );
  }

  async #changeResult(title, changed) {
    const state = await this.#planningState({ includeArchived: true });
    return {
      title,
      changed: compactPlanChange(changed),
      safe_to_spend: state.snapshot.safe_to_spend,
      audit_event_id: changed.audit_event_id ?? null,
      data_as_of: state.freshness.data_as_of,
      source: {
        label: "Money",
        url: `${this.#baseUrl}/plan`,
      },
    };
  }
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

export function createPlanningService(options) {
  return new PlanningService(options);
}

function result({
  data,
  freshness,
  title,
  subtitle,
  path,
  summary,
  warnings = [],
}) {
  return {
    data,
    data_as_of: freshness.data_as_of,
    partial: Boolean(freshness.partial),
    warnings,
    title,
    subtitle,
    source: {
      label: "Money",
      url: path,
    },
    summary,
  };
}

function normalizeActor(actor) {
  if (actor?.type === "openwebui") {
    return { type: "openwebui", id: actor.id ?? "openwebui" };
  }
  if (actor?.type === "worker") {
    return { type: "worker", id: actor.id ?? "worker" };
  }
  return {
    type: "member",
    id: actor?.id ?? actor?.email ?? "unknown-member",
  };
}

function assertMutation(value) {
  if (!value) throw notFound("Planning record not found.");
  if (value.conflict) {
    const error = conflict(
      "The planning record changed; refresh and try again.",
    );
    error.current = value.current;
    throw error;
  }
}

function assertGoalSpendMutation(value) {
  assertMutation(value);
  if (value.validation) {
    const error =
      value.code === "not_found"
        ? notFound(value.message ?? "Planning record not found.")
        : value.code === "invalid_request"
          ? badRequest(value.message ?? "Goal spending is invalid.")
          : conflict(
              value.message ??
                "The goal spending allocation is no longer valid.",
            );
    error.current = value.current;
    throw error;
  }
}

function assertGoalSpendEligible(transaction) {
  if (!transaction) throw notFound("Transaction not found.");
  const amount = Number(transaction.amount_minor);
  const reason = goalSpendIneligibleReason(transaction, amount);
  if (reason) throw conflict(reason);
}

function goalSpendIneligibleReason(transaction, amountMinor) {
  if (transaction?.pending !== false) {
    return "Pending transactions cannot be spent from a goal.";
  }
  if (transaction.currency_code !== "USD") {
    return "Only USD transactions can be spent from a goal.";
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor >= 0) {
    return "Only posted outflows can be spent from a goal.";
  }
  if (transaction.excluded_from_spending === true) {
    return "Transfers and excluded transactions cannot be spent from a goal.";
  }
  return null;
}

function goalSpendReplacementLine(line) {
  return {
    id: `goal_spend_${randomUUID()}`,
    line_index: Number(line.line_index),
    goal_id: line.goal_id,
    source: line.source,
    amount_minor: Number(line.amount_minor),
  };
}

function sourceEarmarked(goal, source) {
  return Number(
    goal.allocations?.find((entry) => entry.source === source)
      ?.amount_minor ?? 0,
  );
}

function totalEarmarked(goal) {
  return (goal.allocations ?? []).reduce(
    (sum, entry) => sum + Number(entry.amount_minor),
    0,
  );
}

function totalSpent(goal) {
  return (goal.spending ?? []).reduce(
    (sum, entry) => sum + Number(entry.amount_minor),
    0,
  );
}

function totalRecordedFunding(goal) {
  const recorded = goal.recorded_allocations;
  if (Array.isArray(recorded)) {
    return recorded.reduce(
      (sum, entry) => sum + Number(entry.amount_minor),
      0,
    );
  }
  return totalEarmarked(goal) + totalSpent(goal);
}

function parseGoalCursor(value) {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^goal\.[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw badRequest("cursor is invalid.");
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
    throw badRequest("cursor is invalid.");
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
    !["active", "archived", "all"].includes(parsed.status) ||
    !(
      parsed.purpose === null ||
      GOAL_PURPOSES.includes(parsed.purpose)
    )
  ) {
    throw badRequest("cursor is invalid.");
  }
  return {
    offset: parsed.offset,
    status: parsed.status,
    purpose: parsed.purpose,
  };
}

function encodeGoalCursor({ offset, status, purpose }) {
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

function compareArchivedGoals(left, right) {
  const leftArchivedAt = String(left.archived_at ?? "");
  const rightArchivedAt = String(right.archived_at ?? "");
  return (
    rightArchivedAt.localeCompare(leftArchivedAt) ||
    left.id.localeCompare(right.id)
  );
}

function boundedGoalHistoryInsights(insights) {
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

function requiredText(value, maximum, name) {
  const normalized = String(value ?? "").trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw badRequest(`${name} is required and must be at most ${maximum} characters.`);
  }
  return normalized;
}

function optionalText(value, maximum, name) {
  if (value == null || value === "") return null;
  return requiredText(value, maximum, name);
}

function requiredId(value, name) {
  const normalized = String(value ?? "").trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)
  ) {
    throw badRequest(`${name} is invalid.`);
  }
  return normalized;
}

function optionalId(value) {
  return value == null || value === "" ? null : requiredId(value, "goal_id");
}

function positiveMinor(value, name) {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, name);
}

function nonnegativeMinor(value, name) {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, name);
}

function nonzeroMinor(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized === 0) {
    throw badRequest(`${name} must be a non-zero integer.`);
  }
  return normalized;
}

function positiveInteger(value, name) {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, name);
}

function boundedInteger(value, minimum, maximum, name) {
  const normalized = Number(value);
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < minimum ||
    normalized > maximum
  ) {
    throw badRequest(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return normalized;
}

function enumValue(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw badRequest(`${name} must be ${allowed.join(" or ")}.`);
  }
  return value;
}

function optionalDate(value) {
  if (value == null || value === "") return null;
  return requiredDate(value, "target_on");
}

function requiredDate(value, name) {
  const normalized = String(value ?? "");
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(normalized) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== normalized
  ) {
    throw badRequest(`${name} must be a valid date.`);
  }
  return normalized;
}

function nextMonth(monthOn) {
  const date = new Date(`${monthOn}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

function previousMonth(monthOn) {
  const date = new Date(`${monthOn}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 10);
}

function formatMonth(monthOn) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${monthOn}T00:00:00.000Z`));
}

function formatMoney(value) {
  return formatMinorMoney(value) ?? "—";
}

function publicError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.status = statusCode;
  error.code = code;
  error.expose = true;
  return error;
}

function badRequest(message) {
  return publicError(message, 400, "invalid_request");
}

function notFound(message) {
  return publicError(message, 404, "not_found");
}

function conflict(message) {
  return publicError(message, 409, "conflict");
}
