export const FINANCE_CARD_SCHEMA = "com.yaboiii.finance-card";
export const FINANCE_CARD_VERSION = 1;
export const MAX_FINANCE_ENVELOPE_BYTES = 20_000;
export const FINANCE_MCP_CONNECTION_ID = "money";
export const FINANCE_OPEN_WEBUI_TOOL_ID = "server:mcp:money";

export const FINANCE_TOOL_KIND_MAP = Object.freeze({
  get_finance_overview: "overview",
  get_finance_insights: "insights",
  list_accounts: "accounts",
  list_transactions: "transactions",
  get_spending_summary: "spending",
  get_cash_flow: "cash_flow",
  list_recurring_payments: "recurring",
  get_net_worth_history: "net_worth",
  get_portfolio_summary: "portfolio",
  get_credit_score_summary: "credit_score",
});

export const FINANCE_SERVICE_METHOD_MAP = Object.freeze({
  get_finance_overview: "getFinanceOverview",
  get_finance_insights: "getFinanceInsights",
  list_accounts: "listAccounts",
  list_transactions: "listTransactions",
  get_spending_summary: "getSpendingSummary",
  get_cash_flow: "getCashFlow",
  list_recurring_payments: "listRecurringPayments",
  get_net_worth_history: "getNetWorthHistory",
  get_portfolio_summary: "getPortfolioSummary",
  get_credit_score_summary: "getCreditScoreSummary",
});

export const FINANCE_TOOL_NAMES = Object.freeze(
  Object.keys(FINANCE_TOOL_KIND_MAP),
);

export const FINANCE_CARD_KINDS = Object.freeze(
  [...new Set(Object.values(FINANCE_TOOL_KIND_MAP))],
);

export const FINANCE_KIND_TOOL_MAP = Object.freeze(
  Object.fromEntries(
    Object.entries(FINANCE_TOOL_KIND_MAP).map(([toolName, kind]) => [
      kind,
      toolName,
    ]),
  ),
);

export const FINANCE_CARD_KIND_BY_TOOL = Object.freeze(
  Object.fromEntries(
    Object.entries(FINANCE_TOOL_KIND_MAP).flatMap(([toolName, kind]) => [
      [toolName, kind],
      [`${FINANCE_MCP_CONNECTION_ID}_${toolName}`, kind],
    ]),
  ),
);

export function normalizeFinanceToolName(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  if (Object.hasOwn(FINANCE_TOOL_KIND_MAP, value)) return value;

  const connectionPrefix = `${FINANCE_MCP_CONNECTION_ID}_`;
  const withoutConnectionPrefix = value.startsWith(connectionPrefix)
    ? value.slice(connectionPrefix.length)
    : value;

  return Object.hasOwn(FINANCE_TOOL_KIND_MAP, withoutConnectionPrefix)
    ? withoutConnectionPrefix
    : undefined;
}

export function financeCardKindForTool(value) {
  const toolName = normalizeFinanceToolName(value);
  return toolName ? FINANCE_TOOL_KIND_MAP[toolName] : undefined;
}
