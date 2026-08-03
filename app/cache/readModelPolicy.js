const CACHE_PRODUCT = "money";
const CACHE_VERSION = "v1";
const DEFAULT_NODE_ENVIRONMENT = "development";

export const PRODUCTION_READ_MODEL_CACHE_NAMESPACE =
  "money:production:v1";
export const MAX_STABLE_READ_MODEL_KEYS_PER_WORKSPACE = 24;

export const DASHBOARD_READ_MODEL_PERIODS = Object.freeze([
  "1w",
  "1m",
  "1y",
  "all",
]);

export const READ_MODEL_SLOTS = Object.freeze({
  DASHBOARD_1W: "page:dashboard:1w",
  DASHBOARD_1M: "page:dashboard:1m",
  DASHBOARD_1Y: "page:dashboard:1y",
  DASHBOARD_ALL: "page:dashboard:all",
  PLAN_OVERVIEW_CURRENT: "page:plan:overview:current",
  PLAN_BUDGET_CURRENT: "page:plan:budget:current",
  PLAN_BUDGET_PREVIOUS: "page:plan:budget:previous",
  SAFE_TO_SPEND_CURRENT: "planning:safe-to-spend:current",
  TRANSACTIONS_CURRENT_MONTH_BASE:
    "page:transactions:current-month:base",
  SHARED_OVERVIEW_CURRENT: "shared:overview:current",
  SHARED_TRANSACTIONS_RECENT: "shared:transactions:recent",
  SHARED_HISTORY_BOUNDED: "shared:history:bounded",
  SHARED_ACCOUNTS_ACTIVE: "shared:accounts:active",
  SHARED_INSIGHTS_ACTIVE: "shared:insights:active",
  SHARED_SPENDING_CATEGORIES_ACTIVE:
    "shared:spending-categories:active",
});

export const SHARED_READ_MODELS = Object.freeze({
  accounts: READ_MODEL_SLOTS.SHARED_ACCOUNTS_ACTIVE,
  insights: READ_MODEL_SLOTS.SHARED_INSIGHTS_ACTIVE,
  overview: READ_MODEL_SLOTS.SHARED_OVERVIEW_CURRENT,
  recentTransactions: READ_MODEL_SLOTS.SHARED_TRANSACTIONS_RECENT,
  safeToSpend: READ_MODEL_SLOTS.SAFE_TO_SPEND_CURRENT,
  spendingCategories:
    READ_MODEL_SLOTS.SHARED_SPENDING_CATEGORIES_ACTIVE,
  boundedHistory: READ_MODEL_SLOTS.SHARED_HISTORY_BOUNDED,
});

const STABLE_READ_MODEL_SLOTS = Object.freeze(
  Object.values(READ_MODEL_SLOTS),
);
const STABLE_READ_MODEL_SLOT_SET = new Set(STABLE_READ_MODEL_SLOTS);
const DASHBOARD_PERIOD_SET = new Set(DASHBOARD_READ_MODEL_PERIODS);
const DASHBOARD_METRICS = new Set([
  "cash",
  "short_term",
  "retirement",
  "net_worth",
]);
const TRANSACTION_FILTER_KEYS = Object.freeze([
  "account",
  "category",
  "category_id",
  "merchant",
]);
const TRANSACTION_QUERY_KEYS = new Set([
  ...TRANSACTION_FILTER_KEYS,
  "analytics_group",
  "cursor",
  "end",
  "period",
  "q",
  "sort",
  "start",
  "transaction",
]);

if (
  STABLE_READ_MODEL_SLOTS.length >
  MAX_STABLE_READ_MODEL_KEYS_PER_WORKSPACE
) {
  throw new Error("Read-model cache policy exceeds its stable key budget.");
}

export function readModelCacheNamespace(
  nodeEnvironment = process.env.NODE_ENV || DEFAULT_NODE_ENVIRONMENT,
) {
  const environment = requiredCacheSegment(
    nodeEnvironment,
    "nodeEnvironment",
  ).toLowerCase();
  return `${CACHE_PRODUCT}:${environment}:${CACHE_VERSION}`;
}

export function readModelCacheKey({
  workspaceId = "shared",
  slot,
  nodeEnvironment,
  variant = null,
} = {}) {
  if (!STABLE_READ_MODEL_SLOT_SET.has(slot)) {
    throw new TypeError("slot is not an allowlisted read-model cache slot");
  }
  const workspace = encodeURIComponent(
    requiredCacheSegment(workspaceId, "workspaceId"),
  );
  const suffix = variant == null
    ? ""
    : `:${requiredCacheVariant(variant)}`;
  return `${readModelCacheNamespace(nodeEnvironment)}:workspace:${workspace}:${slot}${suffix}`;
}

export function stableReadModelSlots() {
  return [...STABLE_READ_MODEL_SLOTS];
}

export function resolvePageReadModelPolicy({
  page,
  query = {},
  workspaceId = "shared",
  nodeEnvironment,
  now = new Date(),
} = {}) {
  const namespace = safeNamespace(nodeEnvironment);
  if (!namespace) {
    return rejectedPolicy("invalid_environment", null);
  }
  if (!validWorkspaceId(workspaceId)) {
    return rejectedPolicy("invalid_workspace", namespace);
  }
  const normalizedPage = normalizePage(page);
  const entries = queryEntries(query);
  if (!entries) {
    return rejectedPolicy("invalid_query", namespace);
  }

  if (normalizedPage === "dashboard") {
    return dashboardPolicy({
      entries,
      workspaceId,
      nodeEnvironment,
      namespace,
      now,
    });
  }
  if (normalizedPage === "plan") {
    return planPolicy({
      entries,
      workspaceId,
      nodeEnvironment,
      namespace,
      now,
    });
  }
  if (normalizedPage === "transactions") {
    return transactionsPolicy({
      entries,
      workspaceId,
      nodeEnvironment,
      namespace,
      now,
    });
  }
  return rejectedPolicy("unsupported_page", namespace);
}

export function resolveSharedReadModelPolicy({
  read,
  workspaceId = "shared",
  nodeEnvironment,
} = {}) {
  const namespace = safeNamespace(nodeEnvironment);
  if (!namespace) {
    return rejectedPolicy("invalid_environment", null);
  }
  if (!validWorkspaceId(workspaceId)) {
    return rejectedPolicy("invalid_workspace", namespace);
  }
  if (!Object.hasOwn(SHARED_READ_MODELS, read)) {
    return rejectedPolicy("unsupported_shared_read", namespace);
  }
  const slot = SHARED_READ_MODELS[read];
  return eligiblePolicy({
    slot,
    workspaceId,
    nodeEnvironment,
    namespace,
  });
}

function dashboardPolicy({
  entries,
  workspaceId,
  nodeEnvironment,
  namespace,
  now,
}) {
  if (hasUnknownKeys(entries, new Set(["metric", "period"]))) {
    return rejectedPolicy("dashboard_query_not_allowlisted", namespace);
  }
  const period = scalarQueryValue(entries, "period");
  const metric = scalarQueryValue(entries, "metric");
  if (period.invalid || metric.invalid) {
    return rejectedPolicy("invalid_query", namespace);
  }
  const normalizedPeriod = period.value || "1m";
  if (!DASHBOARD_PERIOD_SET.has(normalizedPeriod)) {
    return rejectedPolicy("dashboard_period_not_allowlisted", namespace);
  }
  if (metric.value && !DASHBOARD_METRICS.has(metric.value)) {
    return rejectedPolicy("dashboard_metric_not_allowlisted", namespace);
  }
  const slots = {
    "1w": READ_MODEL_SLOTS.DASHBOARD_1W,
    "1m": READ_MODEL_SLOTS.DASHBOARD_1M,
    "1y": READ_MODEL_SLOTS.DASHBOARD_1Y,
    all: READ_MODEL_SLOTS.DASHBOARD_ALL,
  };
  return eligiblePolicy({
    slot: slots[normalizedPeriod],
    workspaceId,
    nodeEnvironment,
    namespace,
    variant: dashboardRangeVariant(normalizedPeriod, now),
  });
}

function planPolicy({
  entries,
  workspaceId,
  nodeEnvironment,
  namespace,
}) {
  if (hasUnknownKeys(entries, new Set(["edit_budget"]))) {
    return rejectedPolicy("plan_query_not_allowlisted", namespace);
  }
  const editBudget = scalarQueryValue(entries, "edit_budget");
  if (
    editBudget.invalid ||
    !["", "0", "1"].includes(editBudget.value)
  ) {
    return rejectedPolicy("plan_query_not_allowlisted", namespace);
  }
  return eligiblePolicy({
    slot: READ_MODEL_SLOTS.PLAN_OVERVIEW_CURRENT,
    workspaceId,
    nodeEnvironment,
    namespace,
  });
}

function transactionsPolicy({
  entries,
  workspaceId,
  nodeEnvironment,
  namespace,
  now,
}) {
  if (hasUnknownKeys(entries, TRANSACTION_QUERY_KEYS)) {
    return rejectedPolicy("transactions_query_not_allowlisted", namespace);
  }
  const query = Object.fromEntries(
    [...TRANSACTION_QUERY_KEYS].map((key) => [
      key,
      scalarQueryValue(entries, key),
    ]),
  );
  if (Object.values(query).some((value) => value.invalid)) {
    return rejectedPolicy("invalid_query", namespace);
  }
  if (query.q.value) {
    return rejectedPolicy("transactions_search", namespace);
  }
  if (TRANSACTION_FILTER_KEYS.some((key) => query[key].value)) {
    return rejectedPolicy("transactions_filter", namespace);
  }
  if (query.start.value || query.end.value) {
    return rejectedPolicy("transactions_custom_period", namespace);
  }
  if (query.period.value && query.period.value !== "month") {
    return rejectedPolicy("transactions_nondefault_period", namespace);
  }
  if (query.sort.value && query.sort.value !== "date") {
    return rejectedPolicy("transactions_nondefault_sort", namespace);
  }
  if (query.cursor.value) {
    return rejectedPolicy("transactions_cursor", namespace);
  }
  if (
    query.analytics_group.value &&
    query.analytics_group.value !== "category"
  ) {
    return rejectedPolicy("transactions_nondefault_analytics", namespace);
  }

  const transactionId = query.transaction.value;
  if (transactionId && !validTransactionId(transactionId)) {
    return rejectedPolicy("invalid_transaction", namespace);
  }
  return eligiblePolicy({
    slot: READ_MODEL_SLOTS.TRANSACTIONS_CURRENT_MONTH_BASE,
    workspaceId,
    nodeEnvironment,
    namespace,
    variant: `month:${cacheDate(now).slice(0, 7)}`,
    overlay: transactionId
      ? Object.freeze({
          cacheable: false,
          kind: "transaction-detail",
          transactionId,
        })
      : null,
  });
}

function eligiblePolicy({
  slot,
  workspaceId,
  nodeEnvironment,
  namespace,
  overlay = null,
  variant = null,
}) {
  return Object.freeze({
    eligible: true,
    namespace,
    key: readModelCacheKey({
      workspaceId,
      slot,
      nodeEnvironment,
      variant,
    }),
    slot,
    overlay,
    reason: null,
  });
}

function rejectedPolicy(reason, namespace) {
  return Object.freeze({
    eligible: false,
    namespace,
    key: null,
    slot: null,
    overlay: null,
    reason,
  });
}

function normalizePage(page) {
  const normalized = String(page ?? "").trim().toLowerCase();
  return {
    "/": "dashboard",
    dashboard: "dashboard",
    "/plan": "plan",
    plan: "plan",
    "/transactions": "transactions",
    transactions: "transactions",
  }[normalized] ?? null;
}

function queryEntries(query) {
  if (query instanceof URLSearchParams) {
    const grouped = new Map();
    for (const [key, value] of query.entries()) {
      const values = grouped.get(key) ?? [];
      values.push(value);
      grouped.set(key, values);
    }
    return grouped;
  }
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(query);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  return new Map(
    Object.entries(query).map(([key, value]) => [key, [value]]),
  );
}

function scalarQueryValue(entries, key) {
  const values = entries.get(key) ?? [];
  if (values.length === 0) return { invalid: false, value: "" };
  if (values.length !== 1) return { invalid: true, value: "" };
  const [value] = values;
  if (value == null) return { invalid: false, value: "" };
  if (typeof value !== "string") return { invalid: true, value: "" };
  if (value !== value.trim()) return { invalid: true, value: "" };
  return { invalid: false, value };
}

function hasUnknownKeys(entries, allowedKeys) {
  return [...entries.keys()].some((key) => !allowedKeys.has(key));
}

function validWorkspaceId(value) {
  try {
    requiredCacheSegment(value, "workspaceId");
    return true;
  } catch {
    return false;
  }
}

function validTransactionId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function safeNamespace(nodeEnvironment) {
  try {
    return readModelCacheNamespace(nodeEnvironment);
  } catch {
    return null;
  }
}

function requiredCacheSegment(value, field) {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) {
    throw new TypeError(`${field} must contain 1 to 128 characters`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new TypeError(`${field} contains unsupported characters`);
  }
  return normalized;
}

function requiredCacheVariant(value) {
  const normalized = String(value ?? "").trim();
  if (
    !normalized ||
    normalized.length > 128 ||
    !/^[A-Za-z0-9:._-]+$/.test(normalized)
  ) {
    throw new TypeError("variant contains unsupported characters");
  }
  return normalized;
}

function cacheDate(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError("now must be a valid date");
  }
  return parsed.toISOString().slice(0, 10);
}

function shiftCacheDate(value, days) {
  const parsed = new Date(`${cacheDate(value)}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function dashboardRangeVariant(period, now) {
  const days = { "1w": -7, "1m": -30, "1y": -365 }[period];
  const start = period === "all"
    ? "1970-01-01"
    : shiftCacheDate(now, days);
  return `range:${start}:${shiftCacheDate(now, 1)}`;
}
