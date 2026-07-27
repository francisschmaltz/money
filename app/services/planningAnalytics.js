import { inferBalanceGroup, money, shiftDateOnly } from "./analytics.js";

const SUPPORTED_SOURCES = new Set(["cash", "brokerage"]);

export function workspaceDate(value = new Date(), timeZone = "America/Los_Angeles") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function monthStart(value) {
  const normalized = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new TypeError("Expected an ISO date.");
  }
  return `${normalized.slice(0, 7)}-01`;
}

export function nextMonthlyDueOn(afterOn, monthlyDay) {
  const day = boundedDay(monthlyDay);
  const after = parseDate(afterOn);
  for (let offset = 0; offset < 24; offset += 1) {
    const candidate = new Date(
      Date.UTC(after.getUTCFullYear(), after.getUTCMonth() + offset, 1),
    );
    const lastDay = new Date(
      Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, 0),
    ).getUTCDate();
    candidate.setUTCDate(Math.min(day, lastDay));
    const candidateOn = candidate.toISOString().slice(0, 10);
    if (candidateOn > String(afterOn).slice(0, 10)) return candidateOn;
  }
  throw new TypeError("Unable to resolve the next monthly due date.");
}

export function nextBiweeklyFridayDueOn(afterOn, anchorOn) {
  const anchor = parseDate(anchorOn);
  if (anchor.getUTCDay() !== 5) {
    throw new TypeError("Biweekly schedule anchors must be Fridays.");
  }
  const after = parseDate(afterOn);
  if (anchor > after) return anchor.toISOString().slice(0, 10);
  const elapsedDays = Math.floor((after - anchor) / 86_400_000);
  const periods = Math.floor(elapsedDays / 14) + 1;
  return shiftDateOnly(anchor, periods * 14);
}

export function nextScheduleDueOn(schedule, afterOn) {
  if (schedule.cadence === "monthly") {
    return nextMonthlyDueOn(afterOn, schedule.monthly_day);
  }
  if (schedule.cadence === "biweekly_friday") {
    return nextBiweeklyFridayDueOn(afterOn, schedule.anchor_on);
  }
  throw new TypeError("Unsupported goal schedule cadence.");
}

export function buildPlanningSnapshot({
  accounts = [],
  goals = [],
  currency = "USD",
} = {}) {
  let liquidCash = 0;
  let creditCardLiabilities = 0;
  let brokerageValue = 0;
  let unknownBalanceCount = 0;
  let excludedCurrencyCount = 0;

  for (const account of accounts) {
    if (account.active === false) continue;
    const group = inferBalanceGroup(account);
    if (!["cash", "credit_card", "taxable_investment"].includes(group)) {
      continue;
    }
    if (account.currency_code !== currency) {
      excludedCurrencyCount += 1;
      continue;
    }
    if (account.current_balance_minor == null) {
      unknownBalanceCount += 1;
      continue;
    }
    if (group === "cash") {
      liquidCash += account.current_balance_minor;
    } else if (group === "credit_card") {
      creditCardLiabilities += Math.max(0, account.current_balance_minor);
    } else {
      brokerageValue += account.current_balance_minor;
    }
  }

  brokerageValue = Math.max(0, brokerageValue);
  const activeGoals = goals.filter((goal) => goal.status === "active");
  const normalizedGoals = activeGoals.map(normalizeGoal);
  const cashEarmarks = normalizedGoals.reduce(
    (sum, goal) => sum + goal.cash_earmarked_minor,
    0,
  );
  const brokerageEarmarks = normalizedGoals.reduce(
    (sum, goal) => sum + goal.brokerage_earmarked_minor,
    0,
  );
  const effectiveBrokerage = allocateProRata(
    normalizedGoals,
    brokerageValue,
    brokerageEarmarks,
  );
  const backingBasisPoints =
    brokerageEarmarks === 0
      ? 10_000
      : Math.min(
          10_000,
          ratioBasisPoints(brokerageValue, brokerageEarmarks),
        );

  const plannedGoals = normalizedGoals.map((goal) => {
    const brokerageBackedMinor =
      effectiveBrokerage.get(goal.id) ?? goal.brokerage_earmarked_minor;
    const fundedMinor = goal.cash_earmarked_minor + brokerageBackedMinor;
    return {
      ...goal,
      cash_earmarked: money(goal.cash_earmarked_minor, currency),
      brokerage_earmarked: money(goal.brokerage_earmarked_minor, currency),
      brokerage_backed: money(brokerageBackedMinor, currency),
      funded: money(fundedMinor, currency),
      shortfall: money(
        Math.max(0, goal.target_amount_minor - fundedMinor),
        currency,
      ),
      progress_basis_points:
        goal.target_amount_minor === 0
          ? 0
          : Math.min(
              10_000,
              ratioBasisPoints(fundedMinor, goal.target_amount_minor),
            ),
      brokerage_under_backed:
        brokerageBackedMinor < goal.brokerage_earmarked_minor,
    };
  });
  const brokerageBackedTotal = plannedGoals.reduce(
    (sum, goal) => sum + goal.brokerage_backed.amount_minor,
    0,
  );
  const safeToSpend = liquidCash - creditCardLiabilities - cashEarmarks;
  const alerts = [];
  if (safeToSpend < 0) {
    alerts.push({
      code: "safe_to_spend_negative",
      severity: "warning",
      message: "Cash-backed commitments exceed liquid cash after card balances.",
    });
  }
  if (brokerageBackedTotal < brokerageEarmarks) {
    alerts.push({
      code: "brokerage_goals_under_backed",
      severity: "warning",
      message: "Market value no longer fully backs brokerage goal earmarks.",
    });
  }
  if (unknownBalanceCount > 0) {
    alerts.push({
      code: "unknown_planning_balances",
      severity: "warning",
      message: `${unknownBalanceCount} planning balance${unknownBalanceCount === 1 ? " is" : "s are"} unknown.`,
    });
  }

  return {
    currency,
    liquid_cash: money(liquidCash, currency),
    current_card_liabilities: money(creditCardLiabilities, currency),
    cash_goal_earmarks: money(cashEarmarks, currency),
    safe_to_spend: money(safeToSpend, currency),
    taxable_brokerage_value: money(brokerageValue, currency),
    brokerage_goal_earmarks: money(brokerageEarmarks, currency),
    brokerage_goal_backed_value: money(brokerageBackedTotal, currency),
    brokerage_unallocated_value: money(
      Math.max(0, brokerageValue - brokerageEarmarks),
      currency,
    ),
    brokerage_backing_basis_points: backingBasisPoints,
    goals: plannedGoals,
    active_goal_count: plannedGoals.length,
    unknown_balance_count: unknownBalanceCount,
    excluded_currency_count: excludedCurrencyCount,
    alerts,
    formula:
      "Liquid checking/savings cash minus positive current card balances minus cash-backed goal earmarks.",
  };
}

export function buildBudgetStatus({
  monthOn,
  budgetLines = [],
  transactions = [],
  splits = [],
  currency = "USD",
} = {}) {
  const month = monthStart(monthOn);
  const endOn = nextMonth(month);
  const expanded = expandTransactionsWithSplits(transactions, splits);
  const actualByCategory = new Map();
  for (const transaction of expanded) {
    if (
      transaction.pending ||
      transaction.excluded_from_spending ||
      transaction.currency_code !== currency ||
      transaction.posted_on < month ||
      transaction.posted_on >= endOn
    ) {
      continue;
    }
    if (
      transaction.amount_minor > 0 &&
      /\b(income|payroll|deposit|interest_earned)\b/i.test(
        `${transaction.category_primary ?? ""} ${transaction.category_detailed ?? ""}`,
      )
    ) {
      continue;
    }
    const category = transaction.category_primary ?? "Uncategorized";
    actualByCategory.set(
      category,
      (actualByCategory.get(category) ?? 0) - transaction.amount_minor,
    );
  }
  for (const [category, amount] of actualByCategory) {
    actualByCategory.set(category, Math.max(0, amount));
  }

  const planByCategory = new Map(
    budgetLines.map((line) => [
      line.category,
      Number(line.amount_minor),
    ]),
  );
  const categories = [...new Set([
    ...planByCategory.keys(),
    ...actualByCategory.keys(),
  ])].sort((left, right) => left.localeCompare(right));
  const lines = categories.map((category) => {
    const planned = planByCategory.get(category) ?? 0;
    const actual = actualByCategory.get(category) ?? 0;
    return {
      category,
      planned: money(planned, currency),
      actual: money(actual, currency),
      remaining: money(planned - actual, currency),
      over: money(Math.max(0, actual - planned), currency),
      progress_basis_points:
        planned === 0
          ? actual === 0
            ? 0
            : null
          : Math.round((actual * 10_000) / planned),
      has_budget: planByCategory.has(category),
    };
  });
  const plannedTotal = budgetLines.reduce(
    (sum, line) => sum + Number(line.amount_minor),
    0,
  );
  const actualTotal = [...actualByCategory.values()].reduce(
    (sum, amount) => sum + amount,
    0,
  );
  return {
    month_on: month,
    end_on: endOn,
    currency,
    planned_total: money(plannedTotal, currency),
    actual_total: money(actualTotal, currency),
    remaining_total: money(plannedTotal - actualTotal, currency),
    over_budget_category_count: lines.filter(
      (line) => line.over.amount_minor > 0,
    ).length,
    lines,
  };
}

export function expandTransactionsWithSplits(transactions, splits) {
  const byTransaction = new Map();
  for (const split of splits) {
    const list = byTransaction.get(split.transaction_id) ?? [];
    list.push(split);
    byTransaction.set(split.transaction_id, list);
  }
  return transactions.flatMap((transaction) => {
    const lines = byTransaction.get(transaction.id);
    if (!lines?.length) return [transaction];
    return lines.map((line) => ({
      ...transaction,
      id: `${transaction.id}:${line.id ?? line.line_index}`,
      category_primary: line.category,
      category_detailed: null,
      amount_minor: Number(line.amount_minor),
      split_parent_id: transaction.id,
    }));
  });
}

export function modelPlanningScenario({
  snapshot,
  goalId = null,
  monthlyContributionMinor = 0,
  biweeklyContributionMinor = 0,
  oneTimeContributionMinor = 0,
  brokerageChangeBasisPoints = 0,
  asOf = new Date(),
} = {}) {
  const selectedGoal =
    snapshot.goals.find((goal) => goal.id === goalId) ??
    (goalId == null ? snapshot.goals[0] : null);
  const shockedBrokerage = Math.max(
    0,
    Math.round(
      snapshot.taxable_brokerage_value.amount_minor *
        (1 + brokerageChangeBasisPoints / 10_000),
    ),
  );
  const currentFunded = selectedGoal?.funded.amount_minor ?? 0;
  const totalBrokerageEarmarks =
    snapshot.brokerage_goal_earmarks.amount_minor;
  const shockedBackingBasisPoints =
    totalBrokerageEarmarks === 0
      ? 10_000
      : Math.min(
          10_000,
          ratioBasisPoints(
            shockedBrokerage,
            totalBrokerageEarmarks,
          ),
        );
  const selectedBrokerageEarmark =
    selectedGoal?.brokerage_earmarked.amount_minor ?? 0;
  const shockedSelectedBrokerage = Math.min(
    selectedBrokerageEarmark,
    Number(
      (BigInt(selectedBrokerageEarmark) *
        BigInt(shockedBackingBasisPoints)) /
        10_000n,
    ),
  );
  const shockedFunded =
    (selectedGoal?.cash_earmarked.amount_minor ?? 0) +
    shockedSelectedBrokerage;
  const target = selectedGoal?.target_amount_minor ?? 0;
  const shortfall = Math.max(
    0,
    target - shockedFunded - oneTimeContributionMinor,
  );
  const monthlyEquivalent =
    monthlyContributionMinor +
    Math.round((biweeklyContributionMinor * 26) / 12);
  const monthsToTarget =
    shortfall === 0
      ? 0
      : monthlyEquivalent > 0
        ? Math.ceil(shortfall / monthlyEquivalent)
        : null;
  const targetDate =
    monthsToTarget == null
      ? null
      : addMonths(workspaceDate(asOf, "UTC"), monthsToTarget);
  return {
    goal_id: selectedGoal?.id ?? null,
    goal_name: selectedGoal?.name ?? null,
    current_funded: money(currentFunded, snapshot.currency),
    funded_after_brokerage_change: money(
      shockedFunded,
      snapshot.currency,
    ),
    target: money(target, snapshot.currency),
    one_time_contribution: money(
      oneTimeContributionMinor,
      snapshot.currency,
    ),
    monthly_contribution: money(
      monthlyContributionMinor,
      snapshot.currency,
    ),
    biweekly_contribution: money(
      biweeklyContributionMinor,
      snapshot.currency,
    ),
    monthly_equivalent: money(monthlyEquivalent, snapshot.currency),
    months_to_target: monthsToTarget,
    estimated_target_on: targetDate,
    brokerage_change_basis_points: brokerageChangeBasisPoints,
    shocked_brokerage_value: money(shockedBrokerage, snapshot.currency),
    brokerage_backing_basis_points_after:
      shockedBackingBasisPoints,
    safe_to_spend_after: snapshot.safe_to_spend,
    assumptions: [
      "Contributions are constant.",
      "No interest, tax, trades, withdrawals, or inflation are modeled.",
      "Brokerage changes alter backing, not recorded earmarks.",
    ],
  };
}

function normalizeGoal(goal) {
  const allocation = Object.fromEntries(
    (goal.allocations ?? []).map((entry) => {
      if (!SUPPORTED_SOURCES.has(entry.source)) {
        throw new TypeError("Unsupported goal allocation source.");
      }
      return [entry.source, Number(entry.amount_minor)];
    }),
  );
  return {
    ...goal,
    target_amount_minor: Number(goal.target_amount_minor),
    cash_earmarked_minor: Math.max(0, allocation.cash ?? 0),
    brokerage_earmarked_minor: Math.max(0, allocation.brokerage ?? 0),
  };
}

function allocateProRata(goals, brokerageValue, totalEarmarks) {
  const result = new Map();
  if (totalEarmarks <= brokerageValue) {
    for (const goal of goals) {
      result.set(goal.id, goal.brokerage_earmarked_minor);
    }
    return result;
  }
  if (brokerageValue <= 0 || totalEarmarks <= 0) {
    for (const goal of goals) result.set(goal.id, 0);
    return result;
  }
  const candidates = goals
    .filter((goal) => goal.brokerage_earmarked_minor > 0)
    .map((goal) => {
      const numerator =
        BigInt(goal.brokerage_earmarked_minor) * BigInt(brokerageValue);
      const denominator = BigInt(totalEarmarks);
      const base = Number(numerator / denominator);
      return {
        id: goal.id,
        base,
        remainder: numerator % denominator,
      };
    })
    .sort((left, right) => {
      if (left.remainder > right.remainder) return -1;
      if (left.remainder < right.remainder) return 1;
      return left.id.localeCompare(right.id);
    });
  let distributed = candidates.reduce((sum, entry) => sum + entry.base, 0);
  for (const candidate of candidates) {
    const extra = distributed < brokerageValue ? 1 : 0;
    result.set(candidate.id, candidate.base + extra);
    distributed += extra;
  }
  for (const goal of goals) {
    if (!result.has(goal.id)) result.set(goal.id, 0);
  }
  return result;
}

function parseDate(value) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid date.");
  return date;
}

function boundedDay(value) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new TypeError("monthly_day must be an integer from 1 to 31.");
  }
  return day;
}

function ratioBasisPoints(numerator, denominator) {
  if (denominator <= 0) return 0;
  return Number(
    (BigInt(numerator) * 10_000n) / BigInt(denominator),
  );
}

function nextMonth(monthOn) {
  const date = parseDate(monthOn);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

function addMonths(dateOn, months) {
  const date = parseDate(dateOn);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}
