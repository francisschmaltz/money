import { inferBalanceGroup, money, shiftDateOnly } from "./analytics.js";

const SUPPORTED_SOURCES = new Set(["cash", "brokerage"]);
const DEFAULT_GOAL_PURPOSE = "other";

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
  assertFridayAnchor(anchor);
  const after = parseDate(afterOn);
  if (anchor > after) return anchor.toISOString().slice(0, 10);
  const elapsedDays = Math.floor((after - anchor) / 86_400_000);
  const periods = Math.floor(elapsedDays / 14) + 1;
  return shiftDateOnly(anchor, periods * 14);
}

export function assertFridayAnchor(value) {
  const anchor = value instanceof Date ? value : parseDate(value);
  if (anchor.getUTCDay() !== 5) {
    throw new TypeError("Biweekly schedule anchors must be Fridays.");
  }
  return String(
    value instanceof Date ? value.toISOString() : value,
  ).slice(0, 10);
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
    const spentMinor =
      goal.cash_spent_minor + goal.brokerage_spent_minor;
    const fundedMinor =
      spentMinor + goal.cash_earmarked_minor + brokerageBackedMinor;
    return {
      ...goal,
      cash_earmarked: money(goal.cash_earmarked_minor, currency),
      brokerage_earmarked: money(goal.brokerage_earmarked_minor, currency),
      brokerage_backed: money(brokerageBackedMinor, currency),
      cash_spent: money(goal.cash_spent_minor, currency),
      brokerage_spent: money(goal.brokerage_spent_minor, currency),
      spent: money(spentMinor, currency),
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
      ...goalSpendMetrics(goal, currency),
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

export function buildArchivedGoalSnapshot(
  goal,
  { currency = "USD" } = {},
) {
  const normalized = normalizeGoal(goal);
  const {
    allocations: _activeAllocations,
    cash_earmarked_minor: _cashEarmarkedMinor,
    brokerage_earmarked_minor: _brokerageEarmarkedMinor,
    ...archivedBase
  } = normalized;
  const spentMinor =
    normalized.cash_spent_minor +
    normalized.brokerage_spent_minor;
  const recordedCashMinor = normalized.cash_recorded_minor;
  const recordedBrokerageMinor =
    normalized.brokerage_recorded_minor;
  const recordedFundingMinor =
    recordedCashMinor + recordedBrokerageMinor;
  const unusedCashMinor = normalized.cash_earmarked_minor;
  const unusedBrokerageMinor =
    normalized.brokerage_earmarked_minor;
  const unusedFundingMinor =
    unusedCashMinor + unusedBrokerageMinor;
  return {
    ...archivedBase,
    allocations: [],
    cash_earmarked_minor: 0,
    brokerage_earmarked_minor: 0,
    purpose: normalized.purpose ?? DEFAULT_GOAL_PURPOSE,
    status: "archived",
    archived: true,
    archive_outcome: normalized.archive_outcome ?? "completed",
    currency,
    cash_earmarked: money(0, currency),
    brokerage_earmarked: money(0, currency),
    brokerage_backed: money(0, currency),
    recorded_cash_funding: money(recordedCashMinor, currency),
    recorded_brokerage_funding: money(
      recordedBrokerageMinor,
      currency,
    ),
    recorded_funding: money(recordedFundingMinor, currency),
    unused_cash_funding: money(unusedCashMinor, currency),
    unused_brokerage_funding: money(
      unusedBrokerageMinor,
      currency,
    ),
    unused_funding: money(unusedFundingMinor, currency),
    cash_spent: money(normalized.cash_spent_minor, currency),
    brokerage_spent: money(
      normalized.brokerage_spent_minor,
      currency,
    ),
    spent: money(spentMinor, currency),
    funded: money(recordedFundingMinor, currency),
    shortfall: money(
      Math.max(
        0,
        normalized.target_amount_minor - recordedFundingMinor,
      ),
      currency,
    ),
    progress_basis_points:
      normalized.target_amount_minor === 0
        ? 0
        : Math.min(
            10_000,
            ratioBasisPoints(
              recordedFundingMinor,
              normalized.target_amount_minor,
            ),
          ),
    brokerage_under_backed: false,
    ...goalSpendMetrics(normalized, currency),
  };
}

export function buildGoalHistoryInsights(
  goals,
  { currency = "USD", minimumEvidence = 3 } = {},
) {
  const evidenceFloor = Math.max(
    3,
    Number.isSafeInteger(minimumEvidence) ? minimumEvidence : 3,
  );
  const completed = goals
    .filter(
      (goal) =>
        goal.status === "archived" &&
        (goal.archive_outcome ?? "completed") === "completed",
    )
    .map((goal) => {
      const snapshot = buildArchivedGoalSnapshot(goal, { currency });
      return {
        goal: snapshot,
        actualVarianceBasisPoints: ratioBasisPoints(
          snapshot.actual.amount_minor -
            snapshot.planned.amount_minor,
          snapshot.planned.amount_minor,
        ),
      };
    })
    .filter((entry) => entry.goal.actual.amount_minor > 0);
  const byPurpose = new Map();
  for (const entry of completed) {
    const purpose =
      entry.goal.purpose ?? DEFAULT_GOAL_PURPOSE;
    if (purpose === DEFAULT_GOAL_PURPOSE) continue;
    const entries = byPurpose.get(purpose) ?? [];
    entries.push(entry);
    byPurpose.set(purpose, entries);
  }
  return [...byPurpose.entries()]
    .filter(([, entries]) => entries.length >= evidenceFloor)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([purpose, entries]) => {
      const ordered = [...entries].sort((left, right) => {
        const variance =
          left.actualVarianceBasisPoints -
          right.actualVarianceBasisPoints;
        return (
          variance ||
          left.goal.id.localeCompare(right.goal.id)
        );
      });
      return {
        kind: "purpose_actual_variance",
        purpose,
        completed_goal_count: ordered.length,
        median_actual_variance_basis_points: medianInteger(
          ordered.map(
            (entry) => entry.actualVarianceBasisPoints,
          ),
        ),
        evidence_goal_ids_truncated: false,
        evidence_goal_ids: ordered
          .map((entry) => entry.goal.id)
          .sort((left, right) => left.localeCompare(right)),
      };
    });
}

export function buildBudgetStatus({
  monthOn,
  budgetLines = [],
  categories = [],
  transactions = [],
  splits = [],
  income = null,
  currency = "USD",
} = {}) {
  const month = monthStart(monthOn);
  const endOn = nextMonth(month);
  const expanded = expandTransactionsWithSplits(transactions, splits);
  const categoryList = categories.length
    ? categories
    : [
        ...new Set([
          ...budgetLines.map((line) => line.category),
          ...expanded.map(
            (transaction) =>
              transaction.category_primary ?? "Uncategorized",
          ),
        ]),
      ].map((category) => ({
        id: category,
        name: category,
        path: category,
        parent_category_id: null,
      }));
  const categoryById = new Map(
    categoryList.map((category) => [category.id, category]),
  );
  const idByPath = new Map(
    categoryList.flatMap((category) => [
      [category.path, category.id],
      [category.name, category.id],
    ]),
  );
  const childrenById = new Map();
  for (const category of categoryList) {
    const list = childrenById.get(category.parent_category_id) ?? [];
    list.push(category.id);
    childrenById.set(category.parent_category_id, list);
  }
  const incomeRoots = new Set(income?.category_ids ?? []);
  const isIncomeCategory = (categoryId) => {
    let current = categoryById.get(categoryId);
    const visited = new Set();
    while (current && !visited.has(current.id)) {
      if (incomeRoots.has(current.id)) return true;
      visited.add(current.id);
      current = categoryById.get(current.parent_category_id);
    }
    return false;
  };
  const directActualById = new Map();
  for (const transaction of expanded) {
    const transactionBudgetMonth = monthStart(
      transaction.budget_month_on ?? transaction.posted_on,
    );
    if (
      transaction.pending ||
      transaction.excluded_from_spending ||
      transaction.currency_code !== currency ||
      transactionBudgetMonth !== month
    ) {
      continue;
    }
    const categoryId =
      transaction.category_id ??
      idByPath.get(
        transaction.category_primary ?? "Uncategorized",
      );
    if (!categoryId || isIncomeCategory(categoryId)) continue;
    if (
      transaction.amount_minor > 0 &&
      /\b(income|payroll|deposit|interest_earned)\b/i.test(
        `${transaction.category_primary ?? ""} ${transaction.category_detailed ?? ""}`,
      )
    ) {
      continue;
    }
    directActualById.set(
      categoryId,
      (directActualById.get(categoryId) ?? 0) -
        transaction.amount_minor,
    );
  }
  const planById = new Map(
    budgetLines.map((line) => {
      const categoryId =
        line.category_id ?? idByPath.get(line.category);
      return [
        categoryId,
        {
          ...line,
          category_id: categoryId,
          amount_minor: Number(line.amount_minor),
          tracking_mode: line.tracking_mode ?? "tracked",
        },
      ];
    }).filter(([categoryId]) => categoryId),
  );
  if (!categories.length) {
    for (const categoryId of directActualById.keys()) {
      if (planById.has(categoryId)) continue;
      const category = categoryById.get(categoryId);
      planById.set(categoryId, {
        category_id: categoryId,
        category: category?.path ?? categoryId,
        amount_minor: 0,
        tracking_mode: "tracked",
        version: 0,
        has_budget: false,
      });
    }
  }
  const subtreeActualMemo = new Map();
  const subtreeActual = (categoryId, visited = new Set()) => {
    if (subtreeActualMemo.has(categoryId)) {
      return subtreeActualMemo.get(categoryId);
    }
    if (visited.has(categoryId)) return 0;
    const nextVisited = new Set(visited).add(categoryId);
    const value =
      (directActualById.get(categoryId) ?? 0) +
      (childrenById.get(categoryId) ?? []).reduce(
        (sum, childId) =>
          sum + subtreeActual(childId, nextVisited),
        0,
      );
    subtreeActualMemo.set(categoryId, value);
    return value;
  };
  const selectedChildren = new Map();
  for (const categoryId of planById.keys()) {
    const parentId = categoryById.get(categoryId)?.parent_category_id;
    if (parentId && planById.has(parentId)) {
      const list = selectedChildren.get(parentId) ?? [];
      list.push(categoryId);
      selectedChildren.set(parentId, list);
    }
  }
  const selectedRoots = [...planById.keys()].filter((categoryId) => {
    const parentId = categoryById.get(categoryId)?.parent_category_id;
    return !parentId || !planById.has(parentId);
  });
  const informationalRootsWithin = (categoryId) => {
    const result = [];
    const visit = (parentId, inheritedInformational) => {
      for (const childId of selectedChildren.get(parentId) ?? []) {
        const child = planById.get(childId);
        const informational =
          inheritedInformational ||
          child.tracking_mode === "informational";
        if (!inheritedInformational && informational) {
          result.push(childId);
        } else {
          visit(childId, informational);
        }
      }
    };
    visit(categoryId, false);
    return result;
  };
  const makeNode = (
    categoryId,
    depth = 0,
    inheritedInformational = false,
  ) => {
    const category = categoryById.get(categoryId) ?? {
      id: categoryId,
      name: planById.get(categoryId)?.category ?? categoryId,
      path: planById.get(categoryId)?.category ?? categoryId,
      parent_category_id: null,
    };
    const line = planById.get(categoryId);
    const effectiveInformational =
      inheritedInformational ||
      line.tracking_mode === "informational";
    const planned = line.amount_minor;
    const actual = subtreeActual(categoryId);
    const infoRoots = effectiveInformational
      ? []
      : informationalRootsWithin(categoryId);
    const trackedPlanned = effectiveInformational
      ? 0
      : Math.max(
          0,
          planned -
            infoRoots.reduce(
              (sum, childId) =>
                sum + planById.get(childId).amount_minor,
              0,
            ),
        );
    const trackedActual = effectiveInformational
      ? 0
      : Math.max(
          0,
          actual -
            infoRoots.reduce(
              (sum, childId) => sum + subtreeActual(childId),
              0,
            ),
        );
    const childPlannedTotal = (
      selectedChildren.get(categoryId) ?? []
    ).reduce(
      (sum, childId) =>
        sum + Number(planById.get(childId)?.amount_minor ?? 0),
      0,
    );
    const childNodes = (selectedChildren.get(categoryId) ?? [])
      .sort((left, right) =>
        compareBudgetCategories(
          categoryById.get(left)?.path ?? left,
          categoryById.get(right)?.path ?? right,
        ),
      )
      .map((childId) =>
        makeNode(childId, depth + 1, effectiveInformational),
      );
    return {
      category_id: categoryId,
      parent_category_id: category.parent_category_id ?? null,
      category: category.path ?? category.name,
      name: category.name,
      depth,
      version: Number(line.version ?? 0),
      tracking_mode: line.tracking_mode,
      effective_tracking_mode: effectiveInformational
        ? "informational"
        : "tracked",
      planned: money(planned, currency),
      child_planned_total: money(childPlannedTotal, currency),
      unallocated_planned: money(
        Math.max(0, planned - childPlannedTotal),
        currency,
      ),
      actual: money(actual, currency),
      direct_actual: money(
        directActualById.get(categoryId) ?? 0,
        currency,
      ),
      tracked_planned: money(trackedPlanned, currency),
      tracked_actual: money(trackedActual, currency),
      remaining: effectiveInformational
        ? null
        : money(trackedPlanned - trackedActual, currency),
      over: money(
        effectiveInformational
          ? 0
          : Math.max(0, trackedActual - trackedPlanned),
        currency,
      ),
      progress_basis_points:
        effectiveInformational
          ? null
          : trackedPlanned === 0
            ? trackedActual === 0
              ? 0
              : null
            : Math.round((trackedActual * 10_000) / trackedPlanned),
      has_budget: line.has_budget !== false,
      children: childNodes,
    };
  };
  const groups = selectedRoots
    .sort((left, right) =>
      compareBudgetCategories(
        categoryById.get(left)?.path ?? left,
        categoryById.get(right)?.path ?? right,
      ),
    )
    .map((categoryId) => makeNode(categoryId));
  const lines = groups.flatMap(flattenBudgetNode);
  const plannedTotal = groups.reduce(
    (sum, group) => sum + group.planned.amount_minor,
    0,
  );
  const actualTotal = [...directActualById.values()].reduce(
    (sum, amount) => sum + amount,
    0,
  );
  const averageIncome = Number(income?.average_monthly_minor ?? 0);
  const actualIncome = Number(income?.actual_month_minor ?? 0);
  const estimatedLeftover = averageIncome - plannedTotal;
  const actualLeftover = actualIncome - actualTotal;
  const trackedOver = lines.filter(
    (line) =>
      line.effective_tracking_mode === "tracked" &&
      line.over.amount_minor > 0,
  );
  return {
    month_on: month,
    end_on: endOn,
    currency,
    planned_total: money(plannedTotal, currency),
    actual_total: money(actualTotal, currency),
    remaining_total: money(plannedTotal - actualTotal, currency),
    over_budget_category_count: trackedOver.length,
    average_monthly_income: money(averageIncome, currency),
    actual_income: money(actualIncome, currency),
    estimated_leftover: money(estimatedLeftover, currency),
    actual_leftover: money(actualLeftover, currency),
    income_month_count: Number(income?.month_count ?? 0),
    income_category_ids: income?.category_ids ?? [],
    plan_status:
      estimatedLeftover < 0 || trackedOver.length
        ? "needs_attention"
        : "on_track",
    groups,
    lines,
  };
}

function flattenBudgetNode(node) {
  const { children, ...flat } = node;
  return [
    flat,
    ...children.flatMap(flattenBudgetNode),
  ];
}

export function compareBudgetCategories(left, right) {
  const leftLabel = String(left);
  const rightLabel = String(right);
  const leftIsOther = leftLabel.trim().toLowerCase() === "other";
  const rightIsOther = rightLabel.trim().toLowerCase() === "other";
  if (leftIsOther !== rightIsOther) return leftIsOther ? 1 : -1;
  return (
    leftLabel.localeCompare(rightLabel, "en-US", {
      sensitivity: "base",
    }) || leftLabel.localeCompare(rightLabel, "en-US")
  );
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
    if (!validSplitSet(transaction, lines)) return [transaction];
    return lines.map((line) => ({
      ...transaction,
      id: `${transaction.id}:${line.id ?? line.line_index}`,
      category_primary: line.category,
      category_id: line.category_id ?? null,
      category_detailed: null,
      amount_minor: Number(line.amount_minor),
      is_fixed: Boolean(line.is_fixed),
      split_parent_id: transaction.id,
    }));
  });
}

function validSplitSet(transaction, lines) {
  if (!Array.isArray(lines) || lines.length < 2) return false;
  const parentAmount = Number(transaction.amount_minor);
  if (!Number.isSafeInteger(parentAmount) || parentAmount === 0) {
    return false;
  }
  let total = 0;
  for (const line of lines) {
    const amount = Number(line.amount_minor);
    if (
      !Number.isSafeInteger(amount) ||
      amount === 0 ||
      Math.sign(amount) !== Math.sign(parentAmount) ||
      typeof line.category !== "string" ||
      !line.category.trim()
    ) {
      return false;
    }
    total += amount;
    if (!Number.isSafeInteger(total)) return false;
  }
  return total === parentAmount;
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
    (selectedGoal?.spent?.amount_minor ?? 0) +
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
  const spending = Object.fromEntries(
    (goal.spending ?? []).map((entry) => {
      if (!SUPPORTED_SOURCES.has(entry.source)) {
        throw new TypeError("Unsupported goal spending source.");
      }
      return [entry.source, Number(entry.amount_minor)];
    }),
  );
  const hasRecordedAllocations = Array.isArray(
    goal.recorded_allocations,
  );
  const recordedAllocation = Object.fromEntries(
    (goal.recorded_allocations ?? []).map((entry) => {
      if (!SUPPORTED_SOURCES.has(entry.source)) {
        throw new TypeError("Unsupported goal allocation source.");
      }
      return [entry.source, Number(entry.amount_minor)];
    }),
  );
  if (!hasRecordedAllocations) {
    for (const source of SUPPORTED_SOURCES) {
      recordedAllocation[source] =
        (allocation[source] ?? 0) + (spending[source] ?? 0);
    }
  }
  for (const [label, value] of [
    ["cash earmark", allocation.cash ?? 0],
    ["brokerage earmark", allocation.brokerage ?? 0],
    ["cash spending", spending.cash ?? 0],
    ["brokerage spending", spending.brokerage ?? 0],
    ["recorded cash funding", recordedAllocation.cash ?? 0],
    [
      "recorded brokerage funding",
      recordedAllocation.brokerage ?? 0,
    ],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Goal ${label} cannot be negative.`);
    }
  }
  const remainingFunding = remainingGoalFunding({
    cashRecordedMinor: recordedAllocation.cash ?? 0,
    brokerageRecordedMinor:
      recordedAllocation.brokerage ?? 0,
    cashSpentMinor: spending.cash ?? 0,
    brokerageSpentMinor: spending.brokerage ?? 0,
  });
  return {
    ...goal,
    target_amount_minor: Number(goal.target_amount_minor),
    cash_earmarked_minor: remainingFunding.cash,
    brokerage_earmarked_minor: remainingFunding.brokerage,
    cash_spent_minor: spending.cash ?? 0,
    brokerage_spent_minor: spending.brokerage ?? 0,
    cash_recorded_minor: recordedAllocation.cash ?? 0,
    brokerage_recorded_minor:
      recordedAllocation.brokerage ?? 0,
    purpose: goal.purpose ?? DEFAULT_GOAL_PURPOSE,
  };
}

function goalSpendMetrics(goal, currency) {
  const spentMinor =
    goal.cash_spent_minor + goal.brokerage_spent_minor;
  const targetMinor = goal.target_amount_minor;
  const unfundedSpendMinor = Math.max(
    0,
    spentMinor -
      goal.cash_recorded_minor -
      goal.brokerage_recorded_minor,
  );
  return {
    target_amount: money(targetMinor, currency),
    planned: money(targetMinor, currency),
    actual: money(spentMinor, currency),
    plan_remaining: money(
      Math.max(0, targetMinor - spentMinor),
      currency,
    ),
    over_by: money(Math.max(0, spentMinor - targetMinor), currency),
    unfunded_spend: money(unfundedSpendMinor, currency),
    used_basis_points:
      targetMinor === 0
        ? null
        : Math.max(0, ratioBasisPoints(spentMinor, targetMinor)),
  };
}

function remainingGoalFunding({
  cashRecordedMinor,
  brokerageRecordedMinor,
  cashSpentMinor,
  brokerageSpentMinor,
}) {
  const cashDirect = Math.max(
    0,
    cashRecordedMinor - cashSpentMinor,
  );
  const brokerageDirect = Math.max(
    0,
    brokerageRecordedMinor - brokerageSpentMinor,
  );
  const cashOverrun = Math.max(
    0,
    cashSpentMinor - cashRecordedMinor,
  );
  const brokerageOverrun = Math.max(
    0,
    brokerageSpentMinor - brokerageRecordedMinor,
  );
  return {
    cash: Math.max(0, cashDirect - brokerageOverrun),
    brokerage: Math.max(0, brokerageDirect - cashOverrun),
  };
}

function medianInteger(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle];
  return Math.round((ordered[middle - 1] + ordered[middle]) / 2);
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
