import {
  canonicalJsonByteLength,
  canonicalJsonValue,
  canonicalStringify,
  assertCanonicalJsonCopy,
} from "./canonical.js";
import {
  FINANCE_CARD_KINDS,
  FINANCE_CARD_SCHEMA,
  FINANCE_CARD_VERSION,
  MAX_FINANCE_ENVELOPE_BYTES,
} from "./constants.js";
import {
  FinanceMcpError,
  FINANCE_MCP_ERROR_CODES,
  financeErrorData,
  normalizeFinanceMcpError,
} from "./errors.js";

const KIND_DISPLAY = Object.freeze({
  overview: { title: "Finance overview", path: "/" },
  insights: { title: "Finance insights", path: "/insights" },
  accounts: { title: "Accounts", path: "/accounts" },
  transactions: { title: "Transactions", path: "/transactions" },
  spending: { title: "Spending", path: "/transactions" },
  cash_flow: { title: "Cash flow", path: "/" },
  recurring: { title: "Recurring payments", path: "/recurring" },
  net_worth: { title: "Net worth", path: "/" },
  portfolio: { title: "Portfolio", path: "/portfolio" },
  credit_score: {
    title: "Tracked credit scores",
    path: "/credit?score_period=1y",
  },
  safe_to_spend: { title: "Safe to Spend", path: "/plan" },
  goals: { title: "Finance goals", path: "/plan#goals" },
  budget: { title: "Monthly budget", path: "/plan#budget" },
  scenario: { title: "Finance plan scenario", path: "/plan#scenario" },
  plan_change: { title: "Plan change", path: "/plan" },
});

const SNAKE_CASE_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const PROHIBITED_KEY =
  /(?:^|_)(?:access_token|public_token|client_secret|plaid_secret|bearer_token|session_secret|database_url|private_key|certificate)$/;
const MAX_NESTING_DEPTH = 14;
const MAX_ARRAY_ITEMS = 200;
const MAX_SUMMARY_LENGTH = 4_000;
const MAX_FINDINGS = 25;
const MAX_EVIDENCE = 20;
const MAX_ACTIONS = 8;
const MAX_RELATED_IDS = 50;
const ISO_CURRENCY = /^[A-Z]{3}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_FIELD_NAMES = new Set([
  "date",
  "start_date",
  "end_date",
  "current_start",
  "current_end",
  "previous_start",
  "previous_end",
  "period_start",
  "period_end",
  "next_estimated_date",
  "price_as_of",
]);

function validationFailure(message, options = {}) {
  return new FinanceMcpError(
    options.code ?? FINANCE_MCP_ERROR_CODES.INTERNAL_ERROR,
    options.publicMessage ?? "Finance data failed card validation.",
    {
      details: options.details,
      cause: new TypeError(message),
    },
  );
}

function cleanText(value, field, maximum, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) {
      return undefined;
    }
    throw validationFailure(`${field} is required.`);
  }
  if (typeof value !== "string") {
    throw validationFailure(`${field} must be a string.`);
  }
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  if (!clean && !optional) {
    throw validationFailure(`${field} must not be empty.`);
  }
  if (clean.length > maximum) {
    throw validationFailure(`${field} exceeds ${maximum} characters.`);
  }
  return clean || undefined;
}

function isoTimestamp(value, fallback, field) {
  const candidate = value ?? fallback;
  if (candidate instanceof Date) {
    if (!Number.isFinite(candidate.getTime())) {
      throw validationFailure(`${field} is an invalid date.`);
    }
    return candidate.toISOString();
  }
  if (typeof candidate !== "string") {
    throw validationFailure(`${field} must be an ISO timestamp.`);
  }

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(candidate)
    ? `${candidate}T00:00:00.000Z`
    : candidate;
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) {
    throw validationFailure(`${field} must be an ISO timestamp.`);
  }
  return parsed.toISOString();
}

function normalizedBaseUrl(value) {
  let url;
  try {
    url = new URL(value ?? "https://money.example.com");
  } catch (error) {
    throw validationFailure("baseUrl is invalid.", { cause: error });
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw validationFailure("baseUrl must be an HTTPS origin.");
  }

  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

function sameHostWebUrl(value, baseUrl, fallbackPath) {
  let url;
  try {
    url = new URL(value ?? fallbackPath, baseUrl);
  } catch (error) {
    throw validationFailure("display.web_url is invalid.", { cause: error });
  }

  if (
    url.protocol !== "https:" ||
    url.host !== baseUrl.host ||
    url.username ||
    url.password
  ) {
    throw validationFailure(
      "Finance card web_url values must use the configured HTTPS host.",
    );
  }
  return url.toString();
}

function normalizeWarnings(warnings) {
  if (warnings === undefined || warnings === null) {
    return [];
  }
  if (!Array.isArray(warnings) || warnings.length > 20) {
    throw validationFailure("warnings must be an array with at most 20 items.");
  }

  return warnings.map((warning, index) => {
    if (typeof warning === "string") {
      return cleanText(warning, `warnings[${index}]`, 500);
    }
    if (!warning || typeof warning !== "object" || Array.isArray(warning)) {
      throw validationFailure(`warnings[${index}] is invalid.`);
    }
    const code = cleanText(
      warning.code ?? "warning",
      `warnings[${index}].code`,
      64,
    );
    if (!/^[a-z][a-z0-9_]*$/.test(code)) {
      throw validationFailure(`warnings[${index}].code must be snake_case.`);
    }
    return {
      code,
      message: cleanText(
        warning.message,
        `warnings[${index}].message`,
        500,
      ),
    };
  });
}

function isValidIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isValidIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    ISO_TIMESTAMP.test(value) &&
    Number.isFinite(new Date(value).getTime())
  );
}

function validateMoneyObject(value, path) {
  const hasAmount = Object.hasOwn(value, "amount_minor");
  const hasCurrency = Object.hasOwn(value, "currency");
  if (!hasAmount) {
    if (
      hasCurrency &&
      (typeof value.currency !== "string" || !ISO_CURRENCY.test(value.currency))
    ) {
      throw validationFailure(`${path}.currency must be an ISO-4217 code.`);
    }
    return;
  }

  if (!hasCurrency) {
    throw validationFailure(
      `${path} must contain both amount_minor and currency.`,
    );
  }
  if (
    !Number.isSafeInteger(value.amount_minor) ||
    typeof value.currency !== "string" ||
    !ISO_CURRENCY.test(value.currency)
  ) {
    throw validationFailure(
      `${path} must be Money with a safe integer amount_minor and ISO-4217 currency.`,
    );
  }
  const extraKeys = Object.keys(value).filter(
    (key) => key !== "amount_minor" && key !== "currency",
  );
  if (extraKeys.length > 0) {
    throw validationFailure(
      `${path} Money contains unsupported fields: ${extraKeys.join(", ")}.`,
    );
  }
}

function requireString(value, key, path, maximum = 500) {
  if (
    typeof value[key] !== "string" ||
    value[key].trim().length === 0 ||
    value[key].length > maximum
  ) {
    throw validationFailure(`${path}.${key} must be a non-empty string.`);
  }
}

function validateFinding(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationFailure(`${path} must be a finding object.`);
  }
  requireString(value, "id", path, 128);
  requireString(value, "type", path, 80);
  requireString(value, "severity", path, 32);
  requireString(value, "title", path, 160);
  requireString(value, "explanation", path, 1_000);
  if (typeof value.rule === "string") {
    requireString(value, "rule", path, 120);
  } else if (
    !value.rule ||
    typeof value.rule !== "object" ||
    Array.isArray(value.rule)
  ) {
    throw validationFailure(
      `${path}.rule must be a short key or a bounded rule object.`,
    );
  }
  if (!value.metrics || typeof value.metrics !== "object" || Array.isArray(value.metrics)) {
    throw validationFailure(`${path}.metrics must be an object.`);
  }
  if (
    !Number.isSafeInteger(value.confidence_basis_points) ||
    value.confidence_basis_points < 0 ||
    value.confidence_basis_points > 10_000
  ) {
    throw validationFailure(
      `${path}.confidence_basis_points must be between 0 and 10000.`,
    );
  }
  if (!Array.isArray(value.evidence)) {
    throw validationFailure(`${path}.evidence must be an array.`);
  }
  if (!Array.isArray(value.actions)) {
    throw validationFailure(`${path}.actions must be an array.`);
  }
}

function validateEvidence(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationFailure(`${path} must be an evidence object.`);
  }
  requireString(value, "entity_type", path, 80);
  requireString(value, "entity_id", path, 128);
  requireString(value, "label", path, 240);
  requireString(value, "web_url", path, 1_000);
}

function validateAction(value, path) {
  if (typeof value === "string") {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(value)) {
      throw validationFailure(`${path} must be a bounded snake_case action.`);
    }
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationFailure(`${path} must be an action string or object.`);
  }
  requireString(value, "type", path, 64);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(value.type)) {
    throw validationFailure(`${path}.type must be snake_case.`);
  }
  if (value.label !== undefined) {
    requireString(value, "label", path, 120);
  }
}

function validateSemanticField(key, value, path) {
  if (key === "score" || key === "average_score") {
    if (
      value !== null &&
      (!Number.isSafeInteger(value) || value < 300 || value > 850)
    ) {
      throw validationFailure(`${path} must be between 300 and 850.`);
    }
  }

  if (key === "id" || key.endsWith("_id")) {
    if (
      value !== null &&
      (typeof value !== "string" || !OPAQUE_ID.test(value))
    ) {
      throw validationFailure(`${path} must be a bounded opaque ID.`);
    }
  }

  if (key.endsWith("_ids")) {
    if (
      !Array.isArray(value) ||
      value.length > MAX_RELATED_IDS ||
      value.some((id) => typeof id !== "string" || !OPAQUE_ID.test(id))
    ) {
      throw validationFailure(
        `${path} must contain at most ${MAX_RELATED_IDS} opaque IDs.`,
      );
    }
  }

  const boundedBasisPoints =
    key === "confidence_basis_points" ||
    key.endsWith("_share_basis_points") ||
    key.endsWith("_allocation_basis_points") ||
    key.endsWith("_concentration_basis_points") ||
    key.endsWith("_threshold_basis_points") ||
    key.endsWith("_contribution_basis_points") ||
    key === "share_basis_points" ||
    key === "allocation_basis_points" ||
    key === "concentration_basis_points" ||
    key === "threshold_basis_points" ||
    key === "contribution_basis_points";
  if (boundedBasisPoints) {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 10_000
    ) {
      throw validationFailure(`${path} must be between 0 and 10000.`);
    }
  } else if (
    key.endsWith("_basis_points") &&
    value !== null &&
    !Number.isSafeInteger(value)
  ) {
    throw validationFailure(`${path} must be a signed integer or null.`);
  }

  if (
    DATE_FIELD_NAMES.has(key) ||
    key.endsWith("_date") ||
    key.endsWith("_on")
  ) {
    if (value !== null && !isValidIsoDate(value)) {
      throw validationFailure(`${path} must be a valid ISO date.`);
    }
  }

  if (
    key === "cadence" &&
    value !== null &&
    ![
      "weekly",
      "biweekly",
      "biweekly_friday",
      "monthly",
      "quarterly",
      "annual",
      "irregular",
    ].includes(value)
  ) {
    throw validationFailure(`${path} is not a supported recurring cadence.`);
  }

  if (
    key === "timestamp" ||
    key.endsWith("_at") ||
    key.endsWith("_timestamp")
  ) {
    if (
      value !== null &&
      !isValidIsoDate(value) &&
      !isValidIsoTimestamp(value)
    ) {
      throw validationFailure(`${path} must be a valid ISO timestamp.`);
    }
  }
}

function validateCardData(
  value,
  baseUrl,
  path = "data",
  depth = 0,
  fieldKey,
) {
  if (depth > MAX_NESTING_DEPTH) {
    throw validationFailure(
      `Finance card data exceeds ${MAX_NESTING_DEPTH} levels.`,
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw validationFailure(`${path} contains a non-finite number.`);
    }
    if (
      (fieldKey === "amount_minor" ||
        fieldKey?.endsWith("_count")) &&
      !Number.isSafeInteger(value)
    ) {
      throw validationFailure(`${path} must be an integer.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    const maximum =
      fieldKey === "findings"
        ? MAX_FINDINGS
        : fieldKey === "evidence"
          ? MAX_EVIDENCE
          : fieldKey === "actions"
            ? MAX_ACTIONS
            : fieldKey?.endsWith("_ids")
              ? MAX_RELATED_IDS
              : MAX_ARRAY_ITEMS;
    if (value.length > maximum) {
      throw validationFailure(
        `${path} contains more than ${maximum} items.`,
      );
    }
    value.forEach((item, index) => {
      const itemPath = `${path}[${index}]`;
      if (fieldKey === "findings") {
        validateFinding(item, itemPath);
      } else if (fieldKey === "evidence") {
        validateEvidence(item, itemPath);
      } else if (fieldKey === "actions") {
        validateAction(item, itemPath);
      }
      validateCardData(item, baseUrl, itemPath, depth + 1, fieldKey);
    });
    return;
  }
  if (!value || typeof value !== "object") {
    throw validationFailure(`${path} contains a non-JSON value.`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw validationFailure(`${path} contains a non-plain object.`);
  }

  validateMoneyObject(value, path);

  for (const [key, child] of Object.entries(value)) {
    if (!SNAKE_CASE_KEY.test(key)) {
      throw validationFailure(`${path}.${key} is not snake_case.`);
    }
    if (PROHIBITED_KEY.test(key)) {
      throw validationFailure(`${path}.${key} is a prohibited secret field.`);
    }
    if (key === "web_url") {
      sameHostWebUrl(child, baseUrl, "/");
    }
    validateSemanticField(key, child, `${path}.${key}`);
    validateCardData(child, baseUrl, `${path}.${key}`, depth + 1, key);
  }
}

function normalizeDisplay(kind, display, data, baseUrl) {
  if (
    display !== undefined &&
    (!display || typeof display !== "object" || Array.isArray(display))
  ) {
    throw validationFailure("display must be an object.");
  }

  const defaults = KIND_DISPLAY[kind];
  let fallbackPath = defaults.path;
  if (
    kind === "insights" &&
    typeof data.section === "string" &&
    ["weekly", "investments", "subscriptions"].includes(data.section)
  ) {
    fallbackPath =
      data.section === "all"
        ? "/insights"
        : `/insights#${encodeURIComponent(data.section)}`;
  }

  return {
    title: cleanText(
      display?.title ?? defaults.title,
      "display.title",
      120,
    ),
    ...(display?.subtitle
      ? {
          subtitle: cleanText(
            display.subtitle,
            "display.subtitle",
            180,
          ),
        }
      : {}),
    web_url: sameHostWebUrl(
      display?.web_url,
      baseUrl,
      fallbackPath,
    ),
  };
}

function unwrapServiceResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw validationFailure("Finance service result must be an object.");
  }

  if (Object.hasOwn(result, "data")) {
    return result;
  }

  return { data: result };
}

export function createFinanceEnvelope({
  kind,
  serviceResult,
  generatedAt,
  baseUrl = "https://money.example.com",
}) {
  if (!FINANCE_CARD_KINDS.includes(kind)) {
    throw new TypeError(`Unknown finance card kind: ${kind}`);
  }

  const result = unwrapServiceResult(serviceResult);
  if (
    !result.data ||
    typeof result.data !== "object" ||
    Array.isArray(result.data)
  ) {
    throw validationFailure("Finance card data must be an object.");
  }

  const origin = normalizedBaseUrl(baseUrl);
  validateCardData(result.data, origin);

  const generated = isoTimestamp(
    generatedAt ?? new Date(),
    new Date(),
    "generated_at",
  );
  const envelope = canonicalJsonValue({
    schema: FINANCE_CARD_SCHEMA,
    version: FINANCE_CARD_VERSION,
    kind,
    generated_at: generated,
    data_as_of: isoTimestamp(
      result.data_as_of,
      generated,
      "data_as_of",
    ),
    partial: result.partial === true,
    warnings: normalizeWarnings(result.warnings),
    display: normalizeDisplay(
      kind,
      result.display,
      result.data,
      origin,
    ),
    data: result.data,
  });

  const byteLength = canonicalJsonByteLength(envelope);
  if (byteLength > MAX_FINANCE_ENVELOPE_BYTES) {
    throw new FinanceMcpError(
      FINANCE_MCP_ERROR_CODES.RESULT_TOO_LARGE,
      undefined,
      {
        details: {
          reason: `Envelope is ${byteLength} bytes; maximum is ${MAX_FINANCE_ENVELOPE_BYTES}.`,
        },
      },
    );
  }

  return envelope;
}

export function createFinanceErrorEnvelope({
  kind,
  error,
  generatedAt,
  baseUrl,
}) {
  const normalized = normalizeFinanceMcpError(error);
  return createFinanceEnvelope({
    kind,
    generatedAt,
    baseUrl,
    serviceResult: {
      data: financeErrorData(normalized),
      partial: true,
      data_as_of: generatedAt,
      display: {
        title: KIND_DISPLAY[kind]?.title ?? "Finance",
      },
    },
  });
}

function readableText(value, fallback) {
  const text = cleanText(value ?? fallback, "summary", MAX_SUMMARY_LENGTH);
  try {
    JSON.parse(text);
    throw validationFailure("The readable summary must not be JSON.");
  } catch (error) {
    if (error instanceof FinanceMcpError) {
      throw error;
    }
  }
  return text;
}

export function createFinanceToolResult({
  summary,
  fallbackSummary,
  envelope,
  isError = false,
}) {
  const text = readableText(summary, fallbackSummary);
  const json = canonicalStringify(envelope);
  assertCanonicalJsonCopy(json, envelope);

  if (Buffer.byteLength(json, "utf8") > MAX_FINANCE_ENVELOPE_BYTES) {
    throw new FinanceMcpError(FINANCE_MCP_ERROR_CODES.RESULT_TOO_LARGE);
  }

  return {
    content: [
      { type: "text", text },
      { type: "text", text: json },
    ],
    structuredContent: envelope,
    ...(isError ? { isError: true } : {}),
  };
}

export function assertFinanceToolResult(result) {
  if (
    !result ||
    !Array.isArray(result.content) ||
    result.content.length !== 2 ||
    result.content[0]?.type !== "text" ||
    result.content[1]?.type !== "text"
  ) {
    throw new TypeError("Finance tool result must contain exactly two text blocks.");
  }
  if (!result.structuredContent) {
    throw new TypeError("Finance tool result is missing structuredContent.");
  }
  assertCanonicalJsonCopy(result.content[1].text, result.structuredContent);
  if (Buffer.byteLength(result.content[1].text, "utf8") > MAX_FINANCE_ENVELOPE_BYTES) {
    throw new TypeError("Finance tool result exceeds the envelope byte limit.");
  }
  return true;
}
