import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import ejs from "ejs";

import { buildDemoModel } from "../app/demo/webFixtures.js";
import { formatMoney } from "../app/routes/web.js";
import { buildPortfolioSummary } from "../app/services/analytics.js";
import { createFinanceService } from "../app/services/financeService.js";
import { detectInvestmentInsights } from "../app/services/insightDetectors.js";
import { normalizePlaidSecurity } from "../app/providers/plaidNormalizer.js";
import {
  consolidatePortfolioHoldingRows,
  selectPortfolioHolding,
} from "../app/services/portfolioPresentation.js";

const NOW = new Date("2026-07-27T19:00:00.000Z");

function usd(amountMinor) {
  return { amount_minor: amountMinor, currency: "USD" };
}

function cashHolding(overrides = {}) {
  return {
    id: "holding-cash",
    account_id: "account-etrade",
    security_id: "security-cash",
    name: "U.S. Dollar",
    ticker_symbol: "CUR:USD",
    security_type: "equity",
    quantity: 1_234.56,
    value_minor: 123_456,
    cost_basis_minor: null,
    close_price_as_of: null,
    currency_code: "USD",
    ...overrides,
  };
}

test("Plaid CUR currency tickers normalize as cash", () => {
  const security = normalizePlaidSecurity({
    security_id: "etrade-usd",
    name: "U.S. Dollar",
    ticker_symbol: "CUR:USD",
    type: "equity",
    iso_currency_code: "USD",
  });

  assert.equal(security.ticker_symbol, "CUR:USD");
  assert.equal(security.security_type, "cash");
});

test("portfolio includes CUR:USD value without stock price requirements", () => {
  const portfolio = buildPortfolioSummary({
    holdings: [
      cashHolding(),
      {
        id: "holding-stock",
        account_id: "account-etrade",
        security_id: "security-stock",
        name: "Index fund",
        ticker_symbol: "INDEX",
        security_type: "equity",
        quantity: 1,
        value_minor: 100_000,
        cost_basis_minor: 90_000,
        close_price_as_of: "2026-07-27",
        currency_code: "USD",
      },
    ],
    snapshots: [],
    currency: "USD",
    now: NOW,
  });

  assert.deepEqual(portfolio.total_value, usd(223_456));
  assert.equal(portfolio.holdings[0].security_type, "cash");
  assert.deepEqual(portfolio.holdings[0].value, usd(123_456));
  assert.deepEqual(
    portfolio.allocation.map((entry) => entry.label),
    ["cash", "equity"],
  );
  assert.ok(
    !portfolio.warnings.includes("Some holdings are missing cost basis."),
  );
  assert.ok(!portfolio.warnings.includes("Some holding prices are stale."));
});

test("cash never triggers a single-stock concentration insight", () => {
  const result = detectInvestmentInsights({
    holdings: [
      cashHolding({ value_minor: 900_000 }),
      {
        id: "holding-stock",
        account_id: "account-etrade",
        security_id: "security-stock",
        name: "Index fund",
        ticker_symbol: "INDEX",
        security_type: "equity",
        quantity: 1,
        value_minor: 100_000,
        cost_basis_minor: 100_000,
        close_price_as_of: "2026-07-27",
        currency_code: "USD",
      },
    ],
    snapshots: [],
    investmentTransactions: [],
    asOf: NOW,
  });

  assert.equal(
    result.some((finding) => finding.type === "concentration"),
    false,
  );
});

test("portfolio presentation consolidates cash by currency and account", () => {
  const rows = consolidatePortfolioHoldingRows([
    {
      id: "stock",
      selectionKey: "INDEX",
      symbol: "INDEX",
      securityType: "equity",
      value: usd(175_000),
      allocation: 50,
    },
    {
      id: "cash-a-1",
      accountId: "account-a",
      account: "Brokerage A",
      selectionKey: "CUR:USD",
      symbol: "Cash",
      securityType: "cash",
      value: usd(100_000),
      allocation: 28.57,
    },
    {
      id: "cash-b",
      accountId: "account-b",
      account: "Brokerage B",
      selectionKey: "CUR:USD",
      symbol: "Cash",
      securityType: "cash",
      value: usd(75_000),
      allocation: 21.43,
    },
    {
      id: "cash-a-2",
      accountId: "account-a",
      account: "Brokerage A",
      selectionKey: "CUR:USD",
      symbol: "Cash",
      securityType: "cash",
      value: usd(0),
      allocation: 0,
    },
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].selectionKey, "INDEX");
  assert.deepEqual(rows[1], {
    id: "cash:USD",
    securityId: null,
    accountId: null,
    account: null,
    selectionKey: "cash:USD",
    symbol: "Cash",
    badge: "$",
    name: "USD across 2 accounts",
    isCash: true,
    securityType: "cash",
    balanceGroup: null,
    value: usd(175_000),
    costBasis: null,
    price: null,
    priceAsOf: null,
    allocation: 50,
    shares: null,
    positions: [
      {
        accountId: "account-a",
        account: "Brokerage A",
        value: usd(100_000),
      },
      {
        accountId: "account-b",
        account: "Brokerage B",
        value: usd(75_000),
      },
    ],
    legacySelectionKeys: ["CUR:USD"],
  });
  assert.equal(
    selectPortfolioHolding(rows, "cash:USD"),
    rows[1],
  );
  assert.equal(
    selectPortfolioHolding(rows, "CUR:USD"),
    rows[1],
  );
});

test("portfolio presentation consolidates the same security across accounts", () => {
  const rows = consolidatePortfolioHoldingRows([
    {
      id: "holding-schk-ira",
      securityId: "security-schk-ira",
      accountId: "account-ira",
      account: "IRA",
      selectionKey: "SCHK",
      symbol: "SCHK",
      badge: "SCHK",
      name: "Schwab 1000 Index ETF",
      securityType: "etf",
      balanceGroup: "retirement",
      value: usd(352_000),
      costBasis: usd(300_000),
      price: usd(3_520),
      priceAsOf: "2026-07-25",
      allocation: 23.27,
      shares: "10",
    },
    {
      id: "holding-schg",
      securityId: "security-schg",
      accountId: "account-brokerage",
      account: "Brokerage",
      selectionKey: "SCHG",
      symbol: "SCHG",
      badge: "SCHG",
      name: "Schwab U.S. Large-Cap Growth ETF",
      securityType: "etf",
      balanceGroup: "taxable_investment",
      value: usd(598_320),
      costBasis: usd(500_000),
      price: usd(2_000),
      priceAsOf: "2026-07-26",
      allocation: 39.56,
      shares: "29.916",
    },
    {
      id: "holding-schk-brokerage",
      securityId: "security-schk-brokerage",
      accountId: "account-brokerage",
      account: "Brokerage",
      selectionKey: "SCHK",
      symbol: "SCHK",
      badge: "SCHK",
      name: "Schwab 1000 Index ETF",
      securityType: "etf",
      balanceGroup: "taxable_investment",
      value: usd(222_760),
      costBasis: usd(200_000),
      price: usd(3_520),
      priceAsOf: "2026-07-27",
      allocation: 14.73,
      shares: "6.33",
    },
    {
      id: "holding-schk-shared",
      securityId: "security-schk-shared",
      accountId: "account-shared",
      account: "Shared Brokerage",
      selectionKey: "SCHK",
      symbol: "SCHK",
      badge: "SCHK",
      name: "Schwab 1000 Index ETF",
      securityType: "etf",
      balanceGroup: "taxable_investment",
      value: usd(123_200),
      costBasis: usd(100_000),
      price: usd(3_520),
      priceAsOf: "2026-07-26",
      allocation: 8.15,
      shares: "3.5",
    },
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].selectionKey, "SCHK");
  assert.deepEqual(rows[0], {
    id: null,
    securityId: null,
    accountId: null,
    account: null,
    selectionKey: "SCHK",
    symbol: "SCHK",
    badge: "SCHK",
    name: "Schwab 1000 Index ETF",
    securityType: "etf",
    balanceGroup: null,
    value: usd(697_960),
    costBasis: usd(600_000),
    price: usd(3_520),
    priceAsOf: "2026-07-27",
    allocation: 46.15,
    shares: "19.83",
    positions: [
      {
        accountId: "account-ira",
        account: "IRA",
        value: usd(352_000),
        shares: "10",
      },
      {
        accountId: "account-brokerage",
        account: "Brokerage",
        value: usd(222_760),
        shares: "6.33",
      },
      {
        accountId: "account-shared",
        account: "Shared Brokerage",
        value: usd(123_200),
        shares: "3.5",
      },
    ],
    isAggregated: true,
    legacySelectionKeys: ["SCHK"],
  });
  assert.equal(rows[1].selectionKey, "SCHG");
  assert.equal(selectPortfolioHolding(rows, "SCHK"), rows[0]);
});

test("portfolio page model presents E*TRADE currency as a cash balance", async () => {
  const service = createFinanceService({
    repository: {
      async getDataFreshness() {
        return {
          data_as_of: NOW.toISOString(),
          partial: false,
          warnings: [],
        };
      },
    },
    now: () => NOW,
  });
  service.getFinanceOverview = async () => ({ data: {} });
  service.getPortfolioSummary = async () => ({
    data: {
      scope: "trading",
      total_value: usd(123_456),
      holdings: [
        {
          id: "holding-cash",
          security_id: "security-cash",
          account_id: "account-etrade",
          account_name: "E*TRADE Brokerage",
          name: "U.S. Dollar",
          ticker_symbol: "CUR:USD",
          security_type: "cash",
          balance_group: "taxable_investment",
          value: usd(123_456),
          cost_basis: null,
          price: usd(100),
          price_as_of: null,
          quantity: 1_234.56,
          allocation_basis_points: 10_000,
        },
      ],
      allocation: [{ label: "cash", value: usd(123_456) }],
      series: [],
      warnings: [],
      period: { name: "1m" },
    },
  });

  const page = await service.getPageData("portfolio", {
    query: { scope: "trading", holding: "CUR:USD" },
  });

  assert.deepEqual(page.holdings[0], {
    id: "cash:USD",
    securityId: null,
    accountId: null,
    account: null,
    selectionKey: "cash:USD",
    symbol: "Cash",
    badge: "$",
    name: "USD in E*TRADE Brokerage",
    isCash: true,
    securityType: "cash",
    balanceGroup: null,
    value: usd(123_456),
    costBasis: null,
    price: null,
    priceAsOf: null,
    allocation: 100,
    shares: null,
    positions: [
      {
        accountId: "account-etrade",
        account: "E*TRADE Brokerage",
        value: usd(123_456),
      },
    ],
    legacySelectionKeys: ["CUR:USD"],
  });
  assert.deepEqual(page.allocation, [{ label: "Cash", value: 100 }]);
  assert.equal(page.selectedHolding.symbol, "Cash");
  assert.equal(page.selectedHolding.selectionKey, "cash:USD");
  assert.equal(page.portfolioData.holdings[0].id, "holding-cash");

  const canonicalSelection = await service.getPageData("portfolio", {
    query: { scope: "trading", holding: "cash:USD" },
  });
  assert.equal(
    canonicalSelection.selectedHolding.selectionKey,
    "cash:USD",
  );
});

test("portfolio HTML shows cash value without rendering CUR:USD as a stock", async () => {
  const demo = buildDemoModel();
  const html = await ejs.renderFile(
    path.resolve("app/views/portfolio.ejs"),
    {
      ...demo,
      formatMoney,
      activePath: "/portfolio",
      currentPath: "/portfolio",
      pageTitle: "Portfolio",
      pageDescription: "Description",
      query: { period: "1m", scope: "trading" },
      csrfToken: "csrf-test-value",
      holdings: [
        {
          selectionKey: "cash:USD",
          symbol: "Cash",
          badge: "$",
          name: "USD across 2 accounts",
          isCash: true,
          value: usd(123_456),
          allocation: 100,
          positions: [
            {
              accountId: "account-etrade",
              account: "E*TRADE Brokerage",
              value: usd(100_000),
            },
            {
              accountId: "account-roth",
              account: "Roth IRA",
              value: usd(23_456),
            },
          ],
        },
      ],
      allocation: [{ label: "Cash", value: 100 }],
      selectedHolding: {
        selectionKey: "cash:USD",
        symbol: "Cash",
        badge: "$",
        name: "USD across 2 accounts",
        isCash: true,
        value: usd(123_456),
        allocation: 100,
        positions: [
          {
            accountId: "account-etrade",
            account: "E*TRADE Brokerage",
            value: usd(100_000),
          },
          {
            accountId: "account-roth",
            account: "Roth IRA",
            value: usd(23_456),
          },
        ],
      },
      portfolioData: {
        scope: "trading",
        total_value: usd(123_456),
        holdings: [],
        series: [],
        warnings: [],
        period: { name: "1m" },
      },
    },
  );

  assert.match(html, />Cash</);
  assert.match(html, />USD across 2 accounts</);
  assert.match(html, /\$1,234\.56/);
  assert.match(html, /By investment account/);
  assert.match(html, /E\*TRADE Brokerage/);
  assert.match(html, /Roth IRA/);
  assert.match(html, /\$1,000\.00/);
  assert.match(html, /\$234\.56/);
  assert.doesNotMatch(html, /<dt>Shares<\/dt>/);
  assert.doesNotMatch(html, /<dt>Holding ID<\/dt>/);
  assert.doesNotMatch(html, /<span>Selected period<\/span>/);
  assert.doesNotMatch(html, /CUR:USD/);
});

test("portfolio HTML shows one combined security with its account positions", async () => {
  const demo = buildDemoModel();
  const combined = consolidatePortfolioHoldingRows([
    {
      id: "holding-ira",
      securityId: "security-ira",
      accountId: "account-ira",
      account: "IRA",
      selectionKey: "SCHK",
      symbol: "SCHK",
      badge: "SCHK",
      name: "Schwab 1000 Index ETF",
      securityType: "etf",
      balanceGroup: "retirement",
      value: usd(352_000),
      costBasis: usd(300_000),
      price: usd(3_520),
      priceAsOf: "2026-07-27",
      allocation: 60,
      shares: "10",
    },
    {
      id: "holding-brokerage",
      securityId: "security-brokerage",
      accountId: "account-brokerage",
      account: "Brokerage",
      selectionKey: "SCHK",
      symbol: "SCHK",
      badge: "SCHK",
      name: "Schwab 1000 Index ETF",
      securityType: "etf",
      balanceGroup: "taxable_investment",
      value: usd(222_760),
      costBasis: usd(200_000),
      price: usd(3_520),
      priceAsOf: "2026-07-27",
      allocation: 40,
      shares: "6.33",
    },
  ])[0];
  const html = await ejs.renderFile(
    path.resolve("app/views/portfolio.ejs"),
    {
      ...demo,
      formatMoney,
      activePath: "/portfolio",
      currentPath: "/portfolio",
      pageTitle: "Portfolio",
      pageDescription: "Description",
      query: { period: "1m", scope: "all" },
      csrfToken: "csrf-test-value",
      holdings: [combined],
      allocation: [{ label: "SCHK", value: 100 }],
      selectedHolding: combined,
      portfolioData: {
        scope: "all",
        total_value: combined.value,
        holdings: [],
        series: [],
        warnings: [],
        period: { name: "1m" },
      },
    },
  );

  assert.equal((html.match(/<strong>SCHK<\/strong>/g) ?? []).length, 1);
  assert.match(html, /Combined holding/);
  assert.match(html, /By investment account/);
  assert.match(html, /IRA[\s\S]*10 shares[\s\S]*\$3,520\.00/);
  assert.match(
    html,
    /Brokerage[\s\S]*6\.33 shares[\s\S]*\$2,227\.60/,
  );
  assert.match(html, /<dt>Shares<\/dt><dd>16\.33<\/dd>/);
  assert.match(html, /<dt>Cost basis<\/dt><dd>\$5,000\.00<\/dd>/);
  assert.doesNotMatch(html, /<dt>Holding ID<\/dt>/);
  assert.doesNotMatch(html, /<dt>Security ID<\/dt>/);
});
