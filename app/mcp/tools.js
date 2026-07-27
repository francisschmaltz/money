import {
  FINANCE_SERVICE_METHOD_MAP,
  FINANCE_TOOL_KIND_MAP,
  FINANCE_TOOL_NAMES,
} from "./constants.js";
import {
  createFinanceEnvelope,
  createFinanceErrorEnvelope,
  createFinanceToolResult,
} from "./envelope.js";
import { normalizeFinanceMcpError } from "./errors.js";
import {
  FINANCE_TOOL_INPUT_SCHEMAS,
  FINANCE_TOOL_OUTPUT_SCHEMAS,
  parseFinanceToolInput,
} from "./schemas.js";
import { formatMinorMoney } from "../currency.js";

const TOOL_DEFINITIONS = Object.freeze({
  get_finance_overview: {
    title: "Get finance overview",
    description:
      "Get the shared workspace's current net worth, assets, liabilities, cash, spending, and cash-flow headline. Use this for user-specific overall financial status; never invent or estimate missing values.",
  },
  get_finance_insights: {
    title: "Get finance insights",
    description:
      "Get deterministic finance findings for completed week-over-week spending changes, investment performance and allocation, subscriptions, or all three. Use the returned evidence and never turn descriptive investment findings into buy, sell, tax, or suitability advice.",
  },
  list_accounts: {
    title: "List finance accounts",
    description:
      "List bounded shared-workspace bank, credit, loan, and investment accounts with balances and sync freshness. Use for user-specific account facts; never guess balances or institutions.",
  },
  list_transactions: {
    title: "List finance transactions",
    description:
      "Search and filter a cursor-paginated ledger of posted and pending transactions. Use this for recent purchases, merchant searches, category questions, or transaction evidence; narrow broad requests with dates or filters.",
  },
  get_spending_summary: {
    title: "Get spending summary",
    description:
      "Get deterministic spending totals, comparisons, category or merchant segments, and a bounded series. Transfers and card payments are excluded by the finance service unless explicitly classified otherwise.",
  },
  get_cash_flow: {
    title: "Get cash flow",
    description:
      "Get deterministic posted income, spending, net cash flow, and interval buckets for a bounded period. Never treat transfers or investment deposits as income.",
  },
  list_recurring_payments: {
    title: "List recurring payments",
    description:
      "List detected subscriptions and bills with cadence, monthly or annual equivalents, confidence, estimated next dates, and pagination. Estimated dates and possible duplicates must remain labeled as estimates.",
  },
  get_net_worth_history: {
    title: "Get net-worth history",
    description:
      "Get asset, liability, and net-worth snapshot history beginning with the first local snapshot. Never invent history from current balances.",
  },
  get_portfolio_summary: {
    title: "Get portfolio summary",
    description:
      "Get holdings, allocation, value history, contributions, withdrawals, and supported performance evidence. retirement_scope include maps to All, exclude maps to Trading, and only maps to Retirement. Keep cash flows separate from investment performance and do not give buy or sell advice.",
  },
  get_credit_score_summary: {
    title: "Get tracked credit-score summary",
    description:
      "Get manually supplied per-person credit scores, source freshness, an equal-weight household tracking average, and bounded history. This is not a lender or underwriting score. Never present it as an approval prediction or use it to quote an interest rate.",
  },
});

function validateDependencies(financeService) {
  if (!financeService || typeof financeService !== "object") {
    throw new TypeError("financeService is required.");
  }

  for (const method of Object.values(FINANCE_SERVICE_METHOD_MAP)) {
    if (typeof financeService[method] !== "function") {
      throw new TypeError(`financeService.${method} must be a function.`);
    }
  }
}

function countItems(data, keys) {
  for (const key of keys) {
    if (Array.isArray(data?.[key])) {
      return data[key].length;
    }
  }
  return undefined;
}

function displayLabel(value) {
  return String(value).replaceAll("_", " ");
}

function displayMoney(value) {
  if (
    !value ||
    !Number.isSafeInteger(value.amount_minor) ||
    typeof value.currency !== "string"
  ) {
    return undefined;
  }
  try {
    return formatMinorMoney(value);
  } catch {
    return `${value.amount_minor} ${value.currency} minor units`;
  }
}

function firstMetricSnippet(metrics) {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    return undefined;
  }
  for (const [key, value] of Object.entries(metrics)) {
    const money = displayMoney(value);
    if (money) {
      return `${displayLabel(key)} ${money}`;
    }
    if (
      key.endsWith("_basis_points") &&
      Number.isSafeInteger(value)
    ) {
      return `${displayLabel(key.replace(/_basis_points$/, ""))} ${(value / 100).toFixed(1)}%`;
    }
  }
  return undefined;
}

function insightSections(data) {
  if (Array.isArray(data?.sections)) {
    return data.sections;
  }
  return ["weekly", "investments", "subscriptions"]
    .filter((family) => data?.[family])
    .map((family) => ({ family, ...data[family] }));
}

function insightSummaryMetrics(sections) {
  const parts = [];
  for (const section of sections) {
    for (const [key, value] of Object.entries(section?.summary ?? {})) {
      const money = displayMoney(value);
      if (money) {
        parts.push(`${displayLabel(key)} ${money}`);
      }
      if (parts.length === 2) return parts;
    }
  }
  return parts;
}

function insightFallbackSummary(data, dataAsOf) {
  const sections = insightSections(data);
  const findings = sections.flatMap((section) =>
    Array.isArray(section?.findings) ? section.findings : [],
  );
  if (findings.length === 0 && Array.isArray(data?.findings)) {
    findings.push(...data.findings);
  }
  const count = Number.isSafeInteger(data?.finding_count)
    ? data.finding_count
    : findings.length;
  const scope = {
    weekly: "Weekly insights",
    investments: "Investment insights",
    subscriptions: "Subscription insights",
    all: "Finance insights",
  }[data?.section] ?? "Finance insights";
  const totalParts = insightSummaryMetrics(sections);
  const findingParts = findings.slice(0, 3).map((finding) => {
    const metric = firstMetricSnippet(finding?.metrics);
    return `${finding?.title ?? "Untitled finding"}${metric ? ` (${metric})` : ""}`;
  });

  return [
    `${scope}: ${count} finding${count === 1 ? "" : "s"}.`,
    totalParts.length ? `Totals: ${totalParts.join("; ")}.` : undefined,
    findingParts.length ? `Findings: ${findingParts.join("; ")}.` : undefined,
    `Data as of ${dataAsOf}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function fallbackSummary(kind, data, dataAsOf) {
  const freshness = `Data as of ${dataAsOf}.`;
  switch (kind) {
    case "overview":
      return `Finance overview is ready. ${freshness}`;
    case "insights": {
      return insightFallbackSummary(data, dataAsOf);
    }
    case "accounts": {
      const count = countItems(data, ["accounts", "items"]) ?? 0;
      return `${count} account${count === 1 ? "" : "s"} returned. ${freshness}`;
    }
    case "transactions": {
      const count = countItems(data, ["transactions", "items"]) ?? 0;
      return `${count} transaction${count === 1 ? "" : "s"} returned. ${freshness}`;
    }
    case "spending":
      return `Spending summary is ready. ${freshness}`;
    case "cash_flow":
      return `Cash-flow summary is ready. ${freshness}`;
    case "recurring": {
      const count =
        countItems(data, ["recurring_payments", "payments", "items"]) ?? 0;
      return `${count} recurring payment${count === 1 ? "" : "s"} returned. ${freshness}`;
    }
    case "net_worth":
      return `Net-worth history is ready. ${freshness}`;
    case "portfolio": {
      const count = countItems(data, ["holdings"]) ?? 0;
      return `Portfolio summary with ${count} holding${count === 1 ? "" : "s"} is ready. ${freshness}`;
    }
    case "credit_score": {
      const score = data?.household?.average_score;
      return score == null
        ? `No manually tracked credit scores were returned. ${freshness}`
        : `The manually tracked household average is ${score}. It is not a lender or underwriting score. ${freshness}`;
    }
    default:
      return `Finance data is ready. ${freshness}`;
  }
}

function errorSummary(error) {
  return `${error.code}: ${error.message}`;
}

function serviceInput(toolName, input) {
  switch (toolName) {
    case "get_finance_overview":
      return {
        ...(input.as_of ? { asOf: input.as_of } : {}),
      };
    case "get_finance_insights":
      return {
        section: input.section,
        includeNarratives: false,
        ...(input.as_of ? { asOf: input.as_of } : {}),
        limitPerSection: input.limit_per_section,
      };
    case "list_accounts":
      return {
        accountType: input.account_type,
        ...(input.balance_group
          ? { balanceGroup: input.balance_group }
          : {}),
        ...(input.institution_id
          ? { institutionId: input.institution_id }
          : {}),
        includeClosed: input.include_closed,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      };
    case "list_transactions":
      return {
        ...(input.start_date ? { startOn: input.start_date } : {}),
        ...(input.end_date ? { endOn: input.end_date } : {}),
        ...(input.account_id ? { accountId: input.account_id } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.query ? { search: input.query } : {}),
        includePending: input.status !== "posted",
        status: input.status,
        ...(input.min_amount_minor !== undefined
          ? { minAmountMinor: input.min_amount_minor }
          : {}),
        ...(input.max_amount_minor !== undefined
          ? { maxAmountMinor: input.max_amount_minor }
          : {}),
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      };
    case "get_spending_summary":
      return {
        ...(input.start_date ? { startOn: input.start_date } : {}),
        ...(input.end_date ? { endOn: input.end_date } : {}),
        period: input.period,
        groupBy: input.group_by,
        ...(input.account_id ? { accountId: input.account_id } : {}),
        ...(input.category ? { category: input.category } : {}),
        segmentLimit: input.segment_limit,
      };
    case "get_cash_flow":
      return {
        ...(input.start_date ? { startOn: input.start_date } : {}),
        ...(input.end_date ? { endOn: input.end_date } : {}),
        period: input.period,
        interval: input.interval,
        ...(input.account_id ? { accountId: input.account_id } : {}),
      };
    case "list_recurring_payments":
      return {
        kind: input.kind,
        type:
          input.kind === "subscriptions"
            ? "subscription"
            : input.kind === "bills"
              ? "bill"
              : "all",
        cadence: input.cadence,
        status: input.status,
        includeInactive: input.status !== "active",
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      };
    case "get_net_worth_history":
      return {
        ...(input.start_date ? { startOn: input.start_date } : {}),
        ...(input.end_date ? { endOn: input.end_date } : {}),
        interval: input.interval,
        limit: input.limit,
      };
    case "get_portfolio_summary":
      return {
        period: input.period,
        retirementScope: input.retirement_scope,
        ...(input.account_id ? { accountId: input.account_id } : {}),
        holdingsLimit: input.holdings_limit,
      };
    case "get_credit_score_summary":
      return {
        period: input.period,
        audience: "mcp",
      };
    default:
      return input;
  }
}

function stripInsightNarratives(value) {
  if (Array.isArray(value)) {
    return value.map(stripInsightNarratives);
  }
  if (value instanceof Date) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "narrative")
      .map(([key, child]) => [key, stripInsightNarratives(child)]),
  );
}

function scopeInsightData(data, section) {
  const stripped = stripInsightNarratives(data);
  if (
    section === "all" ||
    !stripped ||
    typeof stripped !== "object"
  ) {
    return stripped;
  }

  const scoped = { ...stripped, section };
  for (const family of ["weekly", "investments", "subscriptions"]) {
    if (family !== section) delete scoped[family];
  }
  if (Array.isArray(scoped.sections)) {
    scoped.sections = scoped.sections.filter(
      (candidate) => candidate?.family === section,
    );
  }
  const findings = insightSections(scoped).flatMap((candidate) =>
    Array.isArray(candidate?.findings) ? candidate.findings : [],
  );
  if (Array.isArray(scoped.findings)) {
    scoped.findings = scoped.findings.filter(
      (finding) => !finding?.family || finding.family === section,
    );
    findings.push(...scoped.findings);
  }
  scoped.finding_count = findings.length;
  return scoped;
}

function prepareServiceResult(toolName, serviceResult, input) {
  if (toolName !== "get_finance_insights") {
    return serviceResult;
  }
  return {
    ...serviceResult,
    data: scopeInsightData(serviceResult?.data, input.section),
    summary: undefined,
  };
}

function toolHandler({
  toolName,
  financeService,
  now,
  baseUrl,
}) {
  const kind = FINANCE_TOOL_KIND_MAP[toolName];
  const serviceMethod = FINANCE_SERVICE_METHOD_MAP[toolName];

  return async (input = {}) => {
    let generatedAt;
    try {
      const parsedInput = parseFinanceToolInput(toolName, input);
      generatedAt = now();
      const rawServiceResult = await financeService[serviceMethod](
        serviceInput(toolName, parsedInput),
      );
      const serviceResult = prepareServiceResult(
        toolName,
        rawServiceResult,
        parsedInput,
      );
      const envelope = createFinanceEnvelope({
        kind,
        serviceResult,
        generatedAt,
        baseUrl,
      });
      return createFinanceToolResult({
        summary: serviceResult?.summary,
        fallbackSummary: fallbackSummary(
          kind,
          envelope.data,
          envelope.data_as_of,
        ),
        envelope,
      });
    } catch (error) {
      const normalized = normalizeFinanceMcpError(error);
      const errorGeneratedAt = generatedAt ?? now();
      const envelope = createFinanceErrorEnvelope({
        kind,
        error: normalized,
        generatedAt: errorGeneratedAt,
        baseUrl,
      });
      return createFinanceToolResult({
        summary: errorSummary(normalized),
        fallbackSummary: errorSummary(normalized),
        envelope,
        isError: true,
      });
    }
  };
}

export function registerFinanceTools(
  server,
  {
    financeService,
    now = () => new Date(),
    baseUrl = "https://money.example.com",
  },
) {
  if (!server || typeof server.registerTool !== "function") {
    throw new TypeError("An MCP server with registerTool is required.");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function.");
  }
  validateDependencies(financeService);

  for (const toolName of FINANCE_TOOL_NAMES) {
    server.registerTool(
      toolName,
      {
        ...TOOL_DEFINITIONS[toolName],
        inputSchema: FINANCE_TOOL_INPUT_SCHEMAS[toolName],
        outputSchema: FINANCE_TOOL_OUTPUT_SCHEMAS[toolName],
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      toolHandler({
        toolName,
        financeService,
        now,
        baseUrl,
      }),
    );
  }

  return server;
}

export { TOOL_DEFINITIONS as FINANCE_TOOL_DEFINITIONS };
