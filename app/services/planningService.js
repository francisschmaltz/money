import { createHash, randomUUID } from "node:crypto";

import { formatMinorMoney } from "../currency.js";
import { shiftDateOnly } from "./analytics.js";
import {
  buildBudgetStatus,
  buildPlanningSnapshot,
  modelPlanningScenario,
  monthStart,
  nextScheduleDueOn,
  workspaceDate,
} from "./planningAnalytics.js";

const DEFAULT_WORKSPACE_ID = "shared";
const DEFAULT_CURRENCY = "USD";
const IDEMPOTENT_WRITE_METHODS = Object.freeze({
  create_finance_goal: "createFinanceGoal",
  update_finance_goal: "updateFinanceGoal",
  allocate_finance_goal: "allocateFinanceGoal",
  set_goal_funding_schedule: "setGoalFundingSchedule",
  archive_finance_goal: "archiveFinanceGoal",
  set_category_budget: "setCategoryBudget",
  copy_budget_month: "copyBudgetMonth",
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

  async listFinanceGoals({ include_archived = false } = {}) {
    const state = await this.#planningState({
      includeArchived: Boolean(include_archived),
    });
    return result({
      data: {
        currency: this.#currency,
        goals: include_archived
          ? state.snapshot.goals.concat(
              state.goals
                .filter((goal) => goal.status === "archived")
                .map((goal) => ({
                  ...goal,
                  archived: true,
                })),
            )
          : state.snapshot.goals,
        brokerage_backing_basis_points:
          state.snapshot.brokerage_backing_basis_points,
        taxable_brokerage_value:
          state.snapshot.taxable_brokerage_value,
      },
      freshness: state.freshness,
      title: "Finance goals",
      subtitle: `${state.snapshot.active_goal_count} active`,
      path: "/plan#goals",
      summary: `${state.snapshot.active_goal_count} active household goal${
        state.snapshot.active_goal_count === 1 ? "" : "s"
      } hold ${formatMoney(state.snapshot.cash_goal_earmarks)} in cash earmarks and ${formatMoney(state.snapshot.brokerage_goal_backed_value)} in currently backed brokerage value.`,
    });
  }

  async getBudgetStatus({ month_on = null } = {}) {
    const timeZone = await this.#repository.getWorkspaceTimezone(
      this.#workspaceId,
    );
    const month = monthStart(
      month_on ?? workspaceDate(this.#now(), timeZone),
    );
    const currentMonth = monthStart(
      workspaceDate(this.#now(), timeZone),
    );
    if (
      month <= currentMonth &&
      typeof this.#repository.ensureBudgetMonthSnapshot === "function"
    ) {
      await this.#repository.ensureBudgetMonthSnapshot(
        this.#workspaceId,
        month,
      );
    }
    const endOn = nextMonth(month);
    const [budgetLines, transactions, splits, freshness] =
      await Promise.all([
        this.#repository.listResolvedBudgetLines(
          this.#workspaceId,
          month,
        ),
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
    data.has_exact_month_lines = budgetLines.some(
      (line) => line.exact_month,
    );
    data.source = data.has_exact_month_lines
      ? "month"
      : budgetLines.length
        ? "future_default"
        : "empty";
    return result({
      data,
      freshness,
      title: "Monthly budget",
      subtitle: formatMonth(month),
      path: `/plan?month=${month}`,
      summary: `${formatMoney(data.actual_total)} spent against ${formatMoney(data.planned_total)} planned for ${formatMonth(month)}; ${data.over_budget_category_count} categor${
        data.over_budget_category_count === 1 ? "y is" : "ies are"
      } over budget.`,
    });
  }

  async modelFinancePlan(input = {}) {
    const state = await this.#planningState();
    const scenario = modelPlanningScenario({
      snapshot: state.snapshot,
      goalId: optionalId(input.goal_id),
      monthlyContributionMinor: nonnegativeMinor(
        input.monthly_contribution_minor ?? 0,
        "monthly_contribution_minor",
      ),
      biweeklyContributionMinor: nonnegativeMinor(
        input.biweekly_contribution_minor ?? 0,
        "biweekly_contribution_minor",
      ),
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
    return result({
      data: scenario,
      freshness: state.freshness,
      title: "Finance plan scenario",
      subtitle: scenario.goal_name ?? "Household",
      path: "/plan#scenario",
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
    const lines = await this.#repository.listTransactionSplits(
      this.#workspaceId,
      { transactionIds: [transactionId] },
    );
    return { transaction_id: transactionId, lines };
  }

  async getPlanningOverview({ month_on = null } = {}) {
    const [safe, budget, scheduleRuns, auditEvents] = await Promise.all([
      this.getSafeToSpend(),
      this.getBudgetStatus({ month_on }),
      this.#repository.listGoalScheduleRuns(this.#workspaceId, {
        limit: 20,
      }),
      this.#repository.listAuditEvents(this.#workspaceId, { limit: 30 }),
    ]);
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
    return {
      safeToSpend: safe.data,
      goals: safe.data.goals,
      budget: budget.data,
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
    if (Object.keys(changes).length === 0) {
      throw badRequest("At least one goal field must change.");
    }
    const current = await this.#repository.getGoal(
      this.#workspaceId,
      goalId,
    );
    if (!current) throw notFound("Goal not found.");
    const earmarked = totalEarmarked(current);
    if (
      changes.target_amount_minor != null &&
      changes.target_amount_minor < earmarked
    ) {
      throw conflict(
        "Release goal allocations before lowering the target below the earmarked amount.",
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
    const current = await this.#repository.getGoal(
      this.#workspaceId,
      goalId,
    );
    if (!current) throw notFound("Goal not found.");
    if (current.status !== "active") {
      throw conflict("Archived goals cannot receive allocations.");
    }
    const currentSource = sourceEarmarked(current, source);
    const delta = direction === "allocate" ? amount : -amount;
    if (currentSource + delta < 0) {
      throw conflict("The release exceeds the goal's earmarked amount.");
    }
    if (totalEarmarked(current) + delta > current.target_amount_minor) {
      throw conflict("The allocation would exceed the goal target.");
    }
    if (source === "brokerage" && delta > 0) {
      const state = await this.#planningState();
      const available =
        state.snapshot.taxable_brokerage_value.amount_minor -
        state.snapshot.brokerage_goal_earmarks.amount_minor;
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
    const schedule = {
      id: input.schedule_id
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
    const expectedVersion = input.schedule_id
      ? positiveInteger(input.expected_version, "expected_version")
      : null;
    const changed = await this.#repository.upsertGoalSchedule(
      this.#workspaceId,
      schedule,
      expectedVersion,
      actor,
      `audit_${randomUUID()}`,
    );
    assertMutation(changed);
    return this.#changeResult("Goal schedule saved", changed);
  }

  async archiveFinanceGoal(input = {}, actorInput = null) {
    const actor = normalizeActor(actorInput);
    const goalId = requiredId(input.goal_id, "goal_id");
    const expectedVersion = positiveInteger(
      input.expected_version,
      "expected_version",
    );
    const current = await this.#repository.getGoal(
      this.#workspaceId,
      goalId,
    );
    if (!current) throw notFound("Goal not found.");
    if (totalEarmarked(current) !== 0) {
      throw conflict(
        "Release cash and brokerage earmarks before archiving the goal.",
      );
    }
    const changed = await this.#repository.archiveGoal(
      this.#workspaceId,
      goalId,
      expectedVersion,
      actor,
      { auditEventId: `audit_${randomUUID()}` },
    );
    assertMutation(changed);
    return this.#changeResult("Goal archived", changed);
  }

  async setCategoryBudget(input = {}, actorInput = null) {
    const actor = normalizeActor(actorInput);
    const timeZone = await this.#repository.getWorkspaceTimezone(
      this.#workspaceId,
    );
    const currentMonth = monthStart(
      workspaceDate(this.#now(), timeZone),
    );
    const scope = enumValue(
      input.scope ?? "month",
      ["month", "future_default"],
      "scope",
    );
    const monthOn = monthStart(input.month_on ?? currentMonth);
    const effectiveMonthOn =
      scope === "future_default"
        ? monthStart(
            input.effective_month_on ??
              (monthOn > currentMonth
                ? monthOn
                : nextMonth(currentMonth)),
          )
        : null;
    if (
      scope === "future_default" &&
      effectiveMonthOn < nextMonth(currentMonth)
    ) {
      throw badRequest(
        "Future budget defaults must begin next month or later.",
      );
    }
    if (
      scope === "month" &&
      typeof this.#repository.ensureBudgetMonthSnapshot === "function"
    ) {
      await this.#repository.ensureBudgetMonthSnapshot(
        this.#workspaceId,
        monthOn,
        actor.id,
      );
    }
    const changed = await this.#repository.setBudgetLine(
      this.#workspaceId,
      {
        monthOn,
        effectiveMonthOn,
        category: requiredText(input.category, 100, "category"),
        amountMinor: nonnegativeMinor(
          input.amount_minor,
          "amount_minor",
        ),
        scope,
        auditEventId: `audit_${randomUUID()}`,
      },
      actor,
    );
    return this.#changeResult("Budget saved", changed);
  }

  async copyBudgetMonth(input = {}, actorInput = null) {
    const actor = normalizeActor(actorInput);
    const targetMonth = monthStart(input.month_on);
    const sourceMonth = monthStart(
      input.source_month_on ?? previousMonth(targetMonth),
    );
    if (sourceMonth >= targetMonth) {
      throw badRequest("source_month_on must be earlier than month_on.");
    }
    const sourceLines = await this.#repository.listResolvedBudgetLines(
      this.#workspaceId,
      sourceMonth,
    );
    const changed = await this.#repository.replaceBudgetMonth(
      this.#workspaceId,
      {
        monthOn: targetMonth,
        copiedFromMonthOn: sourceMonth,
        lines: sourceLines,
        auditEventId: `audit_${randomUUID()}`,
      },
      actor,
    );
    return this.#changeResult("Budget copied", changed);
  }

  async splitTransaction(input = {}, actorInput = null) {
    const actor = normalizeActor(actorInput);
    const transactionId = requiredId(
      input.transaction_id,
      "transaction_id",
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
        actor,
        `audit_${randomUUID()}`,
      );
      return this.#changeResult("Transaction split cleared", changed);
    }
    if (input.lines.length === 1) {
      throw badRequest("Use at least two split lines or clear the split.");
    }
    const sign = Math.sign(transaction.amount_minor);
    const lines = input.lines.map((line, index) => {
      const amount = nonzeroMinor(line.amount_minor, "line.amount_minor");
      if (Math.sign(amount) !== sign) {
        throw badRequest(
          "Every split amount must have the transaction's sign.",
        );
      }
      return {
        id: `split_${randomUUID()}`,
        line_index: index,
        category: requiredText(line.category, 100, "line.category"),
        amount_minor: amount,
        note: optionalText(line.note, 240, "line.note"),
      };
    });
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
      actor,
      `audit_${randomUUID()}`,
    );
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
      through_on ?? workspaceDate(this.#now(), timeZone);
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
            current.target_amount_minor - totalEarmarked(current),
          );
          if (remaining === 0) {
            status = "skipped_goal_complete";
            pauseSchedule = true;
          } else {
            const amount = Math.min(schedule.amount_minor, remaining);
            if (schedule.source === "brokerage") {
              const state = await this.#planningState();
              const available =
                state.snapshot.taxable_brokerage_value.amount_minor -
                state.snapshot.brokerage_goal_earmarks.amount_minor;
              if (amount > available) {
                status = "skipped_brokerage_capacity";
                detail = {
                  requested_amount_minor: amount,
                  available_amount_minor: Math.max(0, available),
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
            },
          );
        runs.push({
          schedule_id: schedule.id,
          due_on: dueOn,
          status,
          replayed: Boolean(finished.replayed),
        });
        if (pauseSchedule) break;
        schedule = { ...schedule, next_run_on: nextRunOn };
      }
    }
    return { processed: runs.length, runs };
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

  async #changeResult(title, changed) {
    const state = await this.#planningState({ includeArchived: true });
    return {
      title,
      changed,
      safe_to_spend: state.snapshot.safe_to_spend,
      goals: state.snapshot.goals,
      audit_event_id: changed.audit_event_id ?? null,
      data_as_of: state.freshness.data_as_of,
      source: {
        label: "Money",
        url: `${this.#baseUrl}/plan`,
      },
    };
  }
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
  const normalized = String(value ?? "").slice(0, 10);
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
