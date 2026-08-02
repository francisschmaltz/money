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
import { financeCardValue } from "./units.js";

const TOOL_DEFINITIONS = Object.freeze({
  get_finance_overview: {
    title: "Get finance overview",
    description:
      "Get the shared workspace's current Safe to Spend first, then cash, short-term worth, retirement, net worth, compact goal status, and supporting finance details. This tool is current-only; use get_net_worth_history for historical wealth.",
  },
  get_finance_insights: {
    title: "Get finance insights",
    description:
      "Get deterministic finance findings for completed week-over-week spending changes, investment performance and allocation, subscriptions, or all three. Use the returned evidence and never turn descriptive investment findings into buy, sell, tax, or suitability advice.",
  },
  list_accounts: {
    title: "List finance accounts",
    description:
      "List bounded shared-workspace bank, credit, loan, and investment accounts with their balances and sync freshness. Use get_finance_overview for household totals.",
  },
  list_transactions: {
    title: "List finance transactions",
    description:
      "Search and filter a cursor-paginated ledger of posted and pending transactions. Each result exposes cash_flow_role: spending appears in Spending reports, obligation appears in Plan Obligations, and transfer appears in neither. excluded_from_spending is a deprecated compatibility read. Narrow broad requests with dates or filters.",
  },
  get_spending_summary: {
    title: "Get spending summary",
    description:
      "Get deterministic totals, comparisons, category or merchant segments, and a bounded series for transactions whose effective cash_flow_role is spending. Obligations belong in Plan Obligations; transfers and card payments are excluded.",
  },
  get_cash_flow: {
    title: "Get cash flow",
    description:
      "Get deterministic posted income, outflows, net cash flow, interval buckets, and an outflow_by_role reconciliation. Spending and Obligations count as outflows; Transfers remain classified but do not reduce net cash flow. Never treat transfers or investment deposits as income.",
  },
  list_recurring_payments: {
    title: "List recurring payments",
    description:
      "List detected subscriptions and bills with cadence, monthly or annual equivalents, confidence, estimated next dates, cash-flow roles, and pagination. Bills may be Spending or Obligations; Transfers cannot be recurring. Estimated dates and possible duplicates must remain labeled as estimates.",
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
    typeof value.amount !== "number" ||
    !Number.isFinite(value.amount) ||
    typeof value.currency !== "string"
  ) {
    return undefined;
  }
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: value.currency,
    }).format(value.amount);
  } catch {
    return `${value.amount} ${value.currency}`;
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
      key.endsWith("_percentage") &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      return `${displayLabel(key.replace(/_percentage$/, ""))} ${value}%`;
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
      return {};
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
        ...(input.currency
          ? { currencyCode: input.currency }
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

function compactGoal(goal) {
  const warningFlags = [];
  if (goal?.brokerage_under_backed) {
    warningFlags.push("brokerage_under_backed");
  }
  if ((goal?.over_by?.amount_minor ?? 0) > 0) {
    warningFlags.push("over_target");
  }
  if ((goal?.unfunded_spend?.amount_minor ?? 0) > 0) {
    warningFlags.push("unfunded_spend");
  }
  return {
    id: goal.id,
    name: goal.name,
    purpose: goal.purpose,
    status: goal.status,
    target_on: goal.target_on ?? null,
    progress_basis_points: goal.progress_basis_points ?? 0,
    version: Number(goal.version),
    warning_flags: warningFlags,
  };
}

function overviewDetails(data) {
  const excluded = new Set([
    "cash",
    "cash_balance",
    "short_term_worth",
    "retirement_assets",
    "retirement_investments",
    "net_worth",
    "assets",
    "liabilities",
  ]);
  return Object.fromEntries(
    Object.entries(data ?? {}).filter(([key]) => !excluded.has(key)),
  );
}

function earlierTimestamp(left, right) {
  if (!left) return right;
  if (!right) return left;
  return new Date(left) <= new Date(right) ? left : right;
}

function overviewServiceResult(financeResult, planningResult) {
  const financeData = financeResult?.data ?? {};
  const planningData = planningResult?.data ?? null;
  const safeToSpend = planningData?.safe_to_spend ?? null;
  const goals = planningData?.goals ?? [];
  const planningMissing = planningResult == null;
  const warnings = [
    ...(financeResult?.warnings ?? []),
    ...(planningResult?.warnings ?? []),
    ...(planningMissing
      ? ["Safe to Spend and goal status are temporarily unavailable."]
      : []),
  ];
  const dataAsOf = earlierTimestamp(
    financeResult?.data_as_of,
    planningResult?.data_as_of,
  );
  const summaryBody = safeToSpend
    ? `Safe to Spend is ${formatMinorMoney(safeToSpend)}. Cash is ${formatMinorMoney(financeData.cash_balance ?? financeData.cash)}, short-term worth is ${formatMinorMoney(financeData.short_term_worth)}, retirement is ${formatMinorMoney(financeData.retirement_assets ?? financeData.retirement_investments)}, and net worth is ${formatMinorMoney(financeData.net_worth)}. ${goals.length} active goal${goals.length === 1 ? "" : "s"} returned.`
    : "Safe to Spend is unavailable. Current wealth details were returned.";
  const summary = `${summaryBody} Data as of ${dataAsOf}.`;
  return {
    ...financeResult,
    data: {
      safe_to_spend: safeToSpend,
      wealth: {
        cash: financeData.cash_balance ?? financeData.cash ?? null,
        short_term: financeData.short_term_worth ?? null,
        retirement:
          financeData.retirement_assets ??
          financeData.retirement_investments ??
          null,
        net_worth: financeData.net_worth ?? null,
      },
      goals: {
        active_count:
          planningData?.active_goal_count ?? goals.length,
        returned_count: Math.min(goals.length, 8),
        has_more: goals.length > 8,
        items: goals.slice(0, 8).map(compactGoal),
      },
      details: overviewDetails(financeData),
    },
    data_as_of: dataAsOf,
    partial:
      financeResult?.partial === true ||
      planningResult?.partial === true ||
      planningMissing,
    warnings,
    summary,
  };
}

function accountListServiceResult(serviceResult) {
  const data = serviceResult?.data ?? {};
  return {
    ...serviceResult,
    data: {
      ...(Array.isArray(data.groups) ? { groups: data.groups } : {}),
      ...(Array.isArray(data.accounts) ? { accounts: data.accounts } : {}),
      account_count:
        data.account_count ??
        data.accounts?.length ??
        data.groups?.reduce(
          (count, group) => count + (group.accounts?.length ?? 0),
          0,
        ) ??
        0,
      page_info: data.page_info ?? {
        has_more: false,
        next_cursor: null,
      },
    },
    summary: undefined,
  };
}

function prepareServiceResult(
  toolName,
  serviceResult,
  input,
  planningResult,
) {
  if (toolName === "get_finance_overview") {
    return overviewServiceResult(serviceResult, planningResult);
  }
  if (toolName === "list_accounts") {
    return accountListServiceResult(serviceResult);
  }
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
  planningService,
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
      const financePromise = financeService[serviceMethod](
        serviceInput(toolName, parsedInput),
      );
      let rawServiceResult;
      let planningResult = null;
      if (toolName === "get_finance_overview") {
        const [financeRead, planningRead] = await Promise.allSettled([
          financePromise,
          planningService?.getSafeToSpend?.() ??
            Promise.reject(new Error("Planning service unavailable.")),
        ]);
        if (financeRead.status === "rejected") {
          throw financeRead.reason;
        }
        rawServiceResult = financeRead.value;
        planningResult =
          planningRead.status === "fulfilled"
            ? planningRead.value
            : null;
      } else {
        rawServiceResult = await financePromise;
      }
      const serviceResult = prepareServiceResult(
        toolName,
        rawServiceResult,
        parsedInput,
        planningResult,
      );
      const cardServiceResult = {
        ...serviceResult,
        data: financeCardValue(serviceResult?.data ?? {}),
      };
      const envelope = createFinanceEnvelope({
        kind,
        serviceResult: cardServiceResult,
        generatedAt,
        baseUrl,
      });
      return createFinanceToolResult({
        summary: cardServiceResult?.summary,
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
    planningService = null,
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
        planningService,
        now,
        baseUrl,
      }),
    );
  }

  return server;
}

export { TOOL_DEFINITIONS as FINANCE_TOOL_DEFINITIONS };
