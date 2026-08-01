import { createHash } from "node:crypto";

import {
  buildBalanceSummary,
  buildCreditSummary,
} from "./analytics.js";
import {
  normalizeMerchant,
  normalizeTransactionName,
} from "../providers/plaidNormalizer.js";
import {
  buildCreditScoreSummary,
} from "./creditScoreTracking.js";
import {
  buildInsightLlmRequest,
  DEFAULT_INSIGHT_LLM_SETTINGS,
  estimateInputTokens,
  LOCKED_RANKING_CONTRACT,
  validateInsightLlmSettings,
} from "./narrativeService.js";
import { DEMO_IDS } from "../demo/fixtureIds.js";
import {
  buildDefaultAccounts,
  buildDefaultBudgetDefaults,
  buildDefaultPortfolioHoldings,
  buildDefaultRecurringPayments,
  buildDefaultTransactions,
} from "../demo/defaultScenario.js";
import {
  buildUxStressTransactions,
  uxStressAccount,
} from "../demo/uxStressScenario.js";

const money = (amountMinor, currency = "USD") => ({
  amount_minor: amountMinor,
  currency,
});

const DATA_AS_OF = "2026-07-26T18:42:00.000Z";
const FRESHNESS = { synced_at: DATA_AS_OF, status: "fresh" };
const BASE_URL = "https://money.example.com";
const BALANCE_GROUPS = new Set([
  "cash",
  "taxable_investment",
  "retirement",
  "credit_card",
  "loan",
  "other_asset",
  "other_liability",
  "excluded",
]);

function result({
  summary,
  data,
  title,
  subtitle,
  path,
  warnings = [],
  partial = false,
}) {
  return {
    summary,
    data,
    data_as_of: DATA_AS_OF,
    partial,
    warnings,
    display: {
      title,
      subtitle,
      web_url: `${BASE_URL}${path}`,
    },
  };
}

const evidence = (entityType, entityId, label, path) => ({
  entity_type: entityType,
  entity_id: entityId,
  label,
  web_url: `${BASE_URL}${path}`,
});

const weeklyFindings = [
  {
    id: DEMO_IDS.insights.weeklyDining,
    family: "weekly",
    state: "active",
    type: "spend_less",
    severity: "attention",
    title: "Dining jumped 38% this week",
    explanation:
      "Nine dining purchases totaled $458.20, up $126.40 from the preceding seven days.",
    metrics: {
      current_amount: money(45_820),
      previous_amount: money(33_180),
      change: {
        amount: money(12_640),
        percent_basis_points: 3_809,
        direction: "up",
      },
      current_transaction_count: 9,
      previous_transaction_count: 5,
    },
    rule: "flexible_spend_increase",
    confidence_basis_points: 9_400,
    evidence: [
      evidence(
        "transaction",
        "txn_dining_1",
        "Dining purchases",
        "/transactions?category=Dining",
      ),
    ],
    actions: ["review", "recategorize", "dismiss"],
  },
  {
    id: DEMO_IDS.insights.weeklyCoffee,
    family: "weekly",
    state: "active",
    type: "better_habits",
    severity: "info",
    title: "Five small coffee stops added up",
    explanation:
      "Coffee purchases occurred on five days and totaled $46.25, twice the prior week.",
    metrics: {
      current_amount: money(4_625),
      previous_amount: money(2_190),
      change: {
        amount: money(2_435),
        percent_basis_points: 11_119,
        direction: "up",
      },
      current_transaction_count: 5,
      previous_transaction_count: 2,
    },
    rule: "repeated_convenience_spending",
    confidence_basis_points: 8_700,
    evidence: [
      evidence(
        "merchant",
        "merchant_blue_bottle",
        "Blue Bottle Coffee purchases",
        "/transactions?q=Blue%20Bottle",
      ),
    ],
    actions: ["review", "mark_expected", "dismiss"],
  },
  {
    id: DEMO_IDS.insights.weeklyTravel,
    family: "weekly",
    state: "active",
    type: "needs_review",
    severity: "attention",
    title: "One travel charge explains the spike",
    explanation:
      "A $486.20 airline purchase caused 92% of the travel category increase.",
    metrics: {
      transaction_amount: money(48_620),
      category_change_amount: money(52_840),
      contribution_basis_points: 9_200,
    },
    rule: "single_transaction_category_spike",
    confidence_basis_points: 9_800,
    evidence: [
      evidence(
        "transaction",
        DEMO_IDS.transactions.delta,
        "Delta Air Lines",
        `/transactions?transaction=${DEMO_IDS.transactions.delta}`,
      ),
    ],
    actions: ["review", "recategorize", "mark_expected", "dismiss"],
  },
];

const investmentFindings = [
  {
    id: DEMO_IDS.insights.investmentPerformance,
    family: "investments",
    state: "active",
    type: "performance",
    severity: "info",
    title: "Portfolio gained 1.8% this month",
    explanation:
      "Estimated performance is $2,191 after separating $1,200 of contributions.",
    metrics: {
      value_change: money(339_100),
      contributions: money(120_000),
      withdrawals: money(0),
      estimated_performance: money(219_100),
      estimated_performance_basis_points: 180,
    },
    rule: "cash_flow_adjusted_value_change",
    confidence_basis_points: 9_100,
    evidence: [
      evidence(
        "portfolio_snapshot",
        "snapshot_2026_07",
        "July portfolio snapshots",
        "/portfolio?period=1m",
      ),
    ],
    actions: ["review", "dismiss"],
  },
  {
    id: DEMO_IDS.insights.investmentConcentration,
    family: "investments",
    state: "active",
    type: "concentration",
    severity: "attention",
    title: "VTI is 31% of the portfolio",
    explanation:
      "The holding is above the configured 25% concentration marker. This is descriptive, not a trade recommendation.",
    metrics: {
      holding_value: money(3_827_442),
      allocation_basis_points: 3_100,
      threshold_basis_points: 2_500,
    },
    rule: "single_security_concentration",
    confidence_basis_points: 10_000,
    evidence: [
      evidence(
        "holding",
        DEMO_IDS.holdings.vti,
        "VTI holding",
        "/portfolio?holding=holding_vti",
      ),
    ],
    actions: ["review", "dismiss"],
  },
];

const subscriptionFindings = [
  {
    id: DEMO_IDS.insights.subscriptionDuplicate,
    family: "subscriptions",
    state: "active",
    type: "possible_duplicate",
    severity: "attention",
    title: "Two Apple service charges may overlap",
    explanation:
      "Apple Services and iCloud+ charge the same card on separate dates.",
    metrics: {
      monthly_equivalent: money(3_802),
      annualized_cost: money(45_624),
      stream_count: 2,
    },
    rule: "overlapping_service_family",
    confidence_basis_points: 7_200,
    evidence: [
      evidence(
        "recurring_stream",
        DEMO_IDS.recurring.appleServices,
        "Apple Services",
        `/recurring?item=${DEMO_IDS.recurring.appleServices}`,
      ),
      evidence(
        "recurring_stream",
        DEMO_IDS.recurring.iCloud,
        "iCloud+",
        `/recurring?item=${DEMO_IDS.recurring.iCloud}`,
      ),
    ],
    actions: ["confirm", "dismiss"],
  },
  {
    id: DEMO_IDS.insights.subscriptionExpensive,
    family: "subscriptions",
    state: "active",
    type: "expensive",
    severity: "info",
    title: "Google Workspace is the priciest subscription",
    explanation:
      "At $85.64 a month, it represents 36% of detected subscription spending.",
    metrics: {
      monthly_equivalent: money(8_564),
      annualized_cost: money(102_768),
      share_basis_points: 3_589,
    },
    rule: "monthly_cost_threshold",
    confidence_basis_points: 9_900,
    evidence: [
      evidence(
        "recurring_stream",
        DEMO_IDS.recurring.googleWorkspace,
        "Google Workspace",
        `/recurring?item=${DEMO_IDS.recurring.googleWorkspace}`,
      ),
    ],
    actions: ["review", "dismiss"],
  },
];

function buildDemoInsightFindings() {
  return structuredClone([
    ...weeklyFindings,
    ...investmentFindings,
    ...subscriptionFindings,
    {
      ...weeklyFindings[0],
      id: DEMO_IDS.insights.archivedWeeklyDining,
      state: "archived",
    },
    {
      ...subscriptionFindings[0],
      id: DEMO_IDS.insights.archivedSubscriptionDuplicate,
      state: "bad",
    },
  ]);
}

const creditSnapshots = [
  {
    account_id: "account_sapphire",
    snapshot_on: "2026-06-26",
    current_balance_minor: 248_000,
    credit_limit_minor: 700_000,
    currency_code: "USD",
  },
  {
    account_id: "account_amex",
    snapshot_on: "2026-06-26",
    current_balance_minor: 103_000,
    credit_limit_minor: 500_000,
    currency_code: "USD",
  },
  {
    account_id: "account_sapphire",
    snapshot_on: "2026-07-03",
    current_balance_minor: 220_000,
    credit_limit_minor: 700_000,
    currency_code: "USD",
  },
  {
    account_id: "account_amex",
    snapshot_on: "2026-07-03",
    current_balance_minor: 92_000,
    credit_limit_minor: 500_000,
    currency_code: "USD",
  },
  {
    account_id: "account_sapphire",
    snapshot_on: "2026-07-10",
    current_balance_minor: 198_000,
    credit_limit_minor: 700_000,
    currency_code: "USD",
  },
  {
    account_id: "account_amex",
    snapshot_on: "2026-07-10",
    current_balance_minor: 81_000,
    credit_limit_minor: 500_000,
    currency_code: "USD",
  },
  {
    account_id: "account_sapphire",
    snapshot_on: "2026-07-17",
    current_balance_minor: 165_000,
    credit_limit_minor: 700_000,
    currency_code: "USD",
  },
  {
    account_id: "account_amex",
    snapshot_on: "2026-07-17",
    current_balance_minor: 75_000,
    credit_limit_minor: 500_000,
    currency_code: "USD",
  },
  {
    account_id: "account_sapphire",
    snapshot_on: "2026-07-24",
    current_balance_minor: 193_240,
    credit_limit_minor: 700_000,
    currency_code: "USD",
  },
  {
    account_id: "account_amex",
    snapshot_on: "2026-07-24",
    current_balance_minor: 88_223,
    credit_limit_minor: 500_000,
    currency_code: "USD",
  },
];

function analyticsAccount(account) {
  return {
    id: account.id,
    institution_name: account.institution_name,
    name: account.name,
    mask: account.mask,
    type: account.type,
    subtype: account.subtype,
    balance_group: account.balance_group,
    balance_group_override: account.balance_group_override ?? null,
    current_balance_minor:
      account.current_balance?.amount_minor ?? null,
    available_balance_minor:
      account.available_balance?.amount_minor ?? null,
    credit_limit_minor:
      account.credit_limit?.amount_minor ?? null,
    currency_code:
      account.current_balance?.currency ??
      account.credit_limit?.currency ??
      "USD",
    is_liability: account.is_liability,
    active: account.active,
  };
}

const portfolioHoldings = buildDefaultPortfolioHoldings();

const contributionsByAccount = new Map([
  ["account_brokerage", 70_000],
  ["account_roth", 20_000],
  ["account_401k", 30_000],
]);

const DEMO_TRANSACTION_TAGS = Object.freeze([
  "Business",
  "Reimbursable",
  "Tax",
]);

const DEMO_TRANSACTION_CLEANUP_RULES = Object.freeze([
  {
    id: "cleanup_rule_demo_whole_foods",
    matcher: {
      field: "normalized_merchant",
      value: "WHOLE FOODS MKT #1024",
      normalized_value: "whole foods mkt",
    },
    changes: {
      display_name: "Whole Foods Market",
      category_primary: "Groceries",
      tags: ["Business"],
    },
    enabled: true,
    created_at: "2026-07-27T10:00:00.000Z",
    updated_at: "2026-07-27T10:00:00.000Z",
  },
]);

function demoCategoryId(path) {
  return `category_${String(path)
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;
}

function buildDemoSpendingCategories(transactions) {
  const planned = buildDefaultBudgetDefaults();
  const paths = new Set([
    ...planned.keys(),
    ...transactions.map(
      (transaction) =>
        transaction.category_primary ?? transaction.category,
    ),
    "Other",
  ]);
  return [...paths]
    .filter(Boolean)
    .sort((left, right) => {
      if (left === "Other") return 1;
      if (right === "Other") return -1;
      return left.localeCompare(right);
    })
    .map((path) => ({
      id: demoCategoryId(path),
      name: path,
      path,
      depth: 0,
      classification: ["Housing", "Utilities", "Bills"].includes(path)
        ? "fixed"
        : "flexible",
      parent_category_id: null,
      version: 1,
      aliases: [{ label: path }],
      is_system: path === "Other",
      status: "active",
      budget_line_count: planned.has(path) ? 1 : 0,
      merged_into_category_id: null,
      merged_into_path: null,
      merged_transaction_ids: [],
    }));
}

function demoCategoryError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

function cloneDemoCategory(category) {
  const {
    merged_transaction_ids: ignoredMergedTransactionIds,
    ...publicCategory
  } = category;
  return {
    ...publicCategory,
    aliases: (category.aliases ?? []).map((alias) => ({ ...alias })),
  };
}

function cloneDemoTransaction(transaction) {
  const rawMerchant = transaction.raw_merchant ?? transaction.merchant;
  const rawName = transaction.raw_name ?? transaction.description;
  const rawCategory =
    transaction.raw_category_primary ?? transaction.category;
  return {
    ...transaction,
    account: { ...transaction.account },
    amount: { ...transaction.amount },
    raw_merchant: rawMerchant,
    raw_name: rawName,
    raw_category_primary: rawCategory,
    display_name: transaction.display_name ?? rawMerchant ?? rawName,
    note: transaction.note ?? null,
    note_version: Number(transaction.note_version ?? 0),
    note_updated_by: transaction.note_updated_by ?? null,
    note_updated_at: transaction.note_updated_at ?? null,
    budget_month_on: transaction.budget_month_on ?? null,
    category_primary: transaction.category_primary ?? rawCategory,
    tags: [...(transaction.tags ?? [])],
  };
}

function publicDemoTransaction(transaction) {
  return {
    ...transaction,
    account: { ...transaction.account },
    amount: { ...transaction.amount },
    tags: [...transaction.tags],
    split_version: Number(transaction.split_version ?? 0),
  };
}

function demoRecurringCadenceFactor(cadence) {
  return {
    weekly: 52 / 12,
    biweekly: 26 / 12,
    monthly: 1,
    quarterly: 1 / 3,
    annual: 1 / 12,
  }[cadence];
}

function demoNextRecurringDate(value, cadence) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (cadence === "weekly") date.setUTCDate(date.getUTCDate() + 7);
  else if (cadence === "biweekly") {
    date.setUTCDate(date.getUTCDate() + 14);
  } else if (cadence === "monthly") {
    date.setUTCMonth(date.getUTCMonth() + 1);
  } else if (cadence === "quarterly") {
    date.setUTCMonth(date.getUTCMonth() + 3);
  } else {
    date.setUTCFullYear(date.getUTCFullYear() + 1);
  }
  return date.toISOString().slice(0, 10);
}

function normalizedMatchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function encodeDemoTransactionCursor(offset) {
  return Buffer.from(
    JSON.stringify({ kind: "demo-transactions", offset }),
  ).toString("base64url");
}

function decodeDemoTransactionCursor(cursor) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      parsed.kind !== "demo-transactions" ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw new TypeError();
    }
    return parsed.offset;
  } catch {
    const error = new TypeError("Invalid transaction cursor");
    error.statusCode = 400;
    throw error;
  }
}

function compareDemoServiceTransactions(left, right, sort) {
  const newestFirst =
    String(right.posted_on ?? right.date).localeCompare(
      String(left.posted_on ?? left.date),
    ) || String(right.id).localeCompare(String(left.id));
  if (sort === "merchant" || sort === "category") {
    const leftValue =
      sort === "merchant"
        ? left.display_name ?? left.merchant
        : left.category_primary ?? left.category;
    const rightValue =
      sort === "merchant"
        ? right.display_name ?? right.merchant
        : right.category_primary ?? right.category;
    return (
      String(leftValue ?? "").localeCompare(
        String(rightValue ?? ""),
        undefined,
        { sensitivity: "base" },
      ) || newestFirst
    );
  }
  if (sort === "cost") {
    const leftAmount = Number(left.amount?.amount_minor ?? 0);
    const rightAmount = Number(right.amount?.amount_minor ?? 0);
    const leftSpend = leftAmount < 0 ? Math.abs(leftAmount) : -1;
    const rightSpend = rightAmount < 0 ? Math.abs(rightAmount) : -1;
    return rightSpend - leftSpend || newestFirst;
  }
  return newestFirst;
}

function shiftDemoTransactionMonth(value, offset) {
  const date = new Date(`${String(value).slice(0, 7)}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 10);
}

function cloneTransactionCleanupRule(rule) {
  return {
    id: rule.id,
    matcher: {
      ...rule.matcher,
      mode: rule.matcher.mode ?? "exact",
    },
    changes: {
      ...rule.changes,
      ...(Object.hasOwn(rule.changes, "tags")
        ? { tags: [...rule.changes.tags] }
        : {}),
    },
    enabled: rule.enabled,
    created_at: rule.created_at,
    updated_at: rule.updated_at,
  };
}

function transactionCleanupRuleError(message, statusCode = 400) {
  const error = new TypeError(message);
  error.statusCode = statusCode;
  return error;
}

function validatedTransactionCleanupMatcher(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw transactionCleanupRuleError("matcher is required");
  }
  const field = String(input.field ?? input.match_field ?? "").trim();
  if (!["normalized_merchant", "normalized_name"].includes(field)) {
    throw transactionCleanupRuleError(
      "matcher.field must be normalized_merchant or normalized_name",
    );
  }
  const mode = String(input.mode ?? input.match_mode ?? "exact").trim();
  if (!["exact", "contains"].includes(mode)) {
    throw transactionCleanupRuleError(
      "matcher.mode must be exact or contains",
    );
  }
  const value = String(
    input.value ?? input.match_value ?? "",
  ).trim();
  if (!value || value.length > 160) {
    throw transactionCleanupRuleError(
      "matcher.value must be between 1 and 160 characters",
    );
  }
  const normalizedValue =
    field === "normalized_merchant"
      ? normalizeMerchant(value)
      : normalizeTransactionName(value);
  if (!normalizedValue || normalizedValue.length > 160) {
    throw transactionCleanupRuleError(
      "matcher.value must produce between 1 and 160 normalized characters",
    );
  }
  if (mode === "contains" && normalizedValue.length < 3) {
    throw transactionCleanupRuleError(
      "contains matchers require at least 3 normalized characters",
    );
  }
  return {
    field,
    mode,
    value,
    normalized_value: normalizedValue,
  };
}

function validatedTransactionCleanupChanges(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw transactionCleanupRuleError("changes are required");
  }
  const unsupported = Object.keys(input).filter(
    (field) =>
      !["display_name", "category_primary", "tags"].includes(field),
  );
  if (unsupported.length) {
    throw transactionCleanupRuleError(
      "changes contain an unsupported field",
    );
  }
  const changes = {};
  if (Object.hasOwn(input, "display_name")) {
    const displayName = String(input.display_name ?? "").trim();
    if (!displayName || displayName.length > 160) {
      throw transactionCleanupRuleError(
        "changes.display_name must be between 1 and 160 characters",
      );
    }
    changes.display_name = displayName;
  }
  if (Object.hasOwn(input, "category_primary")) {
    const category = String(input.category_primary ?? "").trim();
    if (!category || category.length > 100) {
      throw transactionCleanupRuleError(
        "changes.category_primary must be between 1 and 100 characters",
      );
    }
    changes.category_primary = category;
  }
  if (Object.hasOwn(input, "tags")) {
    if (!Array.isArray(input.tags) || input.tags.length > 20) {
      throw transactionCleanupRuleError(
        "changes.tags must be an array with at most 20 tags",
      );
    }
    const tags = input.tags.map((tag) => String(tag).trim());
    if (
      tags.some((tag) => !tag || tag.length > 64) ||
      new Set(tags.map((tag) => tag.toLowerCase())).size !== tags.length
    ) {
      throw transactionCleanupRuleError(
        "changes.tags must contain unique, nonblank tags",
      );
    }
    changes.tags = tags;
  }
  if (!Object.keys(changes).length) {
    throw transactionCleanupRuleError(
      "At least one transaction change is required",
    );
  }
  return changes;
}

function trigrams(value) {
  const normalized = `  ${normalizedMatchText(value)}  `;
  const values = new Set();
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    values.add(normalized.slice(index, index + 3));
  }
  return values;
}

function matchScore(query, transaction) {
  const needle = normalizedMatchText(query);
  const fields = [
    transaction.display_name,
    transaction.raw_merchant,
    transaction.raw_name,
  ].map(normalizedMatchText);
  if (!needle) return 0;
  if (fields.some((field) => field === needle)) return 10_000;
  if (fields.some((field) => field.startsWith(needle))) return 9_700;
  if (fields.some((field) => field.includes(needle))) return 9_300;

  const needleTrigrams = trigrams(needle);
  let best = 0;
  for (const field of fields) {
    const fieldTrigrams = trigrams(field);
    const intersection = [...needleTrigrams].filter((value) =>
      fieldTrigrams.has(value),
    ).length;
    const union = new Set([...needleTrigrams, ...fieldTrigrams]).size;
    best = Math.max(best, union ? Math.round((intersection / union) * 10_000) : 0);
  }
  return best;
}

function matchReason({ transaction, anchor, query, score }) {
  if (transaction.id === anchor?.id) return "anchor";
  if (
    anchor &&
    normalizedMatchText(transaction.raw_merchant) ===
      normalizedMatchText(anchor.raw_merchant)
  ) {
    return "exact_merchant";
  }
  const normalizedQuery = normalizedMatchText(query);
  const fields = [
    transaction.display_name,
    transaction.raw_merchant,
    transaction.raw_name,
  ].map(normalizedMatchText);
  if (fields.some((field) => field === normalizedQuery)) return "exact";
  if (score >= 9_300) return "text_match";
  return "similar";
}

function transactionMatchRow(
  transaction,
  { anchor = null, query, score, preselected = false },
) {
  return {
    id: transaction.id,
    display_name: transaction.display_name,
    raw_merchant: transaction.raw_merchant,
    raw_name: transaction.raw_name,
    category_primary: transaction.category_primary,
    tags: [...transaction.tags].sort((left, right) =>
      left.localeCompare(right),
    ),
    posted_on: transaction.date,
    account_name: transaction.account.name,
    amount: { ...transaction.amount },
    similarity_basis_points: score,
    match_reason: matchReason({
      transaction,
      anchor,
      query,
      score,
    }),
    preselected,
  };
}

export class DemoFinanceService {
  #scenario;
  #accounts;
  #accountGroups = new Map();
  #transactions;
  #recurring;
  #recurringPatterns = new Map();
  #transactionBaselines;
  #spendingCategories;
  #spendingCategorySequence = 1;
  #insightFindings;
  #manualTransactionFields = new Map();
  #availableTransactionTags = new Set(DEMO_TRANSACTION_TAGS);
  #transactionCleanupRules = new Map(
    DEMO_TRANSACTION_CLEANUP_RULES.map((rule) => [
      rule.id,
      cloneTransactionCleanupRule(rule),
    ]),
  );
  #transactionCleanupRuleSequence =
    DEMO_TRANSACTION_CLEANUP_RULES.length + 1;
  #transactionCleanupRuleRevision = 1;
  #manualAssets = new Map([
    [
      "asset_001",
      {
        id: "asset_001",
        name: "2024 vehicle",
        asset_type: "vehicle",
        description: "Current private-party estimate",
        currency_code: "USD",
        value_minor: 3_471_461,
        valued_on: "2026-07-26",
        active: true,
      },
    ],
  ]);
  #manualAssetSequence = 1;
  #creditScoreSourceSequence = 3;
  #creditScoreObservationSequence = 5;
  #insightStatus = {
    state: "ready",
    enabled: true,
    can_run: true,
    pause_reasons: [],
    data_stale: false,
    data_warnings: [],
    freshness_data_as_of: DATA_AS_OF,
    current_job_type: null,
    last_run_at: "2026-07-27T09:02:00.000Z",
    last_run_status: "succeeded",
    last_error: null,
    next_scheduled_at: "2026-07-28T09:00:00.000Z",
    last_findings_generated_at: "2026-07-27T09:02:00.000Z",
    active_count: 7,
    archived_count: 2,
    total_count: 9,
  };
  #insightLlmSettings = {
    ...structuredClone(DEFAULT_INSIGHT_LLM_SETTINGS),
    revision: 1,
  };
  #insightLlmCallStatuses = {
    weekly: {
      family: "weekly",
      run_id: "demo-insight-run-1",
      guidance_revision: 1,
      model: "demo-finance-ranker",
      status: "succeeded",
      estimated_input_tokens: 742,
      prompt_tokens: 701,
      completion_tokens: 44,
      total_tokens: 745,
      context_length: 8_192,
      finish_reason: "stop",
      latency_ms: 286,
      called_at: "2026-07-27T09:02:00.000Z",
    },
  };
  #creditScoreSources = [
    {
      id: "score_source_amex",
      user_id: "demo-user",
      label: "American Express",
      bureau: "Experian",
      model: "FICO Score 8",
      archived_on: null,
    },
    {
      id: "score_source_credit_karma",
      user_id: "demo-user",
      label: "Credit Karma–TransUnion",
      bureau: "TransUnion",
      model: "VantageScore 3.0",
      archived_on: null,
    },
    {
      id: "score_source_partner",
      user_id: "demo-partner",
      label: "Experian",
      bureau: "Experian",
      model: "FICO Score 8",
      archived_on: null,
    },
  ];
  #creditScoreObservations = [
    {
      id: "score_observation_1",
      source_id: "score_source_amex",
      observed_on: "2025-11-14",
      score: 732,
    },
    {
      id: "score_observation_2",
      source_id: "score_source_amex",
      observed_on: "2026-07-20",
      score: 746,
    },
    {
      id: "score_observation_3",
      source_id: "score_source_credit_karma",
      observed_on: "2026-07-18",
      score: 738,
    },
    {
      id: "score_observation_4",
      source_id: "score_source_partner",
      observed_on: "2026-07-10",
      score: 765,
    },
  ];

  constructor({
    scenario = "default",
    insightsPaused = false,
  } = {}) {
    this.#scenario = scenario;
    if (insightsPaused) {
      this.#insightStatus = {
        ...this.#insightStatus,
        state: "paused",
        enabled: false,
        can_run: false,
        pause_reasons: [
          {
            code: "manual_pause",
            message: "Insights were paused manually.",
          },
        ],
        data_stale: true,
        data_warnings: [
          {
            code: "connection_attention",
            message:
              "Connected finance data is stale or incomplete.",
          },
        ],
      };
    }
    const defaultAccounts = buildDefaultAccounts();
    this.#accounts =
      scenario === "ux-stress"
        ? [...defaultAccounts, uxStressAccount()]
        : defaultAccounts;
    this.#transactions = [
      ...buildDefaultTransactions(),
      ...(scenario === "ux-stress"
        ? buildUxStressTransactions()
        : []),
    ].map(cloneDemoTransaction);
    this.#recurring = buildDefaultRecurringPayments();
    this.#insightFindings = new Map(
      buildDemoInsightFindings().map((finding) => [
        finding.id,
        finding,
      ]),
    );
    this.#spendingCategories = new Map(
      buildDemoSpendingCategories(this.#transactions).map((category) => [
        category.id,
        category,
      ]),
    );
    this.#transactionBaselines = new Map(
      this.#transactions.map((transaction) => [
        transaction.id,
        {
          display_name: transaction.display_name,
          category_primary: transaction.category_primary,
          tags: [...transaction.tags],
        },
      ]),
    );
    this.#refreshTransactionCleanupRuleApplications();
  }

  #transactionCleanupRuleTimestamp() {
    const timestamp = new Date(
      Date.parse("2026-07-27T10:00:00.000Z") +
        this.#transactionCleanupRuleRevision * 1_000,
    ).toISOString();
    this.#transactionCleanupRuleRevision += 1;
    return timestamp;
  }

  #transactionCleanupRuleMatchCount(rule) {
    return this.#transactions.filter((transaction) => {
      if (transaction.pending) return false;
      return (
        rule.enabled &&
        this.#winningTransactionCleanupRule(transaction)?.id ===
          rule.id
      );
    }).length;
  }

  #winningTransactionCleanupRule(transaction) {
    return [...this.#transactionCleanupRules.values()]
      .filter((rule) => {
        if (!rule.enabled) return false;
        const value =
          rule.matcher.field === "normalized_merchant"
            ? normalizeMerchant(transaction.raw_merchant)
            : normalizeTransactionName(transaction.raw_name);
        return (rule.matcher.mode ?? "exact") === "contains"
          ? value.includes(rule.matcher.normalized_value)
          : value === rule.matcher.normalized_value;
      })
      .sort(
        (left, right) =>
          Number((right.matcher.mode ?? "exact") === "exact") -
            Number((left.matcher.mode ?? "exact") === "exact") ||
          Number(right.matcher.field === "normalized_merchant") -
            Number(left.matcher.field === "normalized_merchant") ||
          right.matcher.normalized_value.length -
            left.matcher.normalized_value.length ||
          right.updated_at.localeCompare(left.updated_at) ||
          right.id.localeCompare(left.id),
      )[0] ?? null;
  }

  #refreshTransactionCleanupRuleApplications() {
    for (const transaction of this.#transactions) {
      const baseline = this.#transactionBaselines.get(transaction.id);
      const manual =
        this.#manualTransactionFields.get(transaction.id) ?? new Set();
      const winner = this.#winningTransactionCleanupRule(transaction);

      if (!manual.has("display_name")) {
        transaction.display_name =
          winner?.changes.display_name ?? baseline.display_name;
        transaction.merchant = transaction.display_name;
      }
      if (!manual.has("category_primary")) {
        transaction.category_primary =
          winner?.changes.category_primary ??
          baseline.category_primary;
        transaction.category = transaction.category_primary;
      }
      if (!manual.has("tags")) {
        transaction.tags = Object.hasOwn(
          winner?.changes ?? {},
          "tags",
        )
          ? [...winner.changes.tags]
          : [...baseline.tags];
      }
    }
  }

  #publicTransactionCleanupRule(rule) {
    return {
      ...cloneTransactionCleanupRule(rule),
      matched_transaction_count:
        this.#transactionCleanupRuleMatchCount(rule),
    };
  }

  #assertUniqueTransactionCleanupMatcher(matcher, excludingId = null) {
    const duplicate = [...this.#transactionCleanupRules.values()].find(
      (rule) =>
        rule.id !== excludingId &&
        rule.matcher.field === matcher.field &&
        (rule.matcher.mode ?? "exact") === matcher.mode &&
        rule.matcher.normalized_value === matcher.normalized_value,
    );
    if (duplicate) {
      throw transactionCleanupRuleError(
        "A cleanup rule already uses this matcher",
        409,
      );
    }
  }

  #refreshSpendingCategoryPaths() {
    const resolvePath = (category, seen = new Set()) => {
      if (!category) return null;
      if (seen.has(category.id)) {
        throw demoCategoryError(
          "A category cannot be nested under itself or a descendant.",
        );
      }
      if (!category.parent_category_id) return category.name;
      const parent = this.#spendingCategories.get(
        category.parent_category_id,
      );
      if (!parent || parent.status !== "active") {
        throw demoCategoryError("Parent category not found", 404);
      }
      return `${resolvePath(parent, new Set([...seen, category.id]))} / ${category.name}`;
    };
    for (const category of this.#spendingCategories.values()) {
      if (category.status === "active") {
        category.path = resolvePath(category);
        category.depth = category.path.split(" / ").length - 1;
      }
    }
  }

  #spendingCategoryByPath(path, excludingId = null) {
    const normalized = normalizedMatchText(path);
    return [...this.#spendingCategories.values()].find(
      (category) =>
        category.id !== excludingId &&
        category.status === "active" &&
        normalizedMatchText(category.path) === normalized,
    );
  }

  #assertSpendingCategoryVersion(category, expectedVersion) {
    const version = Number(expectedVersion);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw demoCategoryError(
        "expected_version must be a positive integer",
      );
    }
    if (version !== category.version) {
      throw demoCategoryError(
        "The category changed before this edit. Refresh and try again.",
        409,
      );
    }
  }

  #createSpendingCategoryRecord({
    name,
    classification = "flexible",
    parentCategoryId = null,
  }) {
    const normalizedName = String(name ?? "").trim();
    if (!normalizedName || normalizedName.length > 100) {
      throw demoCategoryError(
        "name must be between 1 and 100 characters",
      );
    }
    if (!["fixed", "flexible"].includes(classification)) {
      throw demoCategoryError(
        "classification must be fixed or flexible",
      );
    }
    const parent = parentCategoryId
      ? this.#spendingCategories.get(parentCategoryId)
      : null;
    if (
      parentCategoryId &&
      (!parent || parent.status !== "active" || parent.is_system)
    ) {
      throw demoCategoryError("Parent category not found", 404);
    }
    const path = parent
      ? `${parent.path} / ${normalizedName}`
      : normalizedName;
    if (this.#spendingCategoryByPath(path)) {
      throw demoCategoryError(
        "That category name or alias already exists. Merge it instead.",
        409,
      );
    }
    const baseId = demoCategoryId(path);
    let id = baseId;
    while (this.#spendingCategories.has(id)) {
      id = `${baseId}_${this.#spendingCategorySequence}`;
      this.#spendingCategorySequence += 1;
    }
    const category = {
      id,
      name: normalizedName,
      path,
      depth: parent ? parent.depth + 1 : 0,
      classification,
      parent_category_id: parent?.id ?? null,
      version: 1,
      aliases: [{ label: path }],
      is_system: false,
      status: "active",
      budget_line_count: 0,
      merged_into_category_id: null,
      merged_into_path: null,
      merged_transaction_ids: [],
    };
    this.#spendingCategories.set(id, category);
    return category;
  }

  #publicSpendingCategory(category) {
    const transactionCount =
      category.status === "merged"
        ? category.merged_transaction_ids.length
        : this.#transactions.filter(
            (transaction) =>
              (transaction.category_primary ??
                transaction.category) === category.path,
          ).length;
    return {
      ...cloneDemoCategory(category),
      transaction_count: transactionCount,
      merged_into_path: category.merged_into_category_id
        ? this.#spendingCategories.get(
            category.merged_into_category_id,
          )?.path ?? category.merged_into_path
        : null,
    };
  }

  #reassignCategoryTransactions(fromPath, toPath) {
    const transactionIds = [];
    for (const transaction of this.#transactions) {
      if (
        (transaction.category_primary ?? transaction.category) !==
        fromPath
      ) {
        continue;
      }
      transaction.category_primary = toPath;
      transaction.category = toPath;
      transactionIds.push(transaction.id);
    }
    return transactionIds;
  }

  #accountCards() {
    const groupedAccounts = this.#accounts.map((account) => {
      const hasOverride =
        this.#accountGroups.has(account.id) &&
        this.#accountGroups.get(account.id) != null;
      const override = hasOverride
        ? this.#accountGroups.get(account.id)
        : null;
      return {
        ...account,
        balance_group: override ?? account.balance_group,
        balance_group_override: override,
        balance_group_source: hasOverride ? "override" : "inferred",
      };
    });
    const creditCards = new Map(
      buildCreditSummary({
        accounts: groupedAccounts.map(analyticsAccount),
        currency: "USD",
      }).cards.map((card) => [card.id, card]),
    );
    return groupedAccounts.map((account) => {
      const credit = creditCards.get(account.id);
      return credit
        ? {
            ...account,
            balance_owed: credit.balance_owed,
            credit_limit: credit.credit_limit,
            available_credit: credit.available_credit,
            utilization_basis_points:
              credit.utilization_basis_points,
            over_limit: credit.over_limit,
          }
        : account;
    });
  }

  #manualAssetCards({ includeInactive = false } = {}) {
    return [...this.#manualAssets.values()]
      .filter((asset) => includeInactive || asset.active)
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        asset_type: asset.asset_type,
        description: asset.description ?? null,
        current_value:
          asset.value_minor == null
            ? null
            : money(asset.value_minor, asset.currency_code),
        valued_on: asset.valued_on ?? null,
        active: asset.active !== false,
      }));
  }

  #balanceSummary() {
    return buildBalanceSummary({
      accounts: this.#accountCards().map((account) => ({
        type: account.type,
        subtype: account.subtype,
        is_liability: account.is_liability,
        balance_group: account.balance_group,
        balance_group_override: account.balance_group_override,
        current_balance_minor:
          account.current_balance?.amount_minor ?? null,
        credit_limit_minor:
          account.credit_limit?.amount_minor ?? null,
        currency_code: account.current_balance?.currency ?? "USD",
      })),
      manualAssets: [...this.#manualAssets.values()],
      currency: "USD",
    });
  }

  async getFinanceOverview() {
    const balanceSummary = this.#balanceSummary();
    const manualAssets = this.#manualAssetCards();
    const portfolioValue =
      balanceSummary.taxable_investments.amount_minor +
      balanceSummary.retirement_assets.amount_minor;
    return result({
      title: "Finance overview",
      subtitle: "July 2026",
      path: "/",
      summary:
        `Cash balance is ${(balanceSummary.cash_balance.amount_minor / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}, short-term worth is ${(balanceSummary.short_term_worth.amount_minor / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}, and net worth is ${(balanceSummary.net_worth.amount_minor / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}. July spending is $4,126.84. Data is fresh as of July 26 at 6:42 PM UTC.`,
      data: {
        period: { start_on: "2026-07-01", end_on: "2026-08-01" },
        ...balanceSummary,
        assets: balanceSummary.total_assets,
        liabilities: balanceSummary.total_liabilities,
        portfolio: money(portfolioValue),
        portfolio_value: money(portfolioValue),
        spending: money(412_684),
        income: money(930_000),
        cash_flow: money(517_316),
        subscriptions_monthly: money(23_864),
        account_count: balanceSummary.included_account_count,
        manual_assets: manualAssets,
        manual_asset_count: manualAssets.length,
        freshness: FRESHNESS,
      },
    });
  }

  async getFinanceInsights({
    section = "all",
    view = "active",
  } = {}) {
    if (
      !["all", "weekly", "investments", "subscriptions"].includes(
        section,
      )
    ) {
      throw new TypeError(
        "section must be all, weekly, investments, or subscriptions",
      );
    }
    const insightView = view === "archive" ? "archive" : "active";
    const visibleFindings = [...this.#insightFindings.values()].filter(
      (finding) =>
        insightView === "active"
          ? finding.state === "active"
          : finding.state !== "active",
    );
    const findingsFor = (family) =>
      structuredClone(
        visibleFindings.filter(
          (finding) => finding.family === family,
        ),
      );
    const currentWeekly = findingsFor("weekly");
    const currentInvestments = findingsFor("investments");
    const currentSubscriptions = findingsFor("subscriptions");
    const all = {
      weekly: {
        period: {
          current_start: "2026-07-19",
          current_end: "2026-07-26",
          previous_start: "2026-07-12",
          previous_end: "2026-07-19",
        },
        summary: { finding_count: currentWeekly.length },
        findings: currentWeekly,
      },
      investments: {
        summary: {
          portfolio_value: money(12_367_549),
          one_week_change: money(88_420),
          one_month_change: money(339_100),
        },
        findings: currentInvestments,
      },
      subscriptions: {
        summary: {
          monthly_equivalent: money(23_864),
          annual_equivalent: money(286_368),
        },
        findings: currentSubscriptions,
      },
    };
    const selected =
      section === "all"
        ? all
        : { [section]: all[section] };
    const count = Object.values(selected).reduce(
      (total, value) => total + value.findings.length,
      0,
    );
    return {
      ...result({
        title:
          section === "all" ? "Finance insights" : `${section} insights`,
        subtitle: `${count} findings`,
        path: section === "all" ? "/insights" : `/insights#${section}`,
        summary: `${count} ${insightView === "archive" ? "past" : "active"} finance finding${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} available. Data is fresh as of July 26 at 6:42 PM UTC.`,
        data: {
          section,
          view: insightView,
          ...selected,
          finding_count: count,
          freshness: FRESHNESS,
        },
        partial: this.#insightStatus.data_stale,
        warnings: this.#insightStatus.data_warnings,
      }),
      insights_enabled: this.#insightStatus.enabled,
    };
  }

  async listAccounts(options = {}) {
    const accountType =
      options.accountType ?? options.account_type ?? "all";
    const institutionId =
      options.institutionId ?? options.institution_id ?? null;
    const balanceGroup =
      options.balanceGroup ?? options.balance_group ?? null;
    const limit = Math.max(
      1,
      Math.min(100, Number(options.limit) || 50),
    );
    const allAccounts = this.#accountCards();
    const filtered = allAccounts.filter(
      (account) =>
        (accountType === "all" || account.type === accountType) &&
        (!institutionId ||
          account.institution_id === institutionId) &&
        (!balanceGroup || account.balance_group === balanceGroup),
    );
    const page = filtered.slice(0, limit);
    const groups = new Map();
    for (const account of page) {
      const key = account.institution_name;
      const group = groups.get(key) ?? {
        institution_id: account.institution_id,
        institution_name: key,
        accounts: [],
      };
      group.accounts.push(account);
      groups.set(key, group);
    }
    const manualAssets = this.#manualAssetCards();
    const balanceSummary = this.#balanceSummary();
    const creditSummary = buildCreditSummary({
      accounts: allAccounts.map(analyticsAccount),
      currency: "USD",
    }).summary;
    return result({
      title: "Accounts",
      subtitle: `${filtered.length} connected`,
      path: "/accounts",
      summary: `${filtered.length} connected account${filtered.length === 1 ? "" : "s"} matched and ${manualAssets.length} manual asset${manualAssets.length === 1 ? "" : "s"} exist. Cash balance is ${(balanceSummary.cash_balance.amount_minor / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} and net worth is ${(balanceSummary.net_worth.amount_minor / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}. Data is fresh as of July 26 at 6:42 PM UTC.`,
      data: {
        groups: [...groups.values()],
        account_count: filtered.length,
        manual_assets: manualAssets,
        manual_asset_count: manualAssets.length,
        balance_summary: balanceSummary,
        credit_summary: creditSummary,
        page_info: {
          has_more: filtered.length > page.length,
          next_cursor: null,
        },
        freshness: FRESHNESS,
      },
    });
  }

  async listSpendingCategories(input = {}) {
    this.#refreshSpendingCategoryPaths();
    const includeMerged =
      input.includeMerged === true || input.include_merged === true;
    return {
      categories: [...this.#spendingCategories.values()]
        .filter(
          (category) =>
            includeMerged || category.status === "active",
        )
        .map((category) => this.#publicSpendingCategory(category))
        .sort((left, right) => {
          const leftOther = left.is_system || left.path === "Other";
          const rightOther =
            right.is_system || right.path === "Other";
          if (leftOther !== rightOther) return leftOther ? 1 : -1;
          return left.path.localeCompare(right.path);
        }),
    };
  }

  async createSpendingCategory(input = {}) {
    const category = this.#createSpendingCategoryRecord({
      name: input.name,
      classification: input.classification ?? "flexible",
      parentCategoryId:
        input.parentCategoryId ??
        input.parent_category_id ??
        null,
    });
    return {
      created: true,
      category: this.#publicSpendingCategory(category),
    };
  }

  async updateSpendingCategory(input = {}) {
    const categoryId =
      input.categoryId ?? input.category_id ?? null;
    const category = this.#spendingCategories.get(categoryId);
    if (!category || category.status !== "active") {
      throw demoCategoryError("Category not found", 404);
    }
    if (category.is_system) {
      throw demoCategoryError(
        "Other is permanent and cannot be edited.",
      );
    }
    this.#assertSpendingCategoryVersion(
      category,
      input.expectedVersion ?? input.expected_version,
    );
    const hasName = Object.hasOwn(input, "name");
    const hasClassification = Object.hasOwn(
      input,
      "classification",
    );
    const hasParent =
      Object.hasOwn(input, "parentCategoryId") ||
      Object.hasOwn(input, "parent_category_id");
    if (!hasName && !hasClassification && !hasParent) {
      throw demoCategoryError(
        "At least one category field is required",
      );
    }
    const oldPaths = new Map(
      [...this.#spendingCategories.values()].map((candidate) => [
        candidate.id,
        candidate.path,
      ]),
    );
    const before = {
      name: category.name,
      classification: category.classification,
      parent_category_id: category.parent_category_id,
    };
    const restore = () => {
      Object.assign(category, before);
      for (const candidate of this.#spendingCategories.values()) {
        if (!oldPaths.has(candidate.id)) continue;
        candidate.path = oldPaths.get(candidate.id);
        candidate.depth = candidate.path.split(" / ").length - 1;
      }
    };
    try {
      if (hasName) {
        const name = String(input.name ?? "").trim();
        if (!name || name.length > 100) {
          throw demoCategoryError(
            "name must be between 1 and 100 characters",
          );
        }
        category.name = name;
      }
      if (hasClassification) {
        if (!["fixed", "flexible"].includes(input.classification)) {
          throw demoCategoryError(
            "classification must be fixed or flexible",
          );
        }
        category.classification = input.classification;
      }
      if (hasParent) {
        const parentCategoryId =
          input.parentCategoryId ??
          input.parent_category_id ??
          null;
        if (parentCategoryId === category.id) {
          throw demoCategoryError(
            "A category cannot be nested under itself or a descendant.",
          );
        }
        category.parent_category_id = parentCategoryId || null;
      }
      this.#refreshSpendingCategoryPaths();
      const conflict = this.#spendingCategoryByPath(
        category.path,
        category.id,
      );
      if (conflict) {
        throw demoCategoryError(
          "That category name or alias already exists. Merge it instead.",
          409,
        );
      }
    } catch (error) {
      restore();
      throw error;
    }
    for (const candidate of this.#spendingCategories.values()) {
      const oldPath = oldPaths.get(candidate.id);
      if (
        candidate.status === "active" &&
        oldPath &&
        oldPath !== candidate.path
      ) {
        candidate.aliases = [
          ...(candidate.aliases ?? []),
          { label: oldPath },
        ];
        this.#reassignCategoryTransactions(oldPath, candidate.path);
      }
    }
    category.version += 1;
    return {
      updated: true,
      category: this.#publicSpendingCategory(category),
    };
  }

  async mergeSpendingCategories(input = {}) {
    const rawSourceIds =
      input.sourceCategoryIds ?? input.source_category_ids;
    if (
      !Array.isArray(rawSourceIds) ||
      rawSourceIds.length < 1 ||
      rawSourceIds.length > 100
    ) {
      throw demoCategoryError(
        "source_category_ids must contain between 1 and 100 categories",
      );
    }
    const sourceIds = [...new Set(rawSourceIds.map(String))];
    if (sourceIds.length !== rawSourceIds.length) {
      throw demoCategoryError(
        "source_category_ids must be unique",
      );
    }
    const sources = sourceIds.map((id) =>
      this.#spendingCategories.get(id),
    );
    if (
      sources.some(
        (category) => !category || category.status !== "active",
      )
    ) {
      throw demoCategoryError(
        "One or more categories were not found",
        404,
      );
    }
    if (sources.some((category) => category.is_system)) {
      throw demoCategoryError(
        "Other cannot be edited, merged, or used as a merge destination.",
      );
    }
    const destinationInput = input.destination;
    if (
      !destinationInput ||
      typeof destinationInput !== "object" ||
      Array.isArray(destinationInput)
    ) {
      throw demoCategoryError("destination is required");
    }
    const destinationId =
      destinationInput.categoryId ??
      destinationInput.category_id ??
      null;
    if (destinationId && sourceIds.includes(destinationId)) {
      throw demoCategoryError(
        "A category cannot be merged into itself",
      );
    }
    const existingDestination = destinationId
      ? this.#spendingCategories.get(destinationId)
      : null;
    if (
      destinationId &&
      (!existingDestination ||
        existingDestination.status !== "active")
    ) {
      throw demoCategoryError("Destination category not found", 404);
    }
    if (existingDestination?.is_system) {
      throw demoCategoryError(
        "Other cannot be edited, merged, or used as a merge destination.",
      );
    }
    const expectedVersions =
      input.expectedVersions ?? input.expected_versions;
    if (
      !expectedVersions ||
      typeof expectedVersions !== "object" ||
      Array.isArray(expectedVersions)
    ) {
      throw demoCategoryError("expected_versions is required");
    }
    for (const category of [
      ...sources,
      ...(existingDestination ? [existingDestination] : []),
    ]) {
      this.#assertSpendingCategoryVersion(
        category,
        expectedVersions[category.id],
      );
    }
    const newDestinationParentId =
      destinationInput.parentCategoryId ??
      destinationInput.parent_category_id ??
      null;
    if (
      !existingDestination &&
      newDestinationParentId &&
      sourceIds.includes(newDestinationParentId)
    ) {
      throw demoCategoryError(
        "The destination parent category is invalid",
      );
    }
    const destination =
      existingDestination ??
      this.#createSpendingCategoryRecord({
        name: destinationInput.name,
        classification:
          destinationInput.classification ?? "flexible",
        parentCategoryId:
          newDestinationParentId,
      });
    const oldPaths = new Map(
      [...this.#spendingCategories.values()].map((category) => [
        category.id,
        category.path,
      ]),
    );
    for (const candidate of this.#spendingCategories.values()) {
      if (candidate.status !== "active") {
        continue;
      }
      let parentId = candidate.parent_category_id;
      while (parentId && sourceIds.includes(parentId)) {
        parentId =
          this.#spendingCategories.get(parentId)
            ?.parent_category_id ?? null;
      }
      candidate.parent_category_id = parentId;
    }
    this.#refreshSpendingCategoryPaths();
    for (const candidate of this.#spendingCategories.values()) {
      const oldPath = oldPaths.get(candidate.id);
      if (
        candidate.status === "active" &&
        oldPath &&
        oldPath !== candidate.path
      ) {
        candidate.aliases = [
          ...(candidate.aliases ?? []),
          { label: oldPath },
        ];
        if (!sourceIds.includes(candidate.id)) {
          candidate.version += 1;
        }
        this.#reassignCategoryTransactions(oldPath, candidate.path);
      }
    }
    const destinationAliases = new Map(
      (destination.aliases ?? []).map((alias) => [
        normalizedMatchText(alias.label),
        alias,
      ]),
    );
    for (const source of sources) {
      const sourcePath = source.path;
      const transactionIds = this.#reassignCategoryTransactions(
        sourcePath,
        destination.path,
      );
      source.status = "merged";
      source.merged_into_category_id = destination.id;
      source.merged_into_path = destination.path;
      source.merged_transaction_ids = transactionIds;
      source.version += 1;
      for (const alias of [
        { label: sourcePath },
        ...(source.aliases ?? []),
      ]) {
        destinationAliases.set(
          normalizedMatchText(alias.label),
          { ...alias },
        );
      }
    }
    destination.aliases = [...destinationAliases.values()];
    if (
      existingDestination &&
      oldPaths.get(destination.id) === destination.path
    ) {
      destination.version += 1;
    }
    return {
      merged: true,
      category: this.#publicSpendingCategory(destination),
    };
  }

  async deleteSpendingCategory(input = {}) {
    const categoryId =
      input.categoryId ?? input.category_id ?? null;
    const category = this.#spendingCategories.get(categoryId);
    if (!category || category.status !== "active") {
      throw demoCategoryError("Category not found", 404);
    }
    if (category.is_system) {
      throw demoCategoryError(
        "Other is permanent and cannot be deleted.",
      );
    }
    this.#assertSpendingCategoryVersion(
      category,
      input.expectedVersion ?? input.expected_version,
    );
    const fallback = [...this.#spendingCategories.values()].find(
      (candidate) => candidate.is_system,
    );
    const oldPaths = new Map(
      [...this.#spendingCategories.values()].map((candidate) => [
        candidate.id,
        candidate.path,
      ]),
    );
    this.#reassignCategoryTransactions(category.path, fallback.path);
    for (const child of this.#spendingCategories.values()) {
      if (child.parent_category_id === category.id) {
        child.parent_category_id = category.parent_category_id;
      }
    }
    this.#spendingCategories.delete(category.id);
    this.#refreshSpendingCategoryPaths();
    for (const candidate of this.#spendingCategories.values()) {
      const oldPath = oldPaths.get(candidate.id);
      if (
        candidate.status === "active" &&
        oldPath &&
        oldPath !== candidate.path
      ) {
        candidate.aliases = [
          ...(candidate.aliases ?? []),
          { label: oldPath },
        ];
        candidate.version += 1;
        this.#reassignCategoryTransactions(oldPath, candidate.path);
      }
    }
    return {
      deleted: true,
      category_id: category.id,
      moved_to_category: this.#publicSpendingCategory(fallback),
    };
  }

  async splitSpendingCategory(input = {}) {
    const categoryId =
      input.categoryId ?? input.category_id ?? null;
    const category = this.#spendingCategories.get(categoryId);
    if (!category) {
      throw demoCategoryError("Category not found", 404);
    }
    if (category.status !== "merged") {
      throw demoCategoryError(
        "Only a merged category can be split out",
      );
    }
    this.#assertSpendingCategoryVersion(
      category,
      input.expectedVersion ?? input.expected_version,
    );
    const destination = this.#spendingCategories.get(
      category.merged_into_category_id,
    );
    if (!destination || destination.status !== "active") {
      throw demoCategoryError("Destination category not found", 404);
    }
    const restoreIds = new Set(category.merged_transaction_ids);
    for (const transaction of this.#transactions) {
      if (
        restoreIds.has(transaction.id) &&
        (transaction.category_primary ?? transaction.category) ===
          destination.path
      ) {
        transaction.category_primary = category.path;
        transaction.category = category.path;
      }
    }
    const sourceLabels = new Set(
      [category.path, ...(category.aliases ?? []).map((alias) => alias.label)]
        .map(normalizedMatchText),
    );
    destination.aliases = (destination.aliases ?? []).filter(
      (alias) => !sourceLabels.has(normalizedMatchText(alias.label)),
    );
    destination.version += 1;
    category.status = "active";
    category.merged_into_category_id = null;
    category.merged_into_path = null;
    category.merged_transaction_ids = [];
    category.version += 1;
    return {
      split: true,
      category: this.#publicSpendingCategory(category),
    };
  }

  async getCreditSummary({ period = "1m" } = {}) {
    const selectedPeriod = demoCreditPeriod(period);
    const accountCards = this.#accountCards();
    const data = buildCreditSummary({
      accounts: accountCards.map(analyticsAccount),
      snapshots: creditSnapshots.filter(
        (snapshot) =>
          snapshot.snapshot_on >= selectedPeriod.start_on &&
          snapshot.snapshot_on < selectedPeriod.end_on,
      ),
      currency: "USD",
      currentOn: "2026-07-26",
    });
    data.period = selectedPeriod;
    return result({
      title: "Credit",
      subtitle: selectedPeriod.label,
      path: `/credit?period=${selectedPeriod.name}`,
      summary:
        `${
          (data.summary.total_balance_owed.amount_minor / 100)
            .toLocaleString("en-US", {
              style: "currency",
              currency: "USD",
            })
        } is owed across ${data.summary.card_count} credit card against ${
          (data.summary.total_credit_limit.amount_minor / 100)
            .toLocaleString("en-US", {
              style: "currency",
              currency: "USD",
            })
        } in known limits. Utilization is ${
          (data.summary.utilization_basis_points / 100).toFixed(1)
        }%. Data is fresh as of July 26 at 6:42 PM UTC.`,
      data,
    });
  }

  async getCreditScoreSummary({
    period = "1y",
    currentUserId = null,
    current_user_id = null,
    audience = null,
  } = {}) {
    const data = buildCreditScoreSummary({
      members: [
        { id: "demo-user", display_name: "Demo User" },
        { id: "demo-partner", display_name: "Household member" },
      ],
      sources: this.#creditScoreSources,
      observations: this.#creditScoreObservations,
      currentOn: "2026-07-26",
      period,
      currentUserId: currentUserId ?? current_user_id,
      forMcp: audience === "mcp",
    });
    return result({
      title: "Tracked credit scores",
      subtitle: data.period.label,
      path: `/credit?period=${data.period.name}`,
      summary:
        data.household.average_score == null
          ? "No manually tracked credit scores have been entered. Data as of July 26, 2026."
          : `The manually tracked household average is ${data.household.average_score}. It is not a lender or underwriting score. Data as of July 26, 2026.`,
      data,
      warnings: data.warnings.map((warning) => warning.message),
    });
  }

  async createCreditScoreSource(input, actor = null) {
    if (!actor?.id) throw new TypeError("signed-in user is required");
    const source = {
      id: `score_source_demo_${this.#creditScoreSourceSequence++}`,
      user_id: actor.id,
      label: String(input.label ?? "").trim(),
      bureau: input.bureau ? String(input.bureau).trim() : null,
      model: input.model ? String(input.model).trim() : null,
      archived_on: null,
    };
    if (!source.label) throw new TypeError("label is required");
    this.#creditScoreSources.push(source);
    return { created: true, source: structuredClone(source) };
  }

  async updateCreditScoreSource(input, actor = null) {
    const source = this.#creditScoreSources.find(
      (candidate) =>
        candidate.id === (input.source_id ?? input.sourceId) &&
        candidate.user_id === actor?.id &&
        !candidate.archived_on,
    );
    if (!source) {
      const error = new Error("Credit score source not found");
      error.statusCode = 404;
      throw error;
    }
    if (Object.hasOwn(input, "label")) source.label = input.label;
    if (Object.hasOwn(input, "bureau")) {
      source.bureau = input.bureau || null;
    }
    if (Object.hasOwn(input, "model")) source.model = input.model || null;
    return { updated: true, source: structuredClone(source) };
  }

  async archiveCreditScoreSource(input, actor = null) {
    const source = this.#creditScoreSources.find(
      (candidate) =>
        candidate.id === (input.source_id ?? input.sourceId) &&
        candidate.user_id === actor?.id &&
        !candidate.archived_on,
    );
    if (!source) {
      const error = new Error("Credit score source not found");
      error.statusCode = 404;
      throw error;
    }
    source.archived_on = "2026-07-26";
    return {
      archived: true,
      source_id: source.id,
      source: structuredClone(source),
    };
  }

  async upsertCreditScoreObservation(input, actor = null) {
    const source = this.#creditScoreSources.find(
      (candidate) =>
        candidate.id === (input.source_id ?? input.sourceId) &&
        candidate.user_id === actor?.id,
    );
    if (!source) {
      const error = new Error("Credit score source not found");
      error.statusCode = 404;
      throw error;
    }
    const observedOn = input.observed_on ?? input.observedOn;
    const score = Number(input.score);
    let observation = this.#creditScoreObservations.find(
      (candidate) =>
        candidate.source_id === source.id &&
        candidate.observed_on === observedOn,
    );
    if (observation) {
      observation.score = score;
    } else {
      observation = {
        id: `score_observation_demo_${this.#creditScoreObservationSequence++}`,
        source_id: source.id,
        observed_on: observedOn,
        score,
      };
      this.#creditScoreObservations.push(observation);
    }
    return {
      updated: true,
      observation: structuredClone(observation),
    };
  }

  async listTransactions({
    status = "all",
    search = null,
    query = null,
    startOn = null,
    start_on = null,
    endOn = null,
    end_on = null,
    accountId = null,
    account_id = null,
    category = null,
    sort = "date",
    limit = 50,
    cursor = null,
  } = {}) {
    const normalizedSearch = normalizedMatchText(search ?? query);
    const effectiveStart = startOn ?? start_on;
    const effectiveEnd = endOn ?? end_on;
    const effectiveAccount = accountId ?? account_id;
    const boundedLimit = Math.max(
      1,
      Math.min(100, Number(limit) || 50),
    );
    const offset = decodeDemoTransactionCursor(cursor);
    const filtered = this.#transactions
      .filter((transaction) => {
        if (status === "pending") return transaction.pending;
        if (status === "posted") return !transaction.pending;
        return true;
      })
      .filter((transaction) => {
        const date = transaction.posted_on ?? transaction.date;
        return (
          (!effectiveStart || date >= effectiveStart) &&
          (!effectiveEnd || date < effectiveEnd) &&
          (!effectiveAccount ||
            transaction.account.id === effectiveAccount) &&
          (!category ||
            transaction.category_primary === category ||
            transaction.category === category)
        );
      })
      .filter(
        (transaction) =>
          !normalizedSearch ||
          normalizedMatchText(
            [
              transaction.display_name,
              transaction.raw_merchant,
              transaction.raw_name,
              transaction.category_primary,
              transaction.tags.join(" "),
              transaction.account.name,
              transaction.note,
            ].join(" "),
          ).includes(normalizedSearch),
      )
      .sort((left, right) =>
        compareDemoServiceTransactions(left, right, sort),
      );
    const page = filtered
      .slice(offset, offset + boundedLimit)
      .map(publicDemoTransaction);
    return result({
      title: "Transactions",
      subtitle: `${page.length} shown`,
      path: "/transactions",
      summary: `${page.length} recent transactions returned, including ${page.filter((transaction) => transaction.pending).length} pending. Data is fresh as of July 26 at 6:42 PM UTC.`,
      data: {
        transactions: page,
        page_info: {
          has_more: offset + page.length < filtered.length,
          next_cursor:
            offset + page.length < filtered.length
              ? encodeDemoTransactionCursor(offset + page.length)
              : null,
        },
        freshness: FRESHNESS,
      },
    });
  }

  async getSpendingSummary() {
    return result({
      title: "Spending",
      subtitle: "July vs June",
      path: "/transactions?period=month",
      summary:
        "July spending is $4,126.84, down $508.52 or 11.0% from June. Housing is the largest category. Data is fresh as of July 26 at 6:42 PM UTC.",
      data: {
        period: { start_date: "2026-07-01", end_date: "2026-08-01" },
        previous_period: {
          start_date: "2026-06-01",
          end_date: "2026-07-01",
        },
        total: money(412_684),
        previous_total: money(463_536),
        trend: {
          amount: money(-50_852),
          percent_basis_points: -1_097,
          direction: "down",
        },
        breakdown: [
          {
            label: "Housing",
            amount: money(145_000),
            share_basis_points: 3_513,
          },
          {
            label: "Groceries",
            amount: money(68_430),
            share_basis_points: 1_658,
          },
          {
            label: "Dining",
            amount: money(52_146),
            share_basis_points: 1_263,
          },
        ],
        series: [
          { timestamp: "2026-07-01T00:00:00.000Z", value: money(54_420) },
          { timestamp: "2026-07-08T00:00:00.000Z", value: money(118_300) },
          { timestamp: "2026-07-15T00:00:00.000Z", value: money(103_524) },
          { timestamp: "2026-07-22T00:00:00.000Z", value: money(136_440) },
        ],
        freshness: FRESHNESS,
      },
    });
  }

  async getCashFlow() {
    return result({
      title: "Cash flow",
      subtitle: "July 2026",
      path: "/transactions?view=cash-flow",
      summary:
        "July income is $9,300.00, spending is $4,126.84, and net cash flow is positive $5,173.16. Data is fresh as of July 26 at 6:42 PM UTC.",
      data: {
        period: { start_date: "2026-07-01", end_date: "2026-08-01" },
        interval: "week",
        income: money(930_000),
        spending: money(412_684),
        net: money(517_316),
        buckets: [
          {
            timestamp: "2026-07-01T00:00:00.000Z",
            income: money(465_000),
            spending: money(132_400),
            net: money(332_600),
          },
          {
            timestamp: "2026-07-15T00:00:00.000Z",
            income: money(465_000),
            spending: money(280_284),
            net: money(184_716),
          },
        ],
        freshness: FRESHNESS,
      },
    });
  }

  async listRecurringPayments({ kind = "all", limit = 50 } = {}) {
    const streams = this.#recurring
      .filter((stream) => {
        if (kind === "subscriptions") return stream.type === "subscription";
        if (kind === "bills") return stream.type === "bill";
        return true;
      })
      .slice(0, limit);
    const monthly = streams.reduce(
      (sum, stream) => sum + stream.monthly_equivalent.amount_minor,
      0,
    );
    return result({
      title: "Recurring payments",
      subtitle: `${streams.length} shown`,
      path: "/recurring",
      summary: `${streams.length} recurring payments total about ${(monthly / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} per month. Data is fresh as of July 26 at 6:42 PM UTC.`,
      data: {
        kind,
        monthly_equivalent: money(monthly),
        annual_equivalent: money(monthly * 12),
        recurring_payments: structuredClone(streams),
        page_info: { has_more: false, next_cursor: null },
        freshness: FRESHNESS,
      },
    });
  }

  async getNetWorthHistory() {
    return result({
      title: "Net worth",
      subtitle: "Seven months",
      path: "/?view=net-worth",
      summary:
        "Net worth is $184,270.00, up $13,050.00 since the first local snapshot in January. Data is fresh as of July 26 at 6:42 PM UTC.",
      data: {
        current_assets: money(20_326_790),
        current_liabilities: money(1_899_790),
        current_net_worth: money(18_427_000),
        series: [
          {
            timestamp: "2026-01-01T00:00:00.000Z",
            assets: money(19_012_000),
            liabilities: money(1_890_000),
            net_worth: money(17_122_000),
          },
          {
            timestamp: "2026-04-01T00:00:00.000Z",
            assets: money(19_502_000),
            liabilities: money(1_909_000),
            net_worth: money(17_593_000),
          },
          {
            timestamp: "2026-07-26T00:00:00.000Z",
            assets: money(20_326_790),
            liabilities: money(1_899_790),
            net_worth: money(18_427_000),
          },
        ],
        freshness: FRESHNESS,
      },
    });
  }

  async getPortfolioSummary(options = {}) {
    const requestedScope =
      options.retirementScope ??
      options.retirement_scope ??
      options.scope ??
      "include";
    const retirementScope = {
      include: "include",
      all: "include",
      exclude: "exclude",
      taxable: "exclude",
      trading: "exclude",
      only: "only",
      retirement: "only",
    }[requestedScope];
    if (!retirementScope) {
      throw new TypeError(
        "retirement_scope must be include, exclude, or only",
      );
    }
    const pageScope = {
      include: "all",
      exclude: "trading",
      only: "retirement",
    }[retirementScope];
    const accountId = options.accountId ?? options.account_id ?? null;
    const holdingsLimit = Math.max(
      1,
      Math.min(
        100,
        Number(options.holdingsLimit ?? options.holdings_limit) || 50,
      ),
    );
    const accountCards = this.#accountCards();
    const accountGroups = new Map(
      accountCards.map((account) => [
        account.id,
        account.balance_group,
      ]),
    );
    const accountNames = new Map(
      accountCards.map((account) => [account.id, account.name]),
    );
    const enriched = portfolioHoldings.map((holding) => ({
      ...holding,
      balance_group:
        accountGroups.get(holding.account_id) ??
        "taxable_investment",
    }));
    const investmentHoldings = enriched.filter((holding) =>
      ["taxable_investment", "retirement"].includes(
        holding.balance_group,
      ),
    );
    const scoped = investmentHoldings.filter((holding) => {
      if (accountId && holding.account_id !== accountId) return false;
      if (retirementScope === "exclude") {
        return holding.balance_group === "taxable_investment";
      }
      if (retirementScope === "only") {
        return holding.balance_group === "retirement";
      }
      return true;
    });
    const total = scoped.reduce(
      (sum, holding) => sum + holding.value_minor,
      0,
    );
    const startTotal = scoped.reduce(
      (sum, holding) => sum + holding.start_value_minor,
      0,
    );
    const oneWeekChange = scoped.reduce(
      (sum, holding) => sum + holding.week_change_minor,
      0,
    );
    const includedAccountIds = new Set(
      scoped.map((holding) => holding.account_id),
    );
    const contributions = [...includedAccountIds].reduce(
      (sum, id) => sum + (contributionsByAccount.get(id) ?? 0),
      0,
    );
    const estimatedGain = total - startTotal - contributions;
    const estimatedReturn =
      startTotal === 0
        ? null
        : Math.round((estimatedGain / startTotal) * 10_000);
    const taxableValue = investmentHoldings
      .filter(
        (holding) =>
          holding.balance_group === "taxable_investment",
      )
      .reduce((sum, holding) => sum + holding.value_minor, 0);
    const retirementValue = investmentHoldings
      .filter((holding) => holding.balance_group === "retirement")
      .reduce((sum, holding) => sum + holding.value_minor, 0);
    const holdingCards = scoped.slice(0, holdingsLimit).map((holding) => ({
      id: holding.id,
      security_id: holding.security_id,
      account_id: holding.account_id,
      account_name: accountNames.get(holding.account_id) ?? null,
      name: holding.name,
      display_name: holding.display_name ?? holding.name,
      ticker_symbol: holding.ticker_symbol,
      symbol: holding.ticker_symbol,
      display_symbol:
        holding.display_symbol ?? holding.ticker_symbol,
      security_type: holding.security_type,
      balance_group: holding.balance_group,
      value: money(holding.value_minor),
      cost_basis: money(
        holding.cost_basis_minor ??
          Math.round(holding.start_value_minor * 0.82),
      ),
      quantity: holding.quantity,
      price:
        Number.isSafeInteger(holding.price_minor)
          ? money(holding.price_minor)
          : holding.quantity > 0 && holding.price_minor !== null
          ? money(Math.round(holding.value_minor / holding.quantity))
          : null,
      allocation_basis_points:
        total === 0
          ? 0
          : Math.round((holding.value_minor / total) * 10_000),
      price_as_of: holding.price_as_of ?? "2026-07-26",
      change_percent: holding.change_percent ?? 0,
      shares_label:
        holding.shares_label ??
        (Number.isFinite(holding.quantity)
          ? String(holding.quantity)
          : "—"),
    }));
    const allocationGroups = new Map();
    for (const holding of scoped) {
      allocationGroups.set(
        holding.security_type,
        (allocationGroups.get(holding.security_type) ?? 0) +
          holding.value_minor,
      );
    }
    const allocation = [...allocationGroups]
      .map(([label, value]) => ({
        label,
        value: money(value),
        share_basis_points:
          total === 0 ? 0 : Math.round((value / total) * 10_000),
      }))
      .sort(
        (left, right) =>
          right.value.amount_minor - left.value.amount_minor,
      );
    return result({
      title: "Portfolio",
      subtitle: `${scoped.length} ${
        retirementScope === "include" ? "" : `${pageScope} `
      }holdings`,
      path: `/portfolio?scope=${pageScope}`,
      summary: `${pageScope === "all" ? "All investments" : pageScope === "trading" ? "Trading" : "Retirement"} portfolio value is ${(total / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} across ${scoped.length} holdings. Estimated performance is ${(estimatedGain / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} after separating ${(contributions / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} of contributions. Data is fresh as of July 26 at 6:42 PM UTC.`,
      data: {
        currency: "USD",
        retirement_scope: retirementScope,
        scope: pageScope,
        total_value: money(total),
        future_equity: null,
        taxable_value: money(taxableValue),
        retirement_value: money(retirementValue),
        changes: {
          one_week: money(oneWeekChange),
          one_month: money(total - startTotal),
          since_first_snapshot: money(total - startTotal),
        },
        external_cash_flow: money(contributions),
        contributions: money(contributions),
        withdrawals: money(0),
        estimated_gain: money(estimatedGain),
        estimated_performance: money(estimatedGain),
        estimated_return_basis_points: estimatedReturn,
        estimated_performance_basis_points: estimatedReturn,
        holdings: holdingCards,
        allocation,
        series: [
          { timestamp: "2026-07-01", value: money(startTotal) },
          { timestamp: "2026-07-26", value: money(total) },
        ],
        period: {
          name: options.period ?? "1m",
          start_on: "2026-07-01",
          end_on: "2026-07-27",
        },
        filters: {
          account_id: accountId,
          retirement_scope: retirementScope,
        },
        warnings: [],
        freshness: FRESHNESS,
      },
    });
  }

  async search(query, options = {}) {
    const normalizedQuery = String(query ?? "").trim().slice(0, 120);
    const entityTypes =
      options.entityTypes ?? options.entity_types ?? null;
    const limit = boundedDemoSearchLimit(options.limit, 30);
    if (normalizedQuery.length < 2) {
      return {
        query: normalizedQuery,
        entity_types: entityTypes ?? [],
        groups: [],
        returned_count: 0,
        group_count: 0,
      };
    }
    const insightItems = [...this.#insightFindings.values()]
      .filter((finding) => finding.state === "active")
      .map((finding) => ({
        finding,
        family: finding.family,
      }));
    const items = [
      ...this.#transactions.map((transaction) => ({
        entityType: "transaction",
        group: "Transactions",
        title: transaction.display_name,
        meta: [
          transaction.category_primary,
          transaction.tags.join(" "),
          transaction.account.name,
        ]
          .filter(Boolean)
          .join(" · "),
        searchText: `${transaction.display_name} ${transaction.raw_merchant} ${transaction.raw_name} ${transaction.category_primary} ${transaction.tags.join(" ")} ${transaction.account.name} ${transaction.note ?? ""}`,
        url: `/transactions?transaction=${encodeURIComponent(transaction.id)}`,
        icon: "ph-receipt",
      })),
      ...this.#accountCards().map((account) => ({
        entityType: "account",
        group: "Accounts",
        title: account.name,
        meta: `${account.type} · ${account.mask}`,
        searchText: `${account.name} ${account.institution} ${account.type} ${account.mask}`,
        url: `/accounts#account-${encodeURIComponent(account.id)}`,
        icon: "ph-bank",
      })),
      ...this.#recurring.map((stream) => ({
        entityType: "recurring",
        group: "Recurring",
        title: stream.service,
        meta: `${stream.cadence} · ${stream.type}`,
        searchText: `${stream.service} ${stream.service_family} ${stream.cadence} ${stream.type}`,
        url: `/recurring?item=${encodeURIComponent(stream.id)}`,
        icon: "ph-repeat",
      })),
      ...[...this.#manualAssets.values()]
        .filter((asset) => asset.active)
        .map((asset) => ({
          entityType: "manual_asset",
          group: "Assets",
          title: asset.name,
          meta: `Manual ${asset.asset_type}`,
          searchText: `${asset.name} ${asset.asset_type} ${asset.description}`,
          url: `/accounts#asset-${encodeURIComponent(asset.id)}`,
          icon: asset.asset_type === "vehicle" ? "ph-car" : "ph-cube",
        })),
      ...insightItems.map(({ finding, family }) => ({
        entityType: "insight",
        group: "Insights",
        title: finding.title,
        meta: `${family} · ${finding.type}`,
        searchText: `${finding.title} ${finding.explanation} ${family} ${finding.type}`,
        url: `/insights?finding=${encodeURIComponent(finding.id)}`,
        icon: "ph-sparkle",
      })),
    ]
      .filter(
        (item) =>
          !entityTypes?.length ||
          entityTypes.includes(item.entityType),
      )
      .map((item) => ({
        item,
        rank: rankDemoSearchItem(item, normalizedQuery),
      }))
      .filter(({ rank }) => rank != null)
      .sort(
        (left, right) =>
          right.rank.tier - left.rank.tier ||
          right.rank.similarity - left.rank.similarity ||
          left.item.title.localeCompare(right.item.title),
      )
      .slice(0, limit)
      .map(({ item }) => {
        const result = { ...item };
        delete result.searchText;
        return result;
      });
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push(item);
    }
    const groupedResults = [...groups].map(
      ([label, groupItems]) => ({
        label,
        items: groupItems,
        returned_count: groupItems.length,
      }),
    );
    return {
      query: normalizedQuery,
      entity_types: entityTypes ?? [],
      groups: groupedResults,
      returned_count: items.length,
      group_count: groupedResults.length,
    };
  }

  async updateTransactionClassification(input) {
    const transactionId = input.transactionId ?? input.transaction_id;
    const transaction = this.#transactions.find(
      (candidate) => candidate.id === transactionId,
    );
    if (
      transaction &&
      (input.categoryPrimary !== undefined ||
        input.category_primary !== undefined)
    ) {
      let manual = this.#manualTransactionFields.get(transaction.id);
      if (!manual) {
        manual = new Set();
        this.#manualTransactionFields.set(transaction.id, manual);
      }
      manual.add("category_primary");
      const category =
        input.categoryPrimary ?? input.category_primary ??
        transaction.raw_category_primary;
      transaction.category_primary = category;
      transaction.category = category;
    }
    return { updated: true, classification: input };
  }

  async findTransactionMatches(input = {}) {
    const transactionId =
      input.transactionId ?? input.transaction_id ?? null;
    const requestedQuery = String(input.q ?? "").trim();
    const limit = Math.max(1, Math.min(50, Number(input.limit) || 50));
    const anchor = transactionId
      ? this.#transactions.find(
          (transaction) => transaction.id === transactionId,
        )
      : null;
    if (transactionId && (!anchor || anchor.pending)) {
      const error = new Error("Posted transaction not found");
      error.statusCode = 404;
      throw error;
    }
    const query =
      requestedQuery ||
      anchor?.raw_merchant ||
      anchor?.raw_name ||
      anchor?.display_name ||
      "";
    if (!query) {
      const error = new TypeError(
        "transaction_id or a nonblank q value is required",
      );
      error.statusCode = 400;
      throw error;
    }

    const ranked = this.#transactions
      .filter(
        (transaction) =>
          !transaction.pending &&
          transaction.id !== anchor?.id &&
          (
            !anchor ||
            Math.sign(transaction.amount.amount_minor) ===
              Math.sign(anchor.amount.amount_minor)
          ),
      )
      .map((transaction) => {
        const exactMerchant =
          Boolean(anchor) &&
          normalizedMatchText(transaction.raw_merchant) ===
            normalizedMatchText(anchor.raw_merchant);
        return {
          transaction,
          exactMerchant,
          score: matchScore(query, transaction),
        };
      })
      .filter(
        ({ exactMerchant, score }) => exactMerchant || score >= 2_000,
      )
      .sort((left, right) => {
        return (
          Number(right.exactMerchant) - Number(left.exactMerchant) ||
          right.score - left.score ||
          right.transaction.date.localeCompare(left.transaction.date) ||
          left.transaction.id.localeCompare(right.transaction.id)
        );
      })
      .slice(0, limit);

    const anchorRow = anchor
      ? transactionMatchRow(anchor, {
          anchor,
          query,
          score: 10_000,
          preselected: true,
        })
      : null;
    return {
      query,
      anchor: anchorRow,
      matches: ranked.map(({ transaction, score, exactMerchant }) =>
        transactionMatchRow(transaction, {
          anchor,
          query,
          score,
          preselected: exactMerchant,
        }),
      ),
      available_tags: [...this.#availableTransactionTags].sort(
        (left, right) => left.localeCompare(right),
      ),
    };
  }

  async listTransactionCleanupRules(input = {}) {
    const includeDisabled =
      input.includeDisabled ?? input.include_disabled ?? true;
    if (typeof includeDisabled !== "boolean") {
      throw transactionCleanupRuleError(
        "include_disabled must be a boolean",
      );
    }
    return {
      rules: [...this.#transactionCleanupRules.values()]
        .filter((rule) => includeDisabled || rule.enabled)
        .sort(
          (left, right) =>
            right.updated_at.localeCompare(left.updated_at) ||
            left.id.localeCompare(right.id),
        )
        .map((rule) => this.#publicTransactionCleanupRule(rule)),
    };
  }

  async createTransactionCleanupRule(input = {}) {
    if (
      input.enabled !== undefined &&
      typeof input.enabled !== "boolean"
    ) {
      throw transactionCleanupRuleError("enabled must be a boolean");
    }
    const matcher = validatedTransactionCleanupMatcher(
      input.matcher ?? input,
    );
    const changes = validatedTransactionCleanupChanges(
      input.changes ?? input,
    );
    this.#assertUniqueTransactionCleanupMatcher(matcher);
    const timestamp = this.#transactionCleanupRuleTimestamp();
    const rule = {
      id: `cleanup_rule_demo_${this.#transactionCleanupRuleSequence++}`,
      matcher,
      changes,
      enabled:
        input.enabled === undefined ? true : Boolean(input.enabled),
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.#transactionCleanupRules.set(rule.id, rule);
    for (const tag of changes.tags ?? []) {
      this.#availableTransactionTags.add(tag);
    }
    this.#refreshTransactionCleanupRuleApplications();
    return {
      created: true,
      rule: this.#publicTransactionCleanupRule(rule),
    };
  }

  async updateTransactionCleanupRule(input = {}) {
    if (
      input.enabled !== undefined &&
      typeof input.enabled !== "boolean"
    ) {
      throw transactionCleanupRuleError("enabled must be a boolean");
    }
    const ruleId =
      input.ruleId ?? input.rule_id ?? input.id ?? null;
    const existing = this.#transactionCleanupRules.get(ruleId);
    if (!existing) {
      const error = new Error("Transaction cleanup rule not found");
      error.statusCode = 404;
      throw error;
    }
    const matcher = Object.hasOwn(input, "matcher")
      ? validatedTransactionCleanupMatcher(input.matcher)
      : existing.matcher;
    const changes = Object.hasOwn(input, "changes")
      ? validatedTransactionCleanupChanges(input.changes)
      : existing.changes;
    this.#assertUniqueTransactionCleanupMatcher(matcher, ruleId);
    const updated = {
      ...existing,
      matcher: { ...matcher },
      changes: {
        ...changes,
        ...(Object.hasOwn(changes, "tags")
          ? { tags: [...changes.tags] }
          : {}),
      },
      enabled:
        input.enabled === undefined
          ? existing.enabled
          : Boolean(input.enabled),
      updated_at: this.#transactionCleanupRuleTimestamp(),
    };
    this.#transactionCleanupRules.set(ruleId, updated);
    for (const tag of updated.changes.tags ?? []) {
      this.#availableTransactionTags.add(tag);
    }
    this.#refreshTransactionCleanupRuleApplications();
    return {
      updated: true,
      rule: this.#publicTransactionCleanupRule(updated),
    };
  }

  async deleteTransactionCleanupRule(input = {}) {
    const ruleId =
      typeof input === "string"
        ? input
        : input.ruleId ?? input.rule_id ?? input.id ?? null;
    const existing = this.#transactionCleanupRules.get(ruleId);
    if (!existing) {
      const error = new Error("Transaction cleanup rule not found");
      error.statusCode = 404;
      throw error;
    }
    this.#transactionCleanupRules.delete(ruleId);
    this.#refreshTransactionCleanupRuleApplications();
    return {
      deleted: true,
      rule_id: existing.id,
    };
  }

  async rerunTransactionCleanupRules() {
    this.#refreshTransactionCleanupRuleApplications();
    return {
      rerun: true,
      transaction_count: this.#transactions.filter(
        (transaction) => !transaction.pending,
      ).length,
      rule_count: [...this.#transactionCleanupRules.values()].filter(
        (rule) => rule.enabled,
      ).length,
    };
  }

  async batchEditTransactions(input = {}) {
    const transactionIds =
      input.transactionIds ?? input.transaction_ids;
    const changes = input.changes;
    if (
      !Array.isArray(transactionIds) ||
      transactionIds.length === 0 ||
      transactionIds.length > 100 ||
      new Set(transactionIds).size !== transactionIds.length ||
      !changes ||
      typeof changes !== "object" ||
      Array.isArray(changes)
    ) {
      const error = new TypeError(
        "transaction_ids and changes are required",
      );
      error.statusCode = 400;
      throw error;
    }
    const selected = transactionIds.map((transactionId) =>
      this.#transactions.find(
        (transaction) => transaction.id === transactionId,
      ),
    );
    if (selected.some((transaction) => !transaction)) {
      const error = new Error("Transaction not found");
      error.statusCode = 404;
      throw error;
    }
    if (selected.some((transaction) => transaction.pending)) {
      const error = new TypeError("Pending transactions cannot be edited");
      error.statusCode = 400;
      throw error;
    }

    const recognizedChanges = [
      "display_name",
      "category_primary",
      "tags",
      "excluded_from_spending",
      "budget_month_offset",
    ].filter((field) => Object.hasOwn(changes, field));
    if (recognizedChanges.length === 0) {
      const error = new TypeError("At least one change is required");
      error.statusCode = 400;
      throw error;
    }
    let tags;
    if (Object.hasOwn(changes, "tags")) {
      if (!Array.isArray(changes.tags)) {
        const error = new TypeError("tags must be an array");
        error.statusCode = 400;
        throw error;
      }
      tags = changes.tags.map((tag) => String(tag).trim());
      if (
        tags.some((tag) => !tag) ||
        new Set(tags).size !== tags.length
      ) {
        const error = new TypeError("tags must be unique, nonblank strings");
        error.statusCode = 400;
        throw error;
      }
    }
    for (const field of ["excluded_from_spending"]) {
      if (
        Object.hasOwn(changes, field) &&
        typeof changes[field] !== "boolean"
      ) {
        const error = new TypeError(`${field} must be a boolean`);
        error.statusCode = 400;
        throw error;
      }
    }
    if (
      Object.hasOwn(changes, "budget_month_offset") &&
      (
        !Number.isInteger(changes.budget_month_offset) ||
        ![-1, 0, 1].includes(changes.budget_month_offset)
      )
    ) {
      const error = new TypeError(
        "budget_month_offset must be -1, 0, or 1",
      );
      error.statusCode = 400;
      throw error;
    }

    for (const transaction of selected) {
      let manual = this.#manualTransactionFields.get(transaction.id);
      if (!manual) {
        manual = new Set();
        this.#manualTransactionFields.set(transaction.id, manual);
      }
      if (Object.hasOwn(changes, "display_name")) {
        const displayName = String(
          changes.display_name ?? "",
        ).trim();
        if (displayName) {
          manual.add("display_name");
          transaction.display_name = displayName;
          transaction.merchant = transaction.display_name;
        } else {
          manual.delete("display_name");
        }
      }
      if (Object.hasOwn(changes, "category_primary")) {
        manual.add("category_primary");
        transaction.category_primary =
          String(changes.category_primary ?? "").trim() ||
          transaction.raw_category_primary;
        transaction.category = transaction.category_primary;
      }
      if (tags) {
        manual.add("tags");
        transaction.tags = [...tags];
        for (const tag of tags) {
          this.#availableTransactionTags.add(tag);
        }
      }
      if (Object.hasOwn(changes, "excluded_from_spending")) {
        manual.add("excluded_from_spending");
        transaction.excluded_from_spending =
          changes.excluded_from_spending;
      }
      if (Object.hasOwn(changes, "budget_month_offset")) {
        manual.add("budget_month_on");
        transaction.budget_month_on =
          changes.budget_month_offset === 0
            ? null
            : shiftDemoTransactionMonth(
                transaction.posted_on ?? transaction.date,
                changes.budget_month_offset,
              );
      }
    }
    this.#refreshTransactionCleanupRuleApplications();

    return {
      updated_count: selected.length,
      transaction_ids: [...transactionIds],
    };
  }

  async updateTransactionNote(input = {}, actor = null) {
    const transactionId = input.transactionId ?? input.transaction_id;
    const transaction = this.#transactions.find(
      (candidate) => candidate.id === transactionId,
    );
    if (!transaction) {
      const error = new Error("Transaction not found");
      error.statusCode = 404;
      throw error;
    }
    const expectedVersion = Number(
      input.expectedVersion ?? input.expected_note_version,
    );
    if (
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0
    ) {
      const error = new TypeError(
        "expected_note_version must be a non-negative integer",
      );
      error.statusCode = 400;
      throw error;
    }
    if (expectedVersion !== Number(transaction.note_version ?? 0)) {
      const error = new Error(
        "This note changed after you opened it. Reload the current note before saving.",
      );
      error.statusCode = 409;
      error.expose = true;
      throw error;
    }
    if (input.note !== null && typeof input.note !== "string") {
      const error = new TypeError("note must be a string or null");
      error.statusCode = 400;
      throw error;
    }
    const note = input.note == null ? null : input.note.trim() || null;
    if (note && note.length > 2000) {
      const error = new TypeError(
        "note must be between 1 and 2000 characters",
      );
      error.statusCode = 400;
      throw error;
    }
    transaction.note = note;
    transaction.note_version = Number(transaction.note_version ?? 0) + 1;
    transaction.note_updated_by = actor?.id ?? null;
    transaction.note_updated_at = new Date().toISOString();
    return {
      transaction_id: transaction.id,
      note: transaction.note,
      note_version: transaction.note_version,
      note_updated_by: transaction.note_updated_by,
      note_updated_at: transaction.note_updated_at,
    };
  }

  #syncInsightStatusCounts() {
    const findings = [...this.#insightFindings.values()];
    const activeCount = findings.filter(
      (finding) => finding.state === "active",
    ).length;
    this.#insightStatus = {
      ...this.#insightStatus,
      active_count: activeCount,
      archived_count: findings.length - activeCount,
      total_count: findings.length,
    };
  }

  #validateInsightCorrection(findings, reasonCode) {
    if (
      reasonCode === "not_subscription" &&
      findings.some(
        (finding) =>
          finding.family !== "subscriptions" ||
          !finding.evidence?.some((entry) =>
            ["recurring", "recurring_stream"].includes(
              entry.entity_type,
            ),
          ),
      )
    ) {
      const error = new TypeError(
        "Not a subscription only applies to subscription insights with recurring evidence",
      );
      error.statusCode = 400;
      throw error;
    }
  }

  async actOnFinding(input = {}) {
    const findingId = input.findingId ?? input.finding_id;
    const requestedAction = input.action;
    const action =
      requestedAction === "dismiss"
        ? "ignore"
        : requestedAction === "mark_bad"
          ? "report_incorrect"
          : requestedAction;
    const finding = this.#insightFindings.get(findingId);
    if (!finding) {
      const error = new Error("Insight finding could not be found");
      error.statusCode = 404;
      throw error;
    }
    const reasonCode =
      input.reasonCode ??
      input.reason_code ??
      (requestedAction === "mark_bad"
        ? "other_false_positive"
        : null);
    this.#validateInsightCorrection([finding], reasonCode);
    if (action === "delete") {
      this.#insightFindings.delete(findingId);
      this.#syncInsightStatusCounts();
      return {
        updated: true,
        deleted: true,
        demo: true,
        action,
        finding_id: findingId,
      };
    }
    const state = {
      archive: "archived",
      ignore: "dismissed",
      report_incorrect: "bad",
      restore: "active",
    }[action];
    if (state) finding.state = state;
    this.#syncInsightStatusCounts();
    return {
      updated: true,
      demo: true,
      action,
      state: finding.state,
      finding_id: findingId,
      ...(reasonCode ? { reason_code: reasonCode } : {}),
    };
  }

  async batchActOnFindings(input = {}) {
    const findingIds = input.findingIds ?? input.finding_ids ?? [];
    const requestedAction = input.action;
    const action =
      requestedAction === "dismiss"
        ? "ignore"
        : requestedAction === "mark_bad"
          ? "report_incorrect"
          : requestedAction;
    const reasonCode =
      input.reasonCode ??
      input.reason_code ??
      (requestedAction === "mark_bad"
        ? "other_false_positive"
        : null);
    const selected = findingIds.map((findingId) =>
      this.#insightFindings.get(findingId),
    );
    if (selected.some((finding) => !finding)) {
      const error = new Error(
        "One or more insight findings could not be found",
      );
      error.statusCode = 404;
      throw error;
    }
    this.#validateInsightCorrection(selected, reasonCode);
    const state = {
      archive: "archived",
      ignore: "dismissed",
      report_incorrect: "bad",
      restore: "active",
    }[action];
    if (!state) {
      const error = new TypeError("Unsupported insight action");
      error.statusCode = 400;
      throw error;
    }
    for (const finding of selected) {
      finding.state = state;
    }
    this.#syncInsightStatusCounts();
    return {
      updated: true,
      demo: true,
      action,
      state,
      updated_count: selected.length,
      finding_ids: findingIds,
      ...(reasonCode ? { reason_code: reasonCode } : {}),
    };
  }

  async getInsightStatus() {
    return structuredClone(this.#insightStatus);
  }

  async setInsightsEnabled(input = {}) {
    if (typeof input.enabled !== "boolean") {
      throw demoInsightLlmError("enabled must be a boolean");
    }
    this.#insightStatus = {
      ...this.#insightStatus,
      state: input.enabled ? "ready" : "paused",
      enabled: input.enabled,
      can_run: input.enabled,
      pause_reasons: input.enabled
        ? []
        : [
            {
              code: "manual_pause",
              message: "Insights were paused manually.",
            },
          ],
    };
    return {
      updated: true,
      enabled: input.enabled,
      updated_by: null,
      updated_at: new Date().toISOString(),
      demo: true,
    };
  }

  async getInsightLlmAdminState() {
    const defaults = structuredClone(DEFAULT_INSIGHT_LLM_SETTINGS);
    delete defaults.revision;
    const statuses = structuredClone(this.#insightLlmCallStatuses);
    const totals = Object.values(statuses)
      .map((status) => status.total_tokens)
      .filter(Number.isSafeInteger);
    return {
      settings: structuredClone(this.#insightLlmSettings),
      defaults,
      locked_contract: LOCKED_RANKING_CONTRACT,
      metadata: demoInsightLlmMetadata(),
      call_statuses: statuses,
      narrative_provenance: {
        weekly: {
          guidance_revision: 1,
          prompt_hash: "demo-prompt-hash",
          model: "demo-finance-ranker",
          generated_at: "2026-07-27T09:02:00.000Z",
        },
      },
      applied_revision_by_family: {
        weekly: 1,
        investments: null,
        subscriptions: null,
      },
      last_applied_revision: 1,
      mixed_applied_revisions: false,
      older_narrative_families: [],
      families_without_narrative: [
        "investments",
        "subscriptions",
      ],
      throughput: {
        run_id: "demo-insight-run-1",
        total_tokens: totals.reduce((sum, value) => sum + value, 0),
        calls_with_usage: totals.length,
        call_count: Object.keys(statuses).length,
      },
    };
  }

  async previewInsightLlm(input = {}) {
    const context = this.#demoInsightLlmContext(input);
    return demoInsightLlmPreview(context, {
      lastActualUsage:
        this.#insightLlmCallStatuses[context.family] ?? null,
    });
  }

  async testInsightLlmDraft(input = {}) {
    const context = this.#demoInsightLlmContext(input);
    const preview = demoInsightLlmPreview(context, {
      lastActualUsage:
        this.#insightLlmCallStatuses[context.family] ?? null,
    });
    const selected = context.findings
      .slice(0, context.settings.result_limit)
      .map((finding) => finding.id);
    const rawResponse = JSON.stringify({
      prompt_version: 1,
      lead_finding_id: selected[0] ?? null,
      finding_ids: selected,
    });
    return {
      ...preview,
      status: selected.length ? "succeeded" : "no_candidates",
      selection: selected.length
        ? {
            lead_finding_id: selected[0],
            finding_ids: selected,
          }
        : null,
      narrative: null,
      telemetry: {
        guidance_revision: context.settings.revision,
        model: "demo-finance-ranker",
        status: selected.length ? "succeeded" : "no_candidates",
        estimated_input_tokens: preview.estimated_input_tokens,
        prompt_tokens: selected.length
          ? preview.estimated_input_tokens - 11
          : null,
        completion_tokens: selected.length ? 31 : null,
        total_tokens: selected.length
          ? preview.estimated_input_tokens + 20
          : null,
        context_length: preview.context_length,
        finish_reason: selected.length ? "stop" : null,
        latency_ms: 184,
      },
      actual_usage: selected.length
        ? {
            prompt_tokens: preview.estimated_input_tokens - 11,
            completion_tokens: 31,
            total_tokens: preview.estimated_input_tokens + 20,
          }
        : null,
      raw_response: rawResponse.slice(0, 8_000),
    };
  }

  async saveInsightLlmSettings(input = {}, _actor = null) {
    const expectedRevision = Number(
      input.expected_revision ?? input.expectedRevision,
    );
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    ) {
      throw demoInsightLlmError(
        "expected_revision must be a non-negative integer",
      );
    }
    if (expectedRevision !== this.#insightLlmSettings.revision) {
      const error = demoInsightLlmError(
        "The LLM ranking settings changed. Refresh and try again.",
        409,
      );
      error.code = "INSIGHT_LLM_REVISION_CONFLICT";
      error.currentSettings = structuredClone(
        this.#insightLlmSettings,
      );
      throw error;
    }
    const settings = demoValidatedInsightLlmSettings(
      input.settings ?? input,
      this.#insightLlmSettings,
    );
    this.#insightLlmSettings = {
      ...settings,
      revision: expectedRevision + 1,
    };
    return {
      saved: true,
      settings: structuredClone(this.#insightLlmSettings),
    };
  }

  #demoInsightLlmContext(input) {
    const family = input.family;
    if (
      !["weekly", "investments", "subscriptions"].includes(family)
    ) {
      throw demoInsightLlmError(
        "family must be weekly, investments, or subscriptions",
      );
    }
    const settings = demoValidatedInsightLlmSettings(
      input.settings ?? input,
      this.#insightLlmSettings,
    );
    const findings = [...this.#insightFindings.values()]
      .filter(
        (finding) =>
          finding.family === family &&
          (finding.state ?? "active") === "active",
      )
      .slice(0, settings.candidate_limit);
    const staleReason =
      this.#insightStatus.data_warnings[0]?.message ?? null;
    return {
      family,
      settings,
      findings,
      dataStale: this.#insightStatus.data_stale,
      staleReason,
    };
  }

  async forceRunInsights() {
    if (!this.#insightStatus.enabled) {
      throw demoInsightLlmError(
        "Insights are paused: Insights were paused manually.",
        409,
      );
    }
    const completedAt = new Date().toISOString();
    this.#insightStatus = {
      ...this.#insightStatus,
      state: "ready",
      can_run: true,
      last_run_at: completedAt,
      last_run_status: "succeeded",
      last_findings_generated_at: completedAt,
    };
    return {
      queued: true,
      demo: true,
      status: "queued",
    };
  }

  async clearInsights() {
    const findingsDeleted = this.#insightFindings.size;
    this.#insightFindings.clear();
    this.#insightStatus = {
      ...this.#insightStatus,
      active_count: 0,
      archived_count: 0,
      total_count: 0,
      last_findings_generated_at: null,
    };
    return {
      cleared: true,
      demo: true,
      findings_deleted: findingsDeleted,
      narratives_deleted: 3,
      search_documents_deleted: findingsDeleted,
      feedback_preserved: true,
      recurring_corrections_preserved: true,
    };
  }

  async updateRecurringClassification(input) {
    const streamId = input.streamId ?? input.stream_id;
    const type = input.type;
    if (
      !["subscription", "bill", "frequent_spending"].includes(type)
    ) {
      throw new TypeError("Invalid recurring classification");
    }
    const stream = this.#recurring.find(
      (candidate) => candidate.id === streamId,
    );
    if (!stream) {
      const error = new Error("Recurring stream not found");
      error.statusCode = 404;
      throw error;
    }
    stream.type = type;
    const pattern = this.#recurringPatterns.get(
      stream.manual_pattern_rule_id,
    );
    if (pattern) {
      if (type === "frequent_spending") {
        this.#recurringPatterns.delete(pattern.id);
      } else {
        pattern.type = type;
        for (const transaction of this.#transactions) {
          if (
            transaction.recurring_pattern?.patternId === pattern.id
          ) {
            transaction.recurring_pattern.type = type;
          }
        }
      }
    }
    return {
      updated: true,
      demo: true,
      stream_id: streamId,
      type,
      recompute_queued: false,
    };
  }

  async upsertTransactionRecurringPattern(input, actor = null) {
    const transactionId =
      input.transactionId ?? input.transaction_id;
    const type = String(input.type ?? "");
    const cadence = String(input.cadence ?? "");
    if (!["subscription", "bill"].includes(type)) {
      throw new TypeError("type must be subscription or bill");
    }
    if (
      ![
        "weekly",
        "biweekly",
        "monthly",
        "quarterly",
        "annual",
      ].includes(cadence)
    ) {
      throw new TypeError(
        "cadence must be weekly, biweekly, monthly, quarterly, or annual",
      );
    }
    const source = this.#transactions.find(
      (transaction) => transaction.id === transactionId,
    );
    if (!source) throw demoCategoryError("Transaction not found", 404);
    if (source.pending) {
      throw new TypeError(
        "Pending transactions cannot define recurring patterns",
      );
    }
    if (source.amount.amount_minor >= 0) {
      throw new TypeError(
        "Recurring patterns require a spending transaction",
      );
    }
    if (source.excluded_from_spending) {
      throw new TypeError(
        "Transactions excluded from spending cannot define recurring patterns",
      );
    }
    const normalizedMerchant = normalizeMerchant(
      source.raw_merchant ?? source.merchant,
    );
    const normalizedName = normalizeTransactionName(
      source.raw_name ?? source.description,
    );
    const matchField = normalizedMerchant
      ? "normalized_merchant"
      : "normalized_name";
    const normalizedValue =
      matchField === "normalized_merchant"
        ? normalizedMerchant
        : normalizedName;
    const anchorAmount = Math.abs(source.amount.amount_minor);
    const tolerance = Math.max(200, Math.round(anchorAmount * 0.2));
    const accountId = source.account.id;
    const existing = [...this.#recurringPatterns.values()].find(
      (pattern) =>
        pattern.accountId === accountId &&
        pattern.matchField === matchField &&
        pattern.normalizedValue === normalizedValue &&
        Math.abs(pattern.anchorAmount - anchorAmount) <=
          Math.max(200, Math.round(pattern.anchorAmount * 0.2)),
    );
    const pattern = existing ?? {
      id: `demo-recurring-pattern-${transactionId}`,
      streamId: `demo-manual-recurring-${transactionId}`,
      accountId,
      matchField,
      normalizedValue,
      anchorAmount,
    };
    Object.assign(pattern, {
      type,
      cadence,
      anchorAmount,
      updatedBy: actor?.id ?? null,
    });
    this.#recurringPatterns.set(pattern.id, pattern);
    const matches = this.#transactions
      .filter((transaction) => {
        const candidate =
          matchField === "normalized_merchant"
            ? normalizeMerchant(
                transaction.raw_merchant ?? transaction.merchant,
              )
            : normalizeTransactionName(
                transaction.raw_name ?? transaction.description,
              );
        return (
          !transaction.pending &&
          !transaction.excluded_from_spending &&
          transaction.amount.amount_minor < 0 &&
          transaction.account.id === accountId &&
          candidate === normalizedValue &&
          Math.abs(
            Math.abs(transaction.amount.amount_minor) - anchorAmount,
          ) <= tolerance
        );
      })
      .sort((left, right) =>
        String(left.posted_on ?? left.date).localeCompare(
          String(right.posted_on ?? right.date),
        ),
      );
    for (const transaction of matches) {
      transaction.recurring_pattern = {
        eligible: true,
        manual: true,
        patternId: pattern.id,
        streamId: pattern.streamId,
        type,
        cadence,
        cadenceSuggested: false,
        ineligibleReason: null,
      };
    }
    const amounts = matches.map((transaction) =>
      Math.abs(transaction.amount.amount_minor),
    );
    const expectedAmount = Math.round(
      amounts.reduce((sum, amount) => sum + amount, 0) /
        amounts.length,
    );
    const last = matches.at(-1) ?? source;
    const lastDate = last.posted_on ?? last.date;
    const monthly = Math.round(
      expectedAmount * demoRecurringCadenceFactor(cadence),
    );
    const stream = {
      id: pattern.streamId,
      service:
        source.display_name ??
        source.merchant ??
        source.description,
      service_family: normalizedValue,
      type,
      detected_type: type,
      cadence,
      expected_amount: money(expectedAmount),
      monthly_equivalent: money(monthly),
      annual_equivalent: money(monthly * 12),
      next_estimated_date: demoNextRecurringDate(
        lastDate,
        cadence,
      ),
      confidence_basis_points: 10_000,
      status: "active",
      account: {
        id: source.account.id,
        name: source.account.name,
      },
      icon: "ph-repeat",
      category: source.category_primary ?? source.category,
      manual_pattern_rule_id: pattern.id,
      classification_signals: {
        manual_pattern: true,
        manual_pattern_rule_id: pattern.id,
        occurrence_count: matches.length,
        classification_confidence_basis_points: 10_000,
      },
      transactions: matches.map((transaction) => ({
        id: transaction.id,
        merchant:
          transaction.display_name ??
          transaction.merchant ??
          transaction.description,
        date: transaction.posted_on ?? transaction.date,
        category:
          transaction.category_primary ?? transaction.category,
        amount: { ...transaction.amount },
      })),
    };
    const streamIndex = this.#recurring.findIndex(
      (candidate) => candidate.id === pattern.streamId,
    );
    if (streamIndex >= 0) this.#recurring[streamIndex] = stream;
    else this.#recurring.push(stream);
    return {
      updated: true,
      demo: true,
      pattern: {
        id: pattern.id,
        stream_id: pattern.streamId,
        type,
        cadence,
        source: "manual",
      },
      recompute_queued: false,
    };
  }

  async removeTransactionRecurringPattern(input) {
    const transactionId =
      input.transactionId ?? input.transaction_id;
    const transaction = this.#transactions.find(
      (candidate) => candidate.id === transactionId,
    );
    if (!transaction) throw demoCategoryError("Transaction not found", 404);
    const patternId = transaction.recurring_pattern?.patternId;
    const pattern = patternId
      ? this.#recurringPatterns.get(patternId)
      : null;
    if (!pattern) {
      throw demoCategoryError(
        "Manual recurring pattern not found",
        404,
      );
    }
    this.#recurringPatterns.delete(pattern.id);
    this.#recurring = this.#recurring.filter(
      (stream) => stream.id !== pattern.streamId,
    );
    for (const candidate of this.#transactions) {
      if (
        candidate.recurring_pattern?.patternId === pattern.id
      ) {
        delete candidate.recurring_pattern;
      }
    }
    return {
      updated: true,
      removed: true,
      demo: true,
      pattern_id: pattern.id,
      recompute_queued: false,
    };
  }

  async updateInsightRule(input) {
    return { updated: true, rule: input };
  }

  async updateAccountBalanceGroup(input) {
    const accountId = input.accountId ?? input.account_id;
    const balanceGroup =
      input.balanceGroup ?? input.balance_group ?? null;
    const account = this.#accounts.find(
      (candidate) => candidate.id === accountId,
    );
    if (!account) {
      const error = new Error("Account not found");
      error.statusCode = 404;
      throw error;
    }
    if (balanceGroup != null && !BALANCE_GROUPS.has(balanceGroup)) {
      throw new TypeError("Invalid balance_group");
    }
    if (balanceGroup == null) {
      this.#accountGroups.delete(accountId);
    } else {
      this.#accountGroups.set(accountId, balanceGroup);
    }
    const updated = this.#accountCards().find(
      (candidate) => candidate.id === accountId,
    );
    return {
      updated: true,
      demo: true,
      account_id: accountId,
      balance_group: balanceGroup,
      account: updated,
    };
  }

  async createManualAsset(input) {
    const id = `asset_demo_${this.#manualAssetSequence++}`;
    const asset = {
      id,
      name: input.name,
      asset_type: input.assetType ?? input.asset_type,
      description: input.description ?? null,
      currency_code: input.currencyCode ?? input.currency_code,
      value_minor: input.valueMinor ?? input.value_minor,
      valued_on: input.valuedOn ?? input.valued_on,
      active: true,
    };
    this.#manualAssets.set(id, asset);
    return {
      created: true,
      demo: true,
      asset: this.#manualAssetCards().find(
        (candidate) => candidate.id === id,
      ),
    };
  }

  async updateManualAsset(input) {
    const assetId = input.assetId ?? input.asset_id;
    const existing = this.#manualAssets.get(assetId);
    if (!existing) {
      const error = new Error("Manual asset not found");
      error.statusCode = 404;
      throw error;
    }
    const asset = { ...existing };
    if (input.name !== undefined) asset.name = input.name;
    if (input.assetType !== undefined || input.asset_type !== undefined) {
      asset.asset_type = input.assetType ?? input.asset_type;
    }
    if (Object.hasOwn(input, "description")) {
      asset.description = input.description ?? null;
    }
    if (
      input.currencyCode !== undefined ||
      input.currency_code !== undefined
    ) {
      asset.currency_code =
        input.currencyCode ?? input.currency_code;
    }
    if (input.valueMinor !== undefined || input.value_minor !== undefined) {
      asset.value_minor = input.valueMinor ?? input.value_minor;
    }
    if (input.valuedOn !== undefined || input.valued_on !== undefined) {
      asset.valued_on = input.valuedOn ?? input.valued_on;
    }
    this.#manualAssets.set(assetId, asset);
    return {
      updated: true,
      demo: true,
      asset: this.#manualAssetCards({
        includeInactive: true,
      }).find((candidate) => candidate.id === assetId),
    };
  }

  async archiveManualAsset(input) {
    const assetId = input.assetId ?? input.asset_id;
    const existing = this.#manualAssets.get(assetId);
    if (!existing) {
      const error = new Error("Manual asset not found");
      error.statusCode = 404;
      throw error;
    }
    const asset = { ...existing, active: false };
    this.#manualAssets.set(assetId, asset);
    return {
      archived: true,
      demo: true,
      asset_id: assetId,
      asset: this.#manualAssetCards({
        includeInactive: true,
      }).find((candidate) => candidate.id === assetId),
    };
  }
}

function boundedDemoSearchLimit(value, fallback = 30) {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number)
    ? Math.max(1, Math.min(50, number))
    : fallback;
}

function rankDemoSearchItem(item, query) {
  const queryText = normalizedDemoSearchText(query);
  const itemText = normalizedDemoSearchText(
    item.searchText ?? `${item.title} ${item.meta}`,
  );
  const similarity = demoSearchTextSimilarity(itemText, queryText);
  if (itemText === queryText) return { tier: 4, similarity };
  if (itemText.startsWith(queryText)) return { tier: 3, similarity };
  const words = new Set(itemText.split(" ").filter(Boolean));
  const queryWords = queryText.split(" ").filter(Boolean);
  if (queryWords.every((word) => words.has(word))) {
    return { tier: 2, similarity };
  }
  if (itemText.includes(queryText) || similarity >= 0.2) {
    return { tier: 1, similarity };
  }
  return null;
}

function normalizedDemoSearchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function demoSearchTextSimilarity(left, right) {
  if (!left || !right) return 0;
  const trigrams = (value) => {
    const padded = `  ${value} `;
    const result = [];
    for (let index = 0; index < padded.length - 2; index += 1) {
      result.push(padded.slice(index, index + 3));
    }
    return result;
  };
  const leftTrigrams = trigrams(left);
  const rightTrigrams = trigrams(right);
  const remaining = [...rightTrigrams];
  let overlap = 0;
  for (const trigram of leftTrigrams) {
    const index = remaining.indexOf(trigram);
    if (index < 0) continue;
    overlap += 1;
    remaining.splice(index, 1);
  }
  return (
    (2 * overlap) /
    (leftTrigrams.length + rightTrigrams.length)
  );
}

function demoCreditPeriod(value) {
  const name = ["1w", "1m", "1y", "all"].includes(value)
    ? value
    : "1m";
  return {
    "1w": {
      name: "1w",
      label: "Last week",
      start_on: "2026-07-19",
      end_on: "2026-07-27",
    },
    "1m": {
      name: "1m",
      label: "Last month",
      start_on: "2026-06-26",
      end_on: "2026-07-27",
    },
    "1y": {
      name: "1y",
      label: "Last year",
      start_on: "2025-07-26",
      end_on: "2026-07-27",
    },
    all: {
      name: "all",
      label: "All history",
      start_on: "1970-01-01",
      end_on: "2026-07-27",
    },
  }[name];
}

function demoInsightLlmMetadata() {
  return {
    configured: true,
    model: "demo-finance-ranker",
    destination_host: "demo.local:1234",
    model_state: "loaded",
    context_length: 8_192,
    context_length_source: "model",
  };
}

function demoInsightLlmError(message, statusCode = 400) {
  const error = new TypeError(message);
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

function demoValidatedInsightLlmSettings(input, base) {
  const fields = [
    "base_guidance",
    "family_guidance",
    "candidate_limit",
    "result_limit",
    "feedback_mode",
    "feedback_limit",
    "context_length",
  ];
  const payload = Object.fromEntries(
    fields
      .filter((key) => Object.hasOwn(input ?? {}, key))
      .map((key) => [key, input[key]]),
  );
  try {
    return validateInsightLlmSettings(payload, {
      base,
      allowPartial: false,
    });
  } catch (error) {
    throw demoInsightLlmError(
      error instanceof Error
        ? error.message
        : "The LLM ranking settings are invalid.",
    );
  }
}

function demoInsightLlmPreview(
  {
    family,
    settings,
    findings,
    dataStale = false,
    staleReason = null,
  },
  { lastActualUsage = null } = {},
) {
  const requestBody = buildInsightLlmRequest({
    family,
    findings,
    feedback: {},
    settings,
    model: "demo-finance-ranker",
  });
  const serialized = JSON.stringify(requestBody);
  const estimatedInputTokens = estimateInputTokens(requestBody);
  const estimatedTotalTokens = estimatedInputTokens + 256;
  const contextLength = settings.context_length ?? 8_192;
  const percent = (estimatedTotalTokens / contextLength) * 100;
  return {
    family,
    request_body: requestBody,
    counts: {
      candidate_count: findings.length,
      bad_feedback_count: 0,
      archived_feedback_count: 0,
    },
    data_as_of: DATA_AS_OF,
    data_stale: dataStale,
    stale_reason: staleReason,
    stale_reasons: staleReason ? [staleReason] : [],
    estimated_input_tokens: estimatedInputTokens,
    output_token_reserve: 256,
    estimated_total_tokens: estimatedTotalTokens,
    context_length: contextLength,
    context_length_source:
      settings.context_length == null ? "model" : "settings",
    utilization: {
      percent,
      state:
        percent > 100
          ? "over"
          : percent >= 95
            ? "critical"
            : percent >= 80
              ? "warning"
              : "normal",
    },
    model_state: "loaded",
    model: "demo-finance-ranker",
    destination_host: "demo.local:1234",
    last_actual_usage: lastActualUsage,
    prompt_hash: createHash("sha256")
      .update(serialized)
      .digest("hex"),
    guidance_revision: settings.revision,
  };
}

export function createDemoFinanceService(options = {}) {
  return new DemoFinanceService(options);
}
