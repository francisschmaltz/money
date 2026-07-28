import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import ejs from "ejs";

import { buildDemoModel, formatMoney } from "../app/routes/web.js";
import { buildPortfolioSummary } from "../app/services/analytics.js";
import { createFinanceService } from "../app/services/financeService.js";
import { detectInvestmentInsights } from "../app/services/insightDetectors.js";
import { normalizePlaidSecurity } from "../app/providers/plaidNormalizer.js";

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
    id: "holding-cash",
    securityId: "security-cash",
    accountId: "account-etrade",
    account: "E*TRADE Brokerage",
    selectionKey: "CUR:USD",
    symbol: "Cash",
    badge: "$",
    name: "USD balance",
    isCash: true,
    securityType: "cash",
    balanceGroup: "taxable_investment",
    value: usd(123_456),
    costBasis: null,
    price: usd(100),
    priceAsOf: null,
    allocation: 100,
    change: 0,
    shares: null,
  });
  assert.deepEqual(page.allocation, [{ label: "Cash", value: 100 }]);
  assert.equal(page.selectedHolding.symbol, "Cash");
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
          selectionKey: "CUR:USD",
          symbol: "Cash",
          badge: "$",
          name: "USD balance",
          isCash: true,
          value: usd(123_456),
          allocation: 100,
          change: 0,
        },
      ],
      allocation: [{ label: "Cash", value: 100 }],
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
  assert.match(html, />USD balance</);
  assert.match(html, /\$1,234\.56/);
  assert.doesNotMatch(html, /CUR:USD/);
});
