import assert from "node:assert/strict";
import test from "node:test";

import {
  FINANCE_CARD_SCHEMA,
  FINANCE_CARD_VERSION,
  FINANCE_CARD_KIND_BY_TOOL,
  FINANCE_OPEN_WEBUI_TOOL_ID,
  FINANCE_TOOL_KIND_MAP,
  MAX_FINANCE_ENVELOPE_BYTES,
  FinanceMcpError,
  assertCanonicalJsonCopy,
  assertFinanceToolResult,
  canonicalJsonByteLength,
  canonicalJsonEquals,
  canonicalStringify,
  createFinanceEnvelope,
  createFinanceToolResult,
  financeCardKindForTool,
  normalizeFinanceToolName,
  parseFinanceToolInput,
} from "../app/mcp/index.js";

const NOW = new Date("2026-07-27T01:02:03.000Z");

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
        total: { amount_minor: 123_45, currency: "USD" },
        trend: {
          amount: { amount_minor: -25_00, currency: "USD" },
          percent_basis_points: 1689,
          direction: "down",
        },
        segments: [
          {
            category: "Dining",
            share_basis_points: 2500,
            total: { amount_minor: 30_86, currency: "USD" },
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
            total: { amount_minor: 12.34, currency: "USD" },
          },
        },
      }),
    FinanceMcpError,
  );
});

test("permits fractional holding quantities but requires integer money and basis points", () => {
  const envelope = createFinanceEnvelope({
    kind: "portfolio",
    generatedAt: NOW,
    serviceResult: {
      data: {
        holdings: [
          {
            symbol: "VOO",
            quantity: 2.125,
            value: { amount_minor: 120_000, currency: "USD" },
            allocation_basis_points: 4200,
          },
        ],
      },
    },
  });
  assert.equal(envelope.data.holdings[0].quantity, 2.125);
});

test("strictly validates Money, bounded confidence/share basis points, dates, IDs, and findings", () => {
  const build = (data) =>
    createFinanceEnvelope({
      kind: "insights",
      generatedAt: NOW,
      serviceResult: { data },
    });

  assert.throws(
    () => build({ total: { amount_minor: 100, currency: "usd" } }),
    FinanceMcpError,
  );
  assert.throws(
    () => build({ confidence_basis_points: 10_001 }),
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
      trend: { percent_basis_points: -25_000 },
      estimated_return_basis_points: null,
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
                amount_minor: 2500,
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
            change: { amount_minor: 3500, currency: "USD" },
          },
          rule: {
            threshold_basis_points: 1500,
            minimum_change: { amount_minor: 2500, currency: "USD" },
          },
          confidence_basis_points: 9200,
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
            confidence_basis_points: 9000,
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
            amount: { amount_minor: -500, currency: "USD" },
          },
        ],
        series: [
          {
            timestamp: "2026-07-26",
            value: { amount_minor: 500, currency: "USD" },
          },
        ],
      },
    },
  });
  assert.equal(envelope.data.transactions[0].authorized_at, null);
});

test("creates exactly two text blocks with an identical canonical compatibility copy", () => {
  const envelope = createFinanceEnvelope({
    kind: "overview",
    generatedAt: NOW,
    serviceResult: {
      data: {
        net_worth: { amount_minor: 1_234_56, currency: "USD" },
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
              amount: { amount_minor: -100, currency: "USD" },
            })),
          },
        },
      }),
    (error) =>
      error instanceof FinanceMcpError &&
      error.code === "result_too_large",
  );
});
