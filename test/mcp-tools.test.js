import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  FINANCE_CARD_SCHEMA,
  FINANCE_SERVICE_METHOD_MAP,
  FINANCE_TOOL_KIND_MAP,
  FINANCE_TOOL_NAMES,
  FINANCE_MCP_INSTRUCTIONS,
  FinanceMcpError,
  assertFinanceToolResult,
  canonicalStringify,
  createFinanceMcpServer,
  registerFinanceTools,
} from "../app/mcp/index.js";
import { createFinanceService } from "../app/services/financeService.js";
import { createDemoFinanceService } from "../app/services/demoFinanceService.js";

const NOW = new Date("2026-07-27T01:02:03.000Z");

function fixtureData(toolName, input) {
  switch (toolName) {
    case "get_finance_overview":
      return {
        net_worth: { amount_minor: 45_000_00, currency: "USD" },
        assets: { amount_minor: 50_000_00, currency: "USD" },
        liabilities: { amount_minor: 5_000_00, currency: "USD" },
        net_worth_series: [
          {
            timestamp: "2026-07-20T00:00:00.000Z",
            value: { amount_minor: 44_000_00, currency: "USD" },
          },
        ],
      };
    case "get_finance_insights":
      return {
        section: input.section,
        period: {
          current_start: "2026-07-20",
          current_end: "2026-07-26",
          previous_start: "2026-07-13",
          previous_end: "2026-07-19",
        },
        findings: [
          {
            id: "finding_1",
            type: "spend_less",
            severity: "medium",
            title: "Dining increased",
            explanation: "Dining rose week over week.",
            metrics: {
              current: { amount_minor: 125_00, currency: "USD" },
              previous: { amount_minor: 75_00, currency: "USD" },
              percent_basis_points: 6667,
            },
            rule: "weekly_flexible_spend_increase",
            confidence_basis_points: 9200,
            evidence: [
              {
                entity_type: "transaction",
                entity_id: "transaction_1",
                label: "Three dining transactions",
                web_url:
                  "https://money.example.com/transactions?finding=finding_1",
              },
            ],
            actions: ["view_transactions", "mark_expected", "dismiss"],
          },
        ],
      };
    case "list_accounts":
      return {
        accounts: [
          {
            id: "account_1",
            name: "Checking",
            mask: "1234",
            type: "depository",
            current_balance: { amount_minor: 2_500_00, currency: "USD" },
            freshness: {
              synced_at: "2026-07-26T23:58:00.000Z",
              status: "fresh",
            },
          },
        ],
        page_info: { next_cursor: null, has_more: false },
      };
    case "list_transactions":
      return {
        filters: {
          search: input.search ?? null,
          start_on: input.startOn ?? null,
          end_on: input.endOn ?? null,
          include_pending: input.includePending ?? true,
        },
        transactions: [
          {
            id: "transaction_1",
            date: "2026-07-26",
            merchant: "Coffee Shop",
            category: "Dining",
            amount: { amount_minor: -625, currency: "USD" },
            pending: false,
          },
        ],
        page_info: { next_cursor: null, has_more: false },
      };
    case "get_spending_summary":
      return {
        period: { start_date: "2026-07-01", end_date: "2026-07-26" },
        total: { amount_minor: 1_250_00, currency: "USD" },
        previous_total: { amount_minor: 1_100_00, currency: "USD" },
        trend: {
          amount: { amount_minor: 150_00, currency: "USD" },
          percent_basis_points: 1364,
          direction: "up",
        },
        segments: [],
        series: [],
      };
    case "get_cash_flow":
      return {
        period: { start_date: "2026-07-01", end_date: "2026-07-26" },
        income: { amount_minor: 5_000_00, currency: "USD" },
        spending: { amount_minor: 1_250_00, currency: "USD" },
        net: { amount_minor: 3_750_00, currency: "USD" },
        buckets: [],
      };
    case "list_recurring_payments":
      return {
        monthly_total: { amount_minor: 86_00, currency: "USD" },
        annual_total: { amount_minor: 1_032_00, currency: "USD" },
        recurring_payments: [
          {
            id: "recurring_1",
            service: "Example Cloud",
            cadence: "monthly",
            expected_amount: { amount_minor: 86_00, currency: "USD" },
            next_estimated_date: "2026-08-05",
            confidence_basis_points: 9500,
          },
        ],
        page_info: { next_cursor: null, has_more: false },
      };
    case "get_net_worth_history":
      return {
        current_assets: { amount_minor: 50_000_00, currency: "USD" },
        current_liabilities: { amount_minor: 5_000_00, currency: "USD" },
        current_net_worth: { amount_minor: 45_000_00, currency: "USD" },
        series: [],
      };
    case "get_portfolio_summary":
      return {
        total_value: { amount_minor: 12_000_00, currency: "USD" },
        contributions: { amount_minor: 1_000_00, currency: "USD" },
        withdrawals: { amount_minor: 0, currency: "USD" },
        performance: {
          supported: true,
          amount: { amount_minor: 500_00, currency: "USD" },
          percent_basis_points: 455,
        },
        allocation: [],
        holdings: [],
        value_series: [],
      };
    case "get_credit_score_summary":
      return {
        provenance: "manual",
        disclosure:
          "Scores are manual planning metrics, not lender scores.",
        period: {
          name: input.period,
          label: "Last year",
          start_on: "2025-07-27",
          end_on: "2026-07-28",
        },
        household: {
          average_score: 742,
          change: 8,
          contributor_count: 2,
          member_count: 2,
          active_source_count: 3,
          scored_source_count: 3,
          stale_source_count: 0,
        },
        people: [],
        history: [],
        warnings: [],
        methodology: {
          lender_use:
            "This is not a lender score, approval prediction, or quoted interest rate.",
        },
      };
    default:
      throw new Error(`Missing fixture for ${toolName}`);
  }
}

function makeFinanceService(overrides = {}) {
  const service = {};
  for (const [toolName, method] of Object.entries(
    FINANCE_SERVICE_METHOD_MAP,
  )) {
    service[method] = async (input) => ({
      data: fixtureData(toolName, input),
      data_as_of: "2026-07-26T23:59:00.000Z",
      partial: false,
      warnings: [],
      display: {
        title: `${FINANCE_TOOL_KIND_MAP[toolName]} fixture`,
      },
      summary: `${toolName} returned deterministic finance data.`,
    });
  }
  return Object.assign(service, overrides);
}

function captureRegisteredTools(financeService = makeFinanceService()) {
  const tools = new Map();
  const server = {
    registerTool(name, config, callback) {
      tools.set(name, { config, callback });
    },
  };
  registerFinanceTools(server, {
    financeService,
    now: () => NOW,
    baseUrl: "https://money.example.com",
  });
  return tools;
}

test("registers all ten tools as read-only and dependency-injected", () => {
  const tools = captureRegisteredTools();
  assert.deepEqual([...tools.keys()], FINANCE_TOOL_NAMES);

  for (const { config } of tools.values()) {
    assert.ok(config.title);
    assert.ok(config.description);
    assert.ok(config.inputSchema);
    assert.ok(config.outputSchema);
    assert.deepEqual(config.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
});

test("every tool returns readable text then canonical JSON plus rich structured content", async () => {
  const tools = captureRegisteredTools();

  for (const [toolName, { callback }] of tools) {
    const input =
      toolName === "get_finance_insights"
        ? { section: "weekly" }
        : {};
    const result = await callback(input);

    assert.equal(assertFinanceToolResult(result), true, toolName);
    assert.equal(result.structuredContent.schema, FINANCE_CARD_SCHEMA);
    assert.equal(
      result.structuredContent.kind,
      FINANCE_TOOL_KIND_MAP[toolName],
    );
    assert.equal(result.structuredContent.generated_at, NOW.toISOString());
    assert.equal(result.structuredContent.partial, false, toolName);
    assert.equal(
      result.content[1].text,
      canonicalStringify(result.structuredContent),
    );
    assert.deepEqual(
      JSON.parse(result.content[1].text),
      result.structuredContent,
    );
    assert.doesNotMatch(result.content[0].text, /^\s*[\[{]/);
    assert.equal(result.isError, undefined);
  }
});

test("passes parsed defaults and filters to the matching service method", async () => {
  let received;
  const service = makeFinanceService({
    async listTransactions(input) {
      received = input;
      return {
        data: fixtureData("list_transactions", input),
        data_as_of: NOW,
        summary: "One filtered transaction returned.",
      };
    },
  });
  const tools = captureRegisteredTools(service);

  await tools.get("list_transactions").callback({
    query: "coffee",
    start_date: "2026-07-01",
    end_date: "2026-07-26",
    limit: 20,
  });

  assert.deepEqual(received, {
    search: "coffee",
    startOn: "2026-07-01",
    endOn: "2026-07-26",
    includePending: true,
    status: "all",
    limit: 20,
  });
});

test("credit score MCP reads default to one year and request the PII-safe view", async () => {
  const received = [];
  const service = makeFinanceService({
    async getCreditScoreSummary(input) {
      received.push(input);
      return {
        data: fixtureData("get_credit_score_summary", input),
        data_as_of: NOW,
        summary:
          "The manual tracking average is 742, not a lender score.",
      };
    },
  });
  const tool = captureRegisteredTools(service).get(
    "get_credit_score_summary",
  );

  await tool.callback({});
  await tool.callback({ period: "all" });

  assert.deepEqual(received, [
    { period: "1y", audience: "mcp" },
    { period: "all", audience: "mcp" },
  ]);
});

test("supports weekly, investment, subscription, and combined insight sections", async () => {
  const received = [];
  const service = makeFinanceService({
    async getFinanceInsights(input) {
      received.push(input.section);
      return {
        data: fixtureData("get_finance_insights", input),
        data_as_of: NOW,
        summary: `${input.section} insights returned.`,
      };
    },
  });
  const callback = captureRegisteredTools(service).get(
    "get_finance_insights",
  ).callback;

  for (const section of [
    "weekly",
    "investments",
    "subscriptions",
    "all",
  ]) {
    const result = await callback({ section });
    assert.equal(result.structuredContent.data.section, section);
  }
  assert.deepEqual(received, [
    "weekly",
    "investments",
    "subscriptions",
    "all",
  ]);
});

test("insight MCP output strips LM narratives and uses deterministic prose", async () => {
  let received;
  const service = makeFinanceService({
    async getFinanceInsights(input) {
      received = input;
      return {
        data: {
          section: "weekly",
          finding_count: 0,
          sections: [
            {
              family: "weekly",
              narrative: {
                headline: "You spent $9,999 on invented llamas.",
                bullets: ["This is nondeterministic prose."],
              },
              findings: [],
            },
          ],
        },
        data_as_of: NOW,
        summary: "LM Studio says you spent $9,999 on invented llamas.",
      };
    },
  });
  const result = await captureRegisteredTools(service)
    .get("get_finance_insights")
    .callback({ section: "weekly" });

  assert.equal(received.includeNarratives, false);
  assert.equal(
    Object.hasOwn(
      result.structuredContent.data.sections[0],
      "narrative",
    ),
    false,
  );
  assert.doesNotMatch(JSON.stringify(result), /llamas|9,999|nondeterministic/);
  assert.match(result.content[0].text, /^Weekly insights: 0 findings\./);
  assert.match(result.content[0].text, /2026-07-27T01:02:03\.000Z/);
});

test("weekly insight prose is scoped, factual, and includes freshness", async () => {
  const finding = (family, title, amountMinor) => ({
    id: `finding_${family}`,
    family,
    type: "review",
    severity: "attention",
    title,
    explanation: `${title} needs review.`,
    metrics: {
      current_amount: { amount_minor: amountMinor, currency: "USD" },
    },
    rule: "review_threshold",
    confidence_basis_points: 9000,
    evidence: [],
    actions: ["review"],
  });
  const service = makeFinanceService({
    async getFinanceInsights() {
      return {
        data: {
          section: "weekly",
          finding_count: 2,
          sections: [
            {
              family: "weekly",
              narrative: { headline: "Ignore me", bullets: [] },
              findings: [
                finding("weekly", "Dining increased", 12_500),
              ],
            },
            {
              family: "investments",
              findings: [
                finding(
                  "investments",
                  "Portfolio concentration changed",
                  50_000,
                ),
              ],
            },
          ],
        },
        data_as_of: "2026-07-26T23:59:00.000Z",
        summary: "Untrusted generated summary.",
      };
    },
  });
  const result = await captureRegisteredTools(service)
    .get("get_finance_insights")
    .callback({ section: "weekly" });
  const prose = result.content[0].text;

  assert.match(prose, /^Weekly insights: 1 finding\./);
  assert.match(prose, /Dining increased/);
  assert.match(prose, /current amount \$125\.00/);
  assert.match(prose, /Data as of 2026-07-26T23:59:00\.000Z/);
  assert.doesNotMatch(prose, /Portfolio concentration|Untrusted|Ignore me/);
  assert.deepEqual(
    result.structuredContent.data.sections.map((section) => section.family),
    ["weekly"],
  );
});

test("invalid input becomes a stable dual-format error without calling services", async () => {
  let called = false;
  const service = makeFinanceService({
    async listTransactions() {
      called = true;
      throw new Error("should not run");
    },
  });
  const result = await captureRegisteredTools(service)
    .get("list_transactions")
    .callback({ limit: 101 });

  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.equal(assertFinanceToolResult(result), true);
  assert.equal(
    result.structuredContent.data.error.code,
    "invalid_request",
  );
  assert.equal(result.structuredContent.data.error.retryable, false);
  assert.match(result.content[0].text, /^invalid_request:/);
});

test("service failures use stable public errors and never leak thrown messages", async () => {
  const service = makeFinanceService({
    async getFinanceOverview() {
      throw new Error(
        "postgres://money:password@db/internal access_token secret-value",
      );
    },
  });
  const result = await captureRegisteredTools(service)
    .get("get_finance_overview")
    .callback({});

  assert.equal(result.isError, true);
  assert.equal(
    result.structuredContent.data.error.code,
    "internal_error",
  );
  assert.equal(
    result.structuredContent.data.error.message,
    "The finance tool could not complete the request.",
  );
  assert.doesNotMatch(JSON.stringify(result), /password|secret-value/);
});

test("untrusted error-like objects cannot smuggle messages through known codes", async () => {
  const service = makeFinanceService({
    async getFinanceOverview() {
      throw {
        code: "unavailable",
        message: "access_token secret-value",
        details: { reason: "database password" },
      };
    },
  });
  const result = await captureRegisteredTools(service)
    .get("get_finance_overview")
    .callback({});

  assert.deepEqual(result.structuredContent.data.error, {
    code: "unavailable",
    message: "Finance data is temporarily unavailable.",
    retryable: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /secret-value|database password/);
});

test("known service errors keep their stable code and safe retry details", async () => {
  const service = makeFinanceService({
    async getPortfolioSummary() {
      throw new FinanceMcpError("unavailable", "Portfolio sync is busy.", {
        details: {
          retry_after_seconds: 15,
          unsafe_dump: "not exposed",
        },
      });
    },
  });
  const result = await captureRegisteredTools(service)
    .get("get_portfolio_summary")
    .callback({});

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.data.error, {
    code: "unavailable",
    message: "Portfolio sync is busy.",
    retryable: true,
    details: { retry_after_seconds: 15 },
  });
});

test("oversized service output becomes a bounded result_too_large card", async () => {
  const service = makeFinanceService({
    async listTransactions() {
      return {
        data: {
          transactions: Array.from({ length: 100 }, (_, index) => ({
            id: `transaction_${index}`,
            description: "large".repeat(100),
          })),
        },
        data_as_of: NOW,
      };
    },
  });
  const result = await captureRegisteredTools(service)
    .get("list_transactions")
    .callback({});

  assert.equal(result.isError, true);
  assert.equal(
    result.structuredContent.data.error.code,
    "result_too_large",
  );
  assert.equal(assertFinanceToolResult(result), true);
  assert.ok(Buffer.byteLength(result.content[1].text) < 20_000);
});

test("creates a real SDK server and serves the card contract over an in-memory transport", async (t) => {
  const server = createFinanceMcpServer({
    financeService: makeFinanceService(),
    now: () => NOW,
  });
  const client = new Client({
    name: "money-mcp-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  t.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    FINANCE_TOOL_NAMES,
  );
  for (const tool of listed.tools) {
    assert.equal(
      tool.outputSchema.properties.schema.const,
      FINANCE_CARD_SCHEMA,
      tool.name,
    );
    assert.equal(
      tool.outputSchema.properties.kind.const,
      FINANCE_TOOL_KIND_MAP[tool.name],
      tool.name,
    );
  }

  const result = await client.callTool({
    name: "get_finance_insights",
    arguments: { section: "subscriptions" },
  });
  assert.equal(result.structuredContent.kind, "insights");
  assert.equal(
    result.structuredContent.data.section,
    "subscriptions",
  );
  assert.deepEqual(
    JSON.parse(result.content[1].text),
    result.structuredContent,
  );
});

test("accepts every real FinanceService wrapper and translates MCP filters", async () => {
  let transactionOptions;
  const repository = {
    async listAccounts() {
      return [];
    },
    async getTransactionsForPeriod() {
      return [];
    },
    async getHoldings() {
      return [];
    },
    async listRecurringStreams() {
      return [];
    },
    async getDataFreshness() {
      return {
        data_as_of: "2026-07-26T23:59:00.000Z",
        partial: false,
      };
    },
    async listTransactions(_workspaceId, options) {
      transactionOptions = options;
      return {
        transactions: [
          {
            id: "transaction-canonical",
            provider_transaction_id: "provider-raw",
            posted_on: "2026-07-20",
            authorized_at: null,
            authorized_on: null,
            posted_at: null,
            display_name: "acme one+",
            merchant_name: "ACME #0042",
            name: "ACME ONLINE PURCHASE 0042",
            category_primary: "Shopping",
            category_detailed: null,
            account_id: "account-checking",
            account_name: "Checking",
            account_mask: "1234",
            institution_name: "Test Bank",
            amount_minor: -1_250,
            currency_code: "USD",
            pending: false,
            excluded_from_spending: false,
            is_fixed: false,
          },
        ],
        pageInfo: { next_cursor: null, has_more: false },
      };
    },
    async getAccountSnapshots() {
      return [];
    },
    async getHoldingSnapshots() {
      return [];
    },
    async getInvestmentTransactions() {
      return [];
    },
    async listInsightFindings() {
      return [];
    },
    async getLatestNarrative() {
      return null;
    },
  };
  const service = createFinanceService({
    repository,
    now: () => NOW,
  });
  const tools = captureRegisteredTools(service);
  let transactionResult;

  for (const [toolName, { callback }] of tools) {
    const input =
      toolName === "list_transactions"
        ? {
            query: "coffee",
            start_date: "2026-07-01",
            end_date: "2026-07-27",
            status: "posted",
          }
        : toolName === "get_finance_insights"
          ? { section: "all" }
          : {};
    const result = await callback(input);
    assert.equal(result.isError, undefined, toolName);
    assert.equal(assertFinanceToolResult(result), true, toolName);
    if (toolName === "list_transactions") {
      transactionResult = result;
    }
  }

  assert.deepEqual(transactionOptions, {
    search: "coffee",
    startOn: "2026-07-01",
    endOn: "2026-07-27",
    includePending: false,
    status: "posted",
    limit: 20,
  });
  assert.deepEqual(
    transactionResult.structuredContent.data.transactions.map(
      ({ merchant, display_name, raw_merchant, raw_name }) => ({
        merchant,
        display_name,
        raw_merchant,
        raw_name,
      }),
    ),
    [
      {
        merchant: "acme one+",
        display_name: "acme one+",
        raw_merchant: "ACME #0042",
        raw_name: "ACME ONLINE PURCHASE 0042",
      },
    ],
  );
});

test("the complete demo dataset satisfies every native card contract", async () => {
  const tools = captureRegisteredTools(createDemoFinanceService());

  for (const [toolName, { callback }] of tools) {
    const result = await callback(
      toolName === "get_finance_insights"
        ? { section: "all" }
        : {},
    );
    assert.equal(result.isError, undefined, toolName);
    assert.equal(assertFinanceToolResult(result), true, toolName);
  }

  const subscriptions = await tools
    .get("list_recurring_payments")
    .callback({ kind: "subscriptions" });
  assert.equal(subscriptions.structuredContent.data.kind, "subscriptions");
  assert.ok(
    subscriptions.structuredContent.data.recurring_payments.every(
      (stream) => stream.type === "subscription",
    ),
  );

  const creditScores = await tools
    .get("get_credit_score_summary")
    .callback({ period: "1y" });
  assert.equal(
    creditScores.structuredContent.data.provenance,
    "manual",
  );
  assert.ok(
    creditScores.structuredContent.data.history.length <= 80,
  );
  assert.doesNotMatch(
    JSON.stringify(creditScores.structuredContent.data),
    /Demo User|Household member|@/,
  );
  assert.match(
    FINANCE_MCP_INSTRUCTIONS,
    /never a lender or underwriting score, approval prediction, or basis for quoting an interest rate/i,
  );
});
