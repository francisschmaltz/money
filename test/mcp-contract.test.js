import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FINANCE_CARD_SCHEMA,
  FINANCE_CARD_VERSION,
  FINANCE_CARD_KIND_BY_TOOL,
  FINANCE_MCP_INSTRUCTIONS,
  FINANCE_OPEN_WEBUI_TOOL_ID,
  FINANCE_TOOL_KIND_MAP,
  FINANCE_TOOL_NAMES,
  MAX_FINANCE_ENVELOPE_BYTES,
  PLANNING_READ_TOOL_NAMES,
  PLANNING_WRITE_TOOL_NAMES,
  FinanceMcpError,
  assertCanonicalJsonCopy,
  amountToMinorUnits,
  assertFinanceToolResult,
  canonicalJsonByteLength,
  canonicalJsonEquals,
  canonicalStringify,
  createFinanceEnvelope,
  createFinanceToolResult,
  financeCardValue,
  financeCardKindForTool,
  normalizeFinanceToolName,
  parseFinanceToolInput,
  percentageToBasisPoints,
} from "../app/mcp/index.js";

const NOW = new Date("2026-07-27T01:02:03.000Z");
const README = readFileSync(
  new URL("../README.md", import.meta.url),
  "utf8",
);

test("README MCP table matches the tools exposed by each credential", () => {
  const table = README.match(
    /<!-- mcp-tool-table:start -->([\s\S]*?)<!-- mcp-tool-table:end -->/,
  );
  assert.ok(table, "README must contain the bounded MCP tool table.");

  const documented = [...table[1].matchAll(
    /^\| `([^`]+)` \| [^|]+ \| `([^`]+)` \|/gm,
  )].map((match) => ({
    access: match[1],
    name: match[2],
  }));
  const expected = [
    ...FINANCE_TOOL_NAMES.map((name) => ({ access: "read", name })),
    ...PLANNING_READ_TOOL_NAMES.map((name) => ({
      access: "read",
      name,
    })),
    ...PLANNING_WRITE_TOOL_NAMES.map((name) => ({
      access: "plan:write",
      name,
    })),
  ];

  assert.deepEqual(documented, expected);
  assert.match(
    README,
    new RegExp(
      `${FINANCE_TOOL_NAMES.length + PLANNING_READ_TOOL_NAMES.length} read tools plus ${PLANNING_WRITE_TOOL_NAMES.length} audited planning-write MCP tools`,
    ),
  );
});

test("exports stable bare and Open WebUI-prefixed tool-to-kind mappings", () => {
  assert.equal(
    financeCardKindForTool("get_finance_overview"),
    "overview",
  );
  assert.equal(
    financeCardKindForTool("money_get_finance_overview"),
    "overview",
  );
  assert.equal(
    normalizeFinanceToolName("money_list_transactions"),
    "list_transactions",
  );
  assert.equal(financeCardKindForTool("yb_mcp_list_transactions"), undefined);
  assert.equal(
    FINANCE_CARD_KIND_BY_TOOL.money_get_portfolio_summary,
    "portfolio",
  );
  assert.equal(
    FINANCE_CARD_KIND_BY_TOOL.money_get_transaction_goal_spending,
    "goals",
  );
  assert.equal(
    FINANCE_CARD_KIND_BY_TOOL.money_spend_from_finance_goal,
    "plan_change",
  );
  assert.equal(
    FINANCE_CARD_KIND_BY_TOOL.money_reverse_goal_spend,
    "plan_change",
  );
  assert.equal(
    FINANCE_CARD_KIND_BY_TOOL.money_finish_finance_goal,
    "plan_change",
  );
  assert.equal(
    financeCardKindForTool("archive_finance_goal"),
    undefined,
  );
  assert.equal(FINANCE_OPEN_WEBUI_TOOL_ID, "server:mcp:money");
  assert.deepEqual(Object.keys(FINANCE_TOOL_KIND_MAP), [
    "get_finance_overview",
    "get_finance_insights",
    "list_accounts",
    "list_transactions",
    "get_spending_summary",
    "get_cash_flow",
    "list_recurring_payments",
    "get_net_worth_history",
    "get_portfolio_summary",
    "get_credit_score_summary",
  ]);
});

test("MCP instructions forbid guessed optimistic versions", () => {
  assert.match(
    FINANCE_MCP_INSTRUCTIONS,
    /read the current resource, pass its exact version as expected_version, and never guess or reuse a stale version/i,
  );
  assert.match(
    FINANCE_MCP_INSTRUCTIONS,
    /goal overspending never creates fake spending power/i,
  );
  assert.match(
    FINANCE_MCP_INSTRUCTIONS,
    /active goal attribution reduces category and total budget actuals in the transaction's effective Plan month/i,
  );
  assert.match(
    FINANCE_MCP_INSTRUCTIONS,
    /next active USD monthly bills plus other active USD bills due within 30 days/i,
  );
  assert.match(
    FINANCE_MCP_INSTRUCTIONS,
    /Expected bill dates and amounts are estimates from recurring history/i,
  );
  assert.match(
    FINANCE_MCP_INSTRUCTIONS,
    /Safe to Spend excludes subscriptions/i,
  );
  assert.match(
    README,
    /get_safe_to_spend` \| Current Safe to Spend, calculation factors including the next monthly bills plus other active bills due within 30 days/i,
  );
});

test("goal write schemas preserve purpose and finish outcome", () => {
  assert.deepEqual(
    parseFinanceToolInput("create_finance_goal", {
      name: "Family vacation",
      target_amount: 5_000,
      idempotency_key: "family-vacation-create",
    }),
    {
      name: "Family vacation",
      purpose: "other",
      target_amount_minor: 500_000,
      idempotency_key: "family-vacation-create",
    },
  );
  assert.equal(
    parseFinanceToolInput("update_finance_goal", {
      goal_id: "goal-vacation",
      expected_version: 2,
      purpose: "vacation",
      idempotency_key: "family-vacation-purpose",
    }).purpose,
    "vacation",
  );
  assert.equal(
    parseFinanceToolInput("finish_finance_goal", {
      goal_id: "goal-vacation",
      expected_version: 3,
      idempotency_key: "family-vacation-finish",
    }).outcome,
    "completed",
  );
  assert.throws(
    () =>
      parseFinanceToolInput("finish_finance_goal", {
        goal_id: "goal-vacation",
        expected_version: 3,
        outcome: "sort-of-done",
        idempotency_key: "family-vacation-finish-nope",
      }),
  );
});

test("goal history reads are filtered and hard-bounded", () => {
  assert.deepEqual(parseFinanceToolInput("list_finance_goals", {}), {
    limit: 8,
  });
  assert.deepEqual(
    parseFinanceToolInput("list_finance_goals", {
      status: "archived",
      purpose: "vacation",
      limit: 4,
      cursor: "goal.eyJ2IjoxfQ",
    }),
    {
      status: "archived",
      purpose: "vacation",
      limit: 4,
      cursor: "goal.eyJ2IjoxfQ",
    },
  );
  assert.throws(() =>
    parseFinanceToolInput("list_finance_goals", {
      status: "all",
      limit: 9,
    }),
  );
  assert.throws(() =>
    parseFinanceToolInput("list_finance_goals", {
      include_archived: true,
    }),
  );
});

test("canonical JSON sorts keys recursively and compares by JSON value", () => {
  const left = {
    zebra: [{ last: 2, first: 1 }],
    alpha: { beta: true, alpha: null },
  };
  const right = {
    alpha: { alpha: null, beta: true },
    zebra: [{ first: 1, last: 2 }],
  };

  assert.equal(
    canonicalStringify(left),
    '{"alpha":{"alpha":null,"beta":true},"zebra":[{"first":1,"last":2}]}',
  );
  assert.equal(canonicalJsonEquals(left, right), true);
  assert.equal(assertCanonicalJsonCopy(canonicalStringify(left), right), true);
  assert.throws(
    () => assertCanonicalJsonCopy(JSON.stringify(left), left),
    /not canonical or identical/,
  );
  assert.throws(() => canonicalStringify({ nope: undefined }), /Non-JSON/);
});

test("builds a versioned, same-host, snake-case finance envelope", () => {
  const envelope = createFinanceEnvelope({
    kind: "spending",
    generatedAt: NOW,
    baseUrl: "https://money.example.com",
    serviceResult: {
      data_as_of: "2026-07-26T23:59:00Z",
      partial: true,
      warnings: [
        "One institution is stale.",
        { code: "partial_sync", message: "Investments are still syncing." },
      ],
      display: {
        title: "Spending",
        subtitle: "July 2026",
        web_url: "https://money.example.com/transactions?period=month",
      },
      data: {
        total: { amount: 123.45, currency: "USD" },
        trend: {
          amount: { amount: -25, currency: "USD" },
          percentage: 16.89,
          direction: "down",
        },
        segments: [
          {
            category: "Dining",
            share_percentage: 25,
            total: { amount: 30.86, currency: "USD" },
          },
        ],
      },
    },
  });

  assert.equal(envelope.schema, FINANCE_CARD_SCHEMA);
  assert.equal(envelope.version, FINANCE_CARD_VERSION);
  assert.equal(envelope.kind, "spending");
  assert.equal(envelope.generated_at, NOW.toISOString());
  assert.equal(envelope.data_as_of, "2026-07-26T23:59:00.000Z");
  assert.equal(envelope.partial, true);
  assert.equal(envelope.warnings.length, 2);
  assert.equal(
    envelope.display.web_url,
    "https://money.example.com/transactions?period=month",
  );
  assert.ok(canonicalJsonByteLength(envelope) < MAX_FINANCE_ENVELOPE_BYTES);
});

test("rejects card fields that can break or poison native cards", () => {
  const base = {
    kind: "accounts",
    generatedAt: NOW,
    baseUrl: "https://money.example.com",
  };

  assert.throws(
    () =>
      createFinanceEnvelope({
        ...base,
        serviceResult: { data: { accountRows: [] } },
      }),
    FinanceMcpError,
  );
  assert.throws(
    () =>
      createFinanceEnvelope({
        kind: "credit_score",
        generatedAt: NOW,
        serviceResult: {
          data: {
            household: { average_score: 851 },
          },
        },
      }),
    FinanceMcpError,
  );
  assert.throws(
    () =>
      createFinanceEnvelope({
        ...base,
        serviceResult: {
          data: {
            accounts: [
              {
                id: "acct_1",
                provider_access_token: "do-not-ship-this",
              },
            ],
          },
        },
      }),
    FinanceMcpError,
  );
  assert.throws(
    () =>
      createFinanceEnvelope({
        ...base,
        serviceResult: {
          data: {
            evidence: [
              {
                web_url: "https://evil.example/transaction/1",
              },
            ],
          },
        },
      }),
    FinanceMcpError,
  );
  assert.throws(
    () =>
      createFinanceEnvelope({
        ...base,
        serviceResult: {
          data: {
            total: { amount: 12.345, currency: "USD" },
          },
        },
      }),
    FinanceMcpError,
  );
});

test("permits fractional quantities, decimal money, and percentages", () => {
  const envelope = createFinanceEnvelope({
    kind: "portfolio",
    generatedAt: NOW,
    serviceResult: {
      data: {
        holdings: [
          {
            symbol: "VOO",
            quantity: 2.125,
            value: { amount: 1_200, currency: "USD" },
            allocation_percentage: 42,
          },
        ],
      },
    },
  });
  assert.equal(envelope.data.holdings[0].quantity, 2.125);
});

test("converts internal minor units and basis points at the MCP v2 boundary", () => {
  assert.equal(amountToMinorUnits(0, "USD"), 0);
  assert.equal(amountToMinorUnits(-5.21, "USD"), -521);
  assert.equal(amountToMinorUnits(10_000, "USD"), 1_000_000);
  assert.equal(amountToMinorUnits(521, "JPY"), 521);
  assert.equal(amountToMinorUnits(5.213, "BHD"), 5_213);
  assert.equal(percentageToBasisPoints(-2.5), -250);
  assert.equal(percentageToBasisPoints(0), 0);
  assert.equal(percentageToBasisPoints(110.25), 11_025);

  const converted = financeCardValue({
    zero: { amount_minor: 0, currency: "USD" },
    refund: { amount_minor: -521, currency: "USD" },
    safe_to_spend: { amount_minor: 1_000_000, currency: "USD" },
    yen: { amount_minor: 521, currency: "JPY" },
    dinar: { amount_minor: 5_213, currency: "BHD" },
    progress_basis_points: 4_255,
    variance_basis_points: -250,
    estimated_return_basis_points: null,
  });

  assert.deepEqual(converted, {
    zero: { amount: 0, currency: "USD" },
    refund: { amount: -5.21, currency: "USD" },
    safe_to_spend: { amount: 10_000, currency: "USD" },
    yen: { amount: 521, currency: "JPY" },
    dinar: { amount: 5.213, currency: "BHD" },
    progress_percentage: 42.55,
    variance_percentage: -2.5,
    estimated_return_percentage: null,
  });
  assert.doesNotMatch(
    JSON.stringify(converted),
    /"(?:[^"]*_minor|[^"]*_basis_points)"/,
  );
});

test("strictly validates Money, bounded percentages, dates, IDs, and findings", () => {
  const build = (data) =>
    createFinanceEnvelope({
      kind: "insights",
      generatedAt: NOW,
      serviceResult: { data },
    });

  assert.throws(
    () => build({ total: { amount: 1, currency: "usd" } }),
    FinanceMcpError,
  );
  assert.throws(
    () => build({ total: { amount: "5.21", currency: "USD" } }),
    FinanceMcpError,
  );
  assert.throws(
    () => build({ confidence_percentage: 100.01 }),
    FinanceMcpError,
  );
  assert.throws(
    () =>
      createFinanceEnvelope({
        kind: "credit_score",
        generatedAt: NOW,
        serviceResult: {
          data: {
            people: [
              {
                person_label: "Person 1",
                sources: [
                  {
                    label: "Experian",
                    observed_on: "2026-02-31",
                  },
                ],
              },
            ],
          },
        },
      }),
    FinanceMcpError,
  );
  assert.doesNotThrow(() =>
    build({
      currency: "USD",
      trend: { percentage: -250 },
      estimated_return_percentage: null,
    }),
  );
  assert.doesNotThrow(() =>
    createFinanceEnvelope({
      kind: "recurring",
      generatedAt: NOW,
      serviceResult: {
        data: {
          streams: [
            {
              id: "stream_1",
              cadence: "biweekly",
              expected_amount: {
                amount: 25,
                currency: "USD",
              },
            },
          ],
        },
      },
    }),
  );
  assert.doesNotThrow(() =>
    build({
      findings: [
        {
          id: "finding_rule_object",
          type: "spend_less",
          severity: "attention",
          title: "Dining increased",
          explanation: "Dining crossed the configured threshold.",
          period_start: "2026-07-20",
          period_end: "2026-07-27",
          metrics: {
            change: { amount: 35, currency: "USD" },
          },
          rule: {
            threshold_percentage: 15,
            minimum_change: { amount: 25, currency: "USD" },
          },
          confidence_percentage: 92,
          evidence: [
            {
              entity_type: "transaction",
              entity_id: "transaction_1",
              label: "Dining transactions",
              web_url:
                "https://money.example.com/transactions?finding=finding_rule_object",
            },
          ],
          actions: [
            {
              type: "view_transactions",
              label: "Review transactions",
            },
            "dismiss",
          ],
          generated_at: "2026-07-27T01:00:00.000Z",
          data_as_of: "2026-07-26T23:59:00.000Z",
        },
      ],
    }),
  );
  assert.throws(
    () =>
      createFinanceEnvelope({
        kind: "recurring",
        generatedAt: NOW,
        serviceResult: {
          data: {
            streams: [{ id: "stream_1", cadence: "fortnightly" }],
          },
        },
      }),
    FinanceMcpError,
  );
  assert.throws(
    () => build({ next_estimated_date: "2026-02-30" }),
    FinanceMcpError,
  );
  assert.throws(
    () => build({ transaction_id: "../../etc/passwd" }),
    FinanceMcpError,
  );
  assert.throws(
    () =>
      build({
        findings: Array.from({ length: 26 }, (_, index) => ({
          id: `finding_${index}`,
        })),
      }),
    FinanceMcpError,
  );
  assert.throws(
    () =>
      build({
        findings: [
          {
            id: "finding_1",
            type: "spend_less",
            severity: "medium",
            title: "Missing evidence and actions",
            explanation: "This intentionally incomplete fixture must fail.",
            metrics: {},
            rule: "weekly_change",
            confidence_percentage: 90,
          },
        ],
      }),
    FinanceMcpError,
  );
});

test("allows nullable optional dates and date-only series timestamps", () => {
  const envelope = createFinanceEnvelope({
    kind: "transactions",
    generatedAt: NOW,
    serviceResult: {
      data: {
        transactions: [
          {
            id: "transaction_1",
            account_id: null,
            date: "2026-07-26",
            authorized_at: null,
            amount: { amount: -5, currency: "USD" },
            split_version: 3,
          },
        ],
        series: [
          {
            timestamp: "2026-07-26",
            value: { amount: 5, currency: "USD" },
          },
        ],
      },
    },
  });
  assert.equal(envelope.data.transactions[0].authorized_at, null);
  assert.equal(envelope.data.transactions[0].split_version, 3);
});

test("plan-change envelopes preserve returned optimistic versions", () => {
  const envelope = createFinanceEnvelope({
    kind: "plan_change",
    generatedAt: NOW,
    serviceResult: {
      data: {
        changed: {
          after: { version: 4, split_version: 7 },
          split_version: 7,
        },
      },
    },
  });

  assert.equal(envelope.data.changed.after.version, 4);
  assert.equal(envelope.data.changed.after.split_version, 7);
  assert.equal(envelope.data.changed.split_version, 7);
});

test("creates exactly two text blocks with an identical canonical compatibility copy", () => {
  const envelope = createFinanceEnvelope({
    kind: "overview",
    generatedAt: NOW,
    serviceResult: {
      data: {
        net_worth: { amount: 1_234.56, currency: "USD" },
      },
    },
  });
  const result = createFinanceToolResult({
    summary: "Net worth is $1,234.56. Data is current through July 26.",
    envelope,
  });

  assert.equal(assertFinanceToolResult(result), true);
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, "text");
  assert.doesNotMatch(result.content[0].text, /^\s*[\[{]/);
  assert.equal(result.content[1].text, canonicalStringify(envelope));
  assert.deepEqual(JSON.parse(result.content[1].text), result.structuredContent);
});

test("input schemas apply defaults, bounds, strict keys, and range ordering", () => {
  assert.deepEqual(parseFinanceToolInput("get_finance_insights", {}), {
    section: "all",
    limit_per_section: 10,
  });
  assert.deepEqual(parseFinanceToolInput("list_transactions", {}), {
    status: "all",
    limit: 20,
  });
  assert.equal(
    parseFinanceToolInput("list_recurring_payments", {
      cadence: "biweekly",
    }).cadence,
    "biweekly",
  );
  assert.deepEqual(
    parseFinanceToolInput("get_credit_score_summary", {}),
    { period: "1y" },
  );
  assert.throws(
    () =>
      parseFinanceToolInput("get_credit_score_summary", {
        period: "3m",
      }),
    /Invalid option/i,
  );
  assert.throws(
    () =>
      parseFinanceToolInput("list_transactions", {
        start_date: "2026-07-27",
        end_date: "2026-07-20",
      }),
    /start_date/,
  );
  assert.throws(
    () => parseFinanceToolInput("list_transactions", { limit: 26 }),
    /Too big|less than or equal to 100/i,
  );
  assert.throws(
    () => parseFinanceToolInput("get_finance_insights", { section: "taxes" }),
    /Invalid option/i,
  );
  assert.throws(
    () => parseFinanceToolInput("list_accounts", { surprise: true }),
    /Unrecognized key/i,
  );
  assert.deepEqual(
    parseFinanceToolInput("set_category_budget", {
      category: "Dining",
      amount: 400,
      expected_version: 0,
      idempotency_key: "budget-dining-v1",
    }),
    {
      category: "Dining",
      amount_minor: 40_000,
      expected_version: 0,
      idempotency_key: "budget-dining-v1",
    },
  );
  assert.deepEqual(
    parseFinanceToolInput("split_transaction", {
      transaction_id: "transaction-1",
      currency: "USD",
      expected_version: 2,
      lines: [],
      idempotency_key: "split-clear-v2",
    }),
    {
      transaction_id: "transaction-1",
      currency: "USD",
      expected_version: 2,
      lines: [],
      idempotency_key: "split-clear-v2",
    },
  );
  assert.deepEqual(
    parseFinanceToolInput("get_transaction_goal_spending", {
      transaction_id: "transaction-1",
    }),
    {
      transaction_id: "transaction-1",
    },
  );
  assert.deepEqual(
    parseFinanceToolInput("spend_from_finance_goal", {
      transaction_id: "transaction-1",
      goal_id: "goal-house",
      source: "cash",
      amount: 250,
      expected_goal_version: 4,
      expected_transaction_version: 2,
      idempotency_key: "goal-spend-transaction-1-v2",
    }),
    {
      transaction_id: "transaction-1",
      goal_id: "goal-house",
      source: "cash",
      amount_minor: 25_000,
      expected_goal_version: 4,
      expected_transaction_version: 2,
      idempotency_key: "goal-spend-transaction-1-v2",
    },
  );
  assert.deepEqual(
    parseFinanceToolInput("reverse_goal_spend", {
      transaction_id: "transaction-1",
      goal_spend_id: "goal-spend-1",
      expected_goal_version: 5,
      expected_transaction_version: 3,
      idempotency_key: "goal-spend-reverse-transaction-1-v3",
    }),
    {
      transaction_id: "transaction-1",
      goal_spend_id: "goal-spend-1",
      expected_goal_version: 5,
      expected_transaction_version: 3,
      idempotency_key: "goal-spend-reverse-transaction-1-v3",
    },
  );
  assert.throws(
    () =>
      parseFinanceToolInput("set_category_budget", {
        category: "Dining",
        amount: 400,
        idempotency_key: "budget-dining-v1",
      }),
    /expected_version/i,
  );
  for (const legacyField of [
    ["scope", "standing"],
    ["month_on", "2026-07-01"],
    ["effective_month_on", "2026-08-01"],
  ]) {
    assert.throws(
      () =>
        parseFinanceToolInput("set_category_budget", {
          category: "Dining",
          amount: 400,
          expected_version: 0,
          idempotency_key: "budget-dining-v1",
          [legacyField[0]]: legacyField[1],
        }),
      /Unrecognized key/i,
    );
  }
  assert.throws(
    () =>
      parseFinanceToolInput("split_transaction", {
        transaction_id: "transaction-1",
        currency: "USD",
        expected_version: -1,
        lines: [],
        idempotency_key: "split-clear-v2",
      }),
    /greater than or equal to 0|too small/i,
  );
  assert.throws(
    () =>
      parseFinanceToolInput("spend_from_finance_goal", {
        transaction_id: "transaction-1",
        goal_id: "goal-house",
        source: "cash",
        amount: 250,
        expected_goal_version: 4,
        idempotency_key: "goal-spend-transaction-1-v2",
      }),
    /expected_transaction_version/i,
  );
  assert.throws(
    () =>
      parseFinanceToolInput("reverse_goal_spend", {
        transaction_id: "transaction-1",
        goal_spend_id: "goal-spend-1",
        expected_goal_version: 5,
        expected_transaction_version: -1,
        idempotency_key: "goal-spend-reverse-transaction-1-v3",
      }),
    /greater than or equal to 0|too small/i,
  );
  assert.throws(
    () =>
      parseFinanceToolInput("set_goal_funding_schedule", {
        goal_id: "goal-house",
        expected_version: 1,
        source: "cash",
        cadence: "biweekly_friday",
        amount: 100,
        anchor_on: "2026-07-30",
        idempotency_key: "schedule-house-2026-07-27",
      }),
    /Friday/i,
  );
});

test("v2 inputs reject legacy units, excess precision, missing currency, and unsafe values", () => {
  assert.throws(
    () => parseFinanceToolInput("get_finance_overview", { as_of: "2026-07-01" }),
    /Unrecognized key/i,
  );
  assert.throws(
    () =>
      parseFinanceToolInput("create_finance_goal", {
        name: "Legacy",
        target_amount_minor: 521,
        idempotency_key: "legacy-goal-units",
      }),
    /Unrecognized key/i,
  );
  assert.throws(
    () =>
      parseFinanceToolInput("create_finance_goal", {
        name: "Too precise",
        target_amount: 5.211,
        idempotency_key: "precise-goal-units",
      }),
    /two decimal places/i,
  );
  assert.throws(
    () =>
      parseFinanceToolInput("list_transactions", {
        min_amount: 5.21,
      }),
    /currency is required/i,
  );
  assert.throws(
    () =>
      parseFinanceToolInput("list_transactions", {
        min_amount: 5.5,
        currency: "JPY",
      }),
    /too many decimal places/i,
  );
  assert.throws(
    () =>
      parseFinanceToolInput("model_finance_plan", {
        brokerage_change_percentage: 1.001,
      }),
    /two decimal places/i,
  );
  assert.throws(
    () =>
      parseFinanceToolInput("set_category_budget", {
        category: "Dining",
        amount: Number.MAX_SAFE_INTEGER,
        expected_version: 0,
        idempotency_key: "unsafe-budget-value",
      }),
    /less than or equal to|too big/i,
  );
  assert.deepEqual(
    parseFinanceToolInput("list_transactions", {
      min_amount: -5.21,
      max_amount: 10,
      currency: "USD",
    }),
    {
      min_amount_minor: -521,
      max_amount_minor: 1_000,
      currency: "USD",
      status: "all",
      limit: 20,
    },
  );
});

test("refuses an envelope over 20KB instead of truncating financial facts", () => {
  assert.throws(
    () =>
      createFinanceEnvelope({
        kind: "transactions",
        generatedAt: NOW,
        serviceResult: {
          data: {
            transactions: Array.from({ length: 100 }, (_, index) => ({
              id: `transaction_${index}`,
              description: "x".repeat(300),
              amount: { amount: -1, currency: "USD" },
            })),
          },
        },
      }),
    (error) =>
      error instanceof FinanceMcpError &&
      error.code === "result_too_large",
  );
});
