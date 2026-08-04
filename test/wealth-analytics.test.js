import test from "node:test";
import assert from "node:assert/strict";

import {
  buildNetWorthHistory,
  buildOverview,
  inferBalanceGroup,
} from "../app/services/analytics.js";
import { createFinanceService } from "../app/services/financeService.js";
import { parseFinanceToolInput } from "../app/mcp/schemas.js";

const FRESHNESS = {
  data_as_of: "2026-07-26T18:42:00.000Z",
  partial: false,
  warnings: [],
};

function account({
  id,
  type,
  subtype,
  balance,
  liability = false,
  currency = "USD",
  override = null,
}) {
  return {
    id,
    institution_id: "institution",
    institution_name: "Bank",
    name: id,
    mask: "1234",
    type,
    subtype,
    currency_code: currency,
    current_balance_minor: balance,
    available_balance_minor: balance,
    is_liability: liability,
    balance_group_override: override,
    active: true,
    last_synced_at: FRESHNESS.data_as_of,
  };
}

test("wealth formulas separate cash, short-term worth, and true net worth", () => {
  const accounts = [
    account({
      id: "checking",
      type: "depository",
      subtype: "checking",
      balance: 100_000,
    }),
    account({
      id: "savings",
      type: "depository",
      subtype: "savings",
      balance: 200_000,
    }),
    account({
      id: "brokerage",
      type: "investment",
      subtype: "brokerage",
      balance: 300_000,
    }),
    account({
      id: "retirement",
      type: "investment",
      subtype: "roth 401k",
      balance: 400_000,
    }),
    account({
      id: "card",
      type: "credit",
      subtype: "credit_card",
      balance: 50_000,
      liability: true,
    }),
    account({
      id: "mortgage",
      type: "loan",
      subtype: "mortgage",
      balance: 250_000,
      liability: true,
    }),
    account({
      id: "unknown",
      type: "depository",
      subtype: "checking",
      balance: null,
    }),
    account({
      id: "euro",
      type: "depository",
      subtype: "checking",
      balance: 99_000,
      currency: "EUR",
    }),
  ];
  const overview = buildOverview({
    accounts,
    transactions: [],
    manualAssets: [
      {
        id: "home",
        value_minor: 500_000,
        currency_code: "USD",
        active: true,
      },
    ],
    currency: "USD",
    periodStart: "2026-07-01",
    periodEnd: "2026-08-01",
  });

  assert.equal(overview.cash.amount_minor, 300_000);
  assert.equal(overview.taxable_investments.amount_minor, 300_000);
  assert.equal(overview.cash_balance.amount_minor, 600_000);
  assert.equal(overview.short_term_worth.amount_minor, 550_000);
  assert.equal(overview.retirement_assets.amount_minor, 400_000);
  assert.equal(overview.manual_asset_value.amount_minor, 500_000);
  assert.equal(overview.credit_card_liabilities.amount_minor, 50_000);
  assert.equal(overview.loan_liabilities.amount_minor, 250_000);
  assert.equal(overview.total_assets.amount_minor, 1_500_000);
  assert.equal(overview.total_liabilities.amount_minor, 300_000);
  assert.equal(overview.net_worth.amount_minor, 1_200_000);
  assert.equal(overview.unknown_balance_count, 1);
  assert.equal(overview.excluded_from_usd_total_count, 1);
});

test("overview marks unknown USD balances partial and explains currency exclusions", async () => {
  const accounts = [
    account({
      id: "unknown",
      type: "depository",
      subtype: "checking",
      balance: null,
    }),
    account({
      id: "euro",
      type: "depository",
      subtype: "checking",
      balance: 100_000,
      currency: "EUR",
    }),
  ];
  const repository = {
    async listAccounts() {
      return accounts;
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
      return FRESHNESS;
    },
  };
  const service = createFinanceService({ repository });
  const overview = await service.getFinanceOverview();
  const listed = await service.listAccounts();

  assert.equal(overview.partial, true);
  assert.equal(listed.partial, true);
  assert.ok(
    overview.warnings.some((warning) =>
      warning.includes("USD balance is unknown"),
    ),
  );
  assert.ok(
    overview.warnings.some((warning) =>
      warning.includes("non-USD balance is excluded"),
    ),
  );
});

test("account coverage warnings expose a partial sync", async () => {
  const warnings = [
    {
      product: "investment_holdings",
      code: "EMPTY_HOLDINGS_WITH_POSITIVE_BALANCE",
    },
  ];
  const investment = account({
    id: "retirement",
    type: "investment",
    subtype: "401k",
    balance: 14_127_923,
  });
  investment.connection_status = "active";
  investment.connection_coverage_warnings = warnings;
  const repository = {
    async listAccounts() {
      return [investment];
    },
    async getDataFreshness() {
      return FRESHNESS;
    },
  };
  const service = createFinanceService({ repository });

  const listed = await service.listAccounts();
  const card = listed.data.groups[0].accounts[0];

  assert.equal(card.freshness.status, "partial");
  assert.deepEqual(card.freshness.coverage_warnings, warnings);
});

test("balance-group overrides win over inferred account subtype", () => {
  assert.equal(
    inferBalanceGroup(
      account({
        id: "brokerage",
        type: "investment",
        subtype: "brokerage",
        balance: 1,
        override: "retirement",
      }),
    ),
    "retirement",
  );
  assert.throws(
    () =>
      inferBalanceGroup({
        type: "investment",
        balance_group_override: "made_up",
      }),
    /Unsupported balance group/,
  );
});

test("retirement identity cannot be overridden into spendable cash", () => {
  for (const override of ["cash", "taxable_investment"]) {
    assert.equal(
      inferBalanceGroup(
        account({
          id: `retirement-${override}`,
          type: "investment",
          subtype: "roth ira",
          balance: 100_000,
          override,
        }),
      ),
      "retirement",
    );
  }
  assert.equal(
    inferBalanceGroup(
      account({
        id: "retirement-excluded",
        type: "investment",
        subtype: "roth ira",
        balance: 100_000,
        override: "excluded",
      }),
    ),
    "excluded",
  );
});

test("portfolio supports all, non-retirement, and retirement-only scopes", async () => {
  const accounts = [
    account({
      id: "taxable",
      type: "investment",
      subtype: "brokerage",
      balance: 100_000,
    }),
    account({
      id: "retirement",
      type: "investment",
      subtype: "ira",
      balance: 200_000,
    }),
  ];
  const holdings = [
    holding("taxable-holding", "taxable", 100_000),
    holding("retirement-holding", "retirement", 200_000),
  ];
  const repository = {
    async listAccounts() {
      return accounts;
    },
    async getHoldings() {
      return holdings;
    },
    async getHoldingSnapshots() {
      return [];
    },
    async getInvestmentTransactions() {
      return [];
    },
    async getDataFreshness() {
      return FRESHNESS;
    },
  };
  const service = createFinanceService({ repository });

  const all = await service.getPortfolioSummary({
    retirement_scope: "include",
  });
  const trading = await service.getPortfolioSummary({
    retirement_scope: "exclude",
  });
  const legacyTaxableLink = await service.getPortfolioSummary({
    scope: "taxable",
  });
  const retirement = await service.getPortfolioSummary({
    retirement_scope: "only",
  });

  assert.equal(all.data.total_value.amount_minor, 300_000);
  assert.equal(all.data.scope, "all");
  assert.equal(all.data.taxable_value.amount_minor, 100_000);
  assert.equal(all.data.retirement_value.amount_minor, 200_000);
  assert.equal(trading.data.total_value.amount_minor, 100_000);
  assert.equal(trading.data.scope, "trading");
  assert.equal(legacyTaxableLink.data.scope, "trading");
  assert.deepEqual(
    trading.data.holdings.map((value) => value.balance_group),
    ["taxable_investment"],
  );
  assert.equal(retirement.data.total_value.amount_minor, 200_000);
  assert.equal(retirement.data.scope, "retirement");
  assert.deepEqual(
    retirement.data.holdings.map((value) => value.balance_group),
    ["retirement"],
  );
});

test("portfolio reconciles an investment account balance while holdings are pending", async () => {
  const accounts = [
    account({
      id: "schwab-retirement",
      type: "investment",
      subtype: "ira",
      balance: 519_526,
    }),
    account({
      id: "fidelity-retirement",
      type: "investment",
      subtype: "401k",
      balance: 14_127_923,
    }),
  ];
  const repository = {
    async listAccounts() {
      return accounts;
    },
    async getHoldings() {
      return [
        holding(
          "schwab-retirement-holding",
          "schwab-retirement",
          519_526,
        ),
      ];
    },
    async getHoldingSnapshots() {
      return [];
    },
    async getInvestmentTransactions() {
      return [];
    },
    async getDataFreshness() {
      return FRESHNESS;
    },
  };
  const service = createFinanceService({ repository });

  const result = await service.getPortfolioSummary({
    retirement_scope: "only",
  });

  assert.equal(result.data.total_value.amount_minor, 14_647_449);
  assert.equal(result.data.retirement_value.amount_minor, 14_647_449);
  assert.equal(result.data.holdings.length, 1);
  assert.deepEqual(result.data.allocation_pending, {
    total_value: {
      amount_minor: 14_127_923,
      currency: "USD",
    },
    accounts: [
      {
        account_id: "fidelity-retirement",
        account_name: "fidelity-retirement",
        balance_group: "retirement",
        value: {
          amount_minor: 14_127_923,
          currency: "USD",
        },
        allocation_basis_points: 9_645,
      },
    ],
  });
  assert.equal(result.data.holdings[0].allocation_basis_points, 355);
  assert.equal(result.data.allocation[0].label, "allocation_pending");
  assert.match(result.data.warnings[0], /holding-level allocation/);
  assert.match(result.summary, /1 balance pending allocation/);
});

test("portfolio never uses a stock-plan account balance as vested value", async () => {
  const repository = {
    async listAccounts() {
      return [
        account({
          id: "stock-plan",
          type: "investment",
          subtype: "stock plan",
          balance: 900_000,
        }),
      ];
    },
    async getHoldings() {
      return [];
    },
    async getHoldingSnapshots() {
      return [];
    },
    async getInvestmentTransactions() {
      return [];
    },
    async getDataFreshness() {
      return FRESHNESS;
    },
  };
  const service = createFinanceService({ repository });

  const result = await service.getPortfolioSummary({
    retirement_scope: "exclude",
  });

  assert.equal(result.data.total_value.amount_minor, 0);
  assert.equal(result.data.allocation_pending, null);
});

test("manual valuations carry forward through net-worth history", () => {
  const history = buildNetWorthHistory({
    snapshots: [
      snapshot("checking", "2026-07-01", 100_000),
      snapshot("checking", "2026-07-03", 110_000),
    ],
    manualAssets: [
      { id: "home", active: true },
      { id: "archived", active: false },
    ],
    manualAssetValuations: [
      valuation("home", "2026-06-30", 500_000),
      valuation("home", "2026-07-02", 550_000),
      valuation("archived", "2026-07-02", 900_000),
      valuation("foreign", "2026-07-02", 900_000, "EUR"),
    ],
  });

  assert.deepEqual(
    history.series.map((point) => [
      point.timestamp,
      point.assets.amount_minor,
      point.manual_asset_value.amount_minor,
    ]),
    [
      ["2026-06-30", 500_000, 500_000],
      ["2026-07-01", 600_000, 500_000],
      ["2026-07-02", 650_000, 550_000],
      ["2026-07-03", 660_000, 550_000],
    ],
  );
  assert.equal(history.current_net_worth.amount_minor, 660_000);
});

test("wealth history keeps cash, short-term, retirement, and net-worth series aligned", () => {
  const history = buildNetWorthHistory({
    snapshots: [
      {
        ...snapshot("checking", "2026-07-01", 100_000),
        type: "depository",
        subtype: "checking",
      },
      {
        ...snapshot("brokerage", "2026-07-01", 50_000),
        type: "investment",
        subtype: "brokerage",
      },
      {
        ...snapshot("card", "2026-07-01", 20_000),
        type: "credit",
        subtype: "credit_card",
        is_liability: true,
      },
      {
        ...snapshot("retirement", "2026-07-01", 80_000),
        type: "investment",
        subtype: "roth_ira",
      },
      {
        ...snapshot("checking", "2026-07-02", 110_000),
        type: "depository",
        subtype: "checking",
      },
      {
        ...snapshot("card", "2026-07-02", 15_000),
        type: "credit",
        subtype: "credit_card",
        is_liability: true,
      },
    ],
  });

  assert.deepEqual(
    history.series.map((point) => ({
      timestamp: point.timestamp,
      cash: point.cash_balance.amount_minor,
      short_term: point.short_term_worth.amount_minor,
      retirement: point.retirement_assets.amount_minor,
      net_worth: point.net_worth.amount_minor,
    })),
    [
      {
        timestamp: "2026-07-01",
        cash: 150_000,
        short_term: 130_000,
        retirement: 80_000,
        net_worth: 210_000,
      },
      {
        timestamp: "2026-07-02",
        cash: 160_000,
        short_term: 145_000,
        retirement: 80_000,
        net_worth: 225_000,
      },
    ],
  );
});

test("public net-worth history stays compact while the dashboard can request components", async () => {
  const snapshots = [
    {
      ...snapshot("checking", "2026-07-01", 100_000),
      type: "depository",
      subtype: "checking",
    },
    {
      ...snapshot("retirement", "2026-07-01", 80_000),
      type: "investment",
      subtype: "roth_ira",
    },
  ];
  const service = createFinanceService({
    repository: {
      async getAccountSnapshots() {
        return snapshots;
      },
      async getDataFreshness() {
        return FRESHNESS;
      },
      async listManualAssets() {
        return [];
      },
      async getManualAssetValuations() {
        return [];
      },
    },
    now: () => new Date("2026-07-02T12:00:00.000Z"),
  });

  const publicHistory = await service.getNetWorthHistory({
    startOn: "2026-07-01",
    endOn: "2026-07-03",
  });
  assert.equal(
    Object.hasOwn(publicHistory.data.series[0], "cash_balance"),
    false,
  );

  const dashboardHistory = await service.getNetWorthHistory({
    startOn: "2026-07-01",
    endOn: "2026-07-03",
    includeComponents: true,
  });
  assert.equal(
    dashboardHistory.data.series[0].cash_balance.amount_minor,
    100_000,
  );
  assert.equal(
    dashboardHistory.data.series[0].retirement_assets.amount_minor,
    80_000,
  );
});

test("net-worth history excludes overridden accounts and preserves pre-archive asset value", () => {
  const history = buildNetWorthHistory({
    snapshots: [
      {
        ...snapshot("checking", "2026-07-01", 100_000),
        balance_group: "cash",
      },
      {
        ...snapshot("excluded", "2026-07-01", 900_000),
        balance_group_override: "excluded",
      },
      {
        ...snapshot("checking", "2026-07-03", 110_000),
        balance_group: "cash",
      },
    ],
    manualAssets: [
      {
        id: "car",
        active: false,
        created_at: "2026-06-01T00:00:00.000Z",
        archived_at: "2026-07-03T00:00:00.000Z",
      },
    ],
    manualAssetValuations: [
      valuation("car", "2026-06-30", 50_000),
    ],
  });

  const julyFirst = history.series.find(
    (point) => point.timestamp === "2026-07-01",
  );
  const julyThird = history.series.find(
    (point) => point.timestamp === "2026-07-03",
  );
  assert.equal(julyFirst.assets.amount_minor, 150_000);
  assert.equal(julyFirst.manual_asset_value.amount_minor, 50_000);
  assert.equal(julyThird.assets.amount_minor, 110_000);
  assert.equal(julyThird.manual_asset_value.amount_minor, 0);
});

test("MCP wealth scopes validate and custom periods require both dates", () => {
  assert.equal(
    parseFinanceToolInput("get_portfolio_summary", {})
      .retirement_scope,
    "include",
  );
  assert.equal(
    parseFinanceToolInput("list_accounts", {
      balance_group: "retirement",
    }).balance_group,
    "retirement",
  );
  assert.throws(
    () =>
      parseFinanceToolInput("get_spending_summary", {
        period: "custom",
        start_date: "2026-07-01",
      }),
    /end_date is required/,
  );
  assert.throws(
    () =>
      parseFinanceToolInput("get_cash_flow", {
        period: "custom",
        end_date: "2026-07-31",
      }),
    /start_date is required/,
  );
});

test("historical insights never mix in current portfolio or subscription totals", async () => {
  const repository = {
    async listInsightFindings() {
      return [
        {
          id: "historical",
          family: "weekly",
          type: "needs_review",
          title: "Historical finding",
          metrics: {},
          generated_at: "2026-07-08T12:00:00.000Z",
        },
      ];
    },
    async getDataFreshness() {
      return FRESHNESS;
    },
    async getLatestNarrative() {
      assert.fail("current narratives must not be used");
    },
    async getHoldings() {
      assert.fail("current portfolio must not be used");
    },
    async listRecurringStreams() {
      assert.fail("current recurring totals must not be used");
    },
  };
  const service = createFinanceService({
    repository,
    now: () => new Date("2026-07-26T19:00:00.000Z"),
  });
  const result = await service.getFinanceInsights({
    section: "all",
    as_of: "2026-07-09T00:00:00.000Z",
  });

  assert.deepEqual(result.data.weekly.period.current, {
    start_on: "2026-07-02",
    end_on: "2026-07-09",
  });
  assert.equal(result.data.weekly.findings.length, 1);
  assert.ok(
    result.warnings.some((warning) =>
      warning.startsWith("Historical insight summaries"),
    ),
  );
});

test("manual asset service mutations validate before storage and refresh search", async () => {
  const calls = [];
  const repository = {
    async createManualAsset(_workspaceId, input) {
      calls.push(["create", input]);
      return { id: "asset", ...input };
    },
    async updateAccountBalanceGroup(_workspaceId, input) {
      calls.push(["group", input]);
      return { id: input.accountId };
    },
    async rebuildSearchDocuments() {
      calls.push(["search"]);
    },
  };
  const service = createFinanceService({ repository });
  await service.createManualAsset({
    name: "Car",
    asset_type: "vehicle",
    currency_code: "USD",
    value_minor: 1_000_000,
    valued_on: "2026-07-26",
    user_id: "admin",
  });
  await service.updateAccountBalanceGroup({
    account_id: "account-1",
    balance_group: "retirement",
    user_id: "admin",
  });

  assert.deepEqual(calls[0], [
    "create",
    {
      name: "Car",
      assetType: "vehicle",
      description: null,
      currencyCode: "USD",
      valueMinor: 1_000_000,
      valuedOn: "2026-07-26",
      userId: "admin",
    },
  ]);
  assert.deepEqual(calls[2], [
    "group",
    {
      accountId: "account-1",
      balanceGroup: "retirement",
      userId: "admin",
    },
  ]);
  await assert.rejects(
    service.createManualAsset({
      name: "Debt pretending to be an asset",
      asset_type: "other",
      currency_code: "USD",
      value_minor: -1,
      valued_on: "2026-07-26",
    }),
    /non-negative safe integer/,
  );
  await assert.rejects(
    service.updateAccountBalanceGroup({
      account_id: "account-1",
      balance_group: "made_up",
    }),
    /Invalid balance_group/,
  );
});

function holding(id, accountId, valueMinor) {
  return {
    id,
    account_id: accountId,
    security_id: id,
    name: id,
    ticker_symbol: id.toUpperCase(),
    security_type: "equity",
    value_minor: valueMinor,
    cost_basis_minor: valueMinor,
    quantity: 1,
    currency_code: "USD",
    close_price_as_of: "2026-07-26",
  };
}

function snapshot(accountId, date, balance) {
  return {
    account_id: accountId,
    snapshot_on: date,
    current_balance_minor: balance,
    currency_code: "USD",
    is_liability: false,
  };
}

function valuation(assetId, date, value, currency = "USD") {
  return {
    manual_asset_id: assetId,
    valued_on: date,
    value_minor: value,
    currency_code: currency,
  };
}
