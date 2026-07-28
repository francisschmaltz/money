import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildPortfolioSummary,
  splitHoldingEquity,
} from "../app/services/analytics.js";
import { detectInvestmentInsights } from "../app/services/insightDetectors.js";
import { createFinanceService } from "../app/services/financeService.js";
import { normalizePlaidHolding } from "../app/providers/plaidNormalizer.js";

const NOW = new Date("2026-07-08T20:00:00.000Z");

function holding(overrides = {}) {
  return {
    id: "holding-grant",
    account_id: "account-stock-plan",
    account_name: "Company stock plan",
    security_id: "security-grant",
    name: "Acme Corp.",
    ticker_symbol: "ACME",
    security_type: "equity",
    quantity: 10,
    vested_quantity: 1,
    value_minor: 100_000,
    vested_value_minor: 10_000,
    price_minor: 10_000,
    cost_basis_minor: null,
    currency_code: "USD",
    close_price_as_of: "2026-07-08",
    as_of: "2026-07-08T18:00:00.000Z",
    balance_group: "taxable_investment",
    ...overrides,
  };
}

test("Plaid vesting facts remain nullable and the migration stores snapshot inputs", async () => {
  const normalized = normalizePlaidHolding({
    account_id: "provider-account",
    security_id: "provider-security",
    quantity: 12.5,
    vested_quantity: 4.25,
    institution_value: 1_250,
    vested_value: 425,
    institution_price: 100,
    iso_currency_code: "USD",
  });
  assert.equal(normalized.vested_quantity, 4.25);
  assert.equal(normalized.vested_value_minor, 42_500);

  const missing = normalizePlaidHolding({
    account_id: "provider-account",
    security_id: "provider-security",
    quantity: 12.5,
    institution_value: 1_250,
    institution_price: 100,
    iso_currency_code: "USD",
  });
  assert.equal(missing.vested_quantity, null);
  assert.equal(missing.vested_value_minor, null);

  const migration = await readFile(
    new URL("../migrations/017_future_equity.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    migration,
    /ALTER TABLE holdings[\s\S]*vested_quantity[\s\S]*vested_value_minor/,
  );
  assert.match(
    migration,
    /ALTER TABLE daily_holding_snapshots[\s\S]*institution_price_minor[\s\S]*vested_quantity[\s\S]*vested_value_minor/,
  );
});

test("future equity prefers reported value and safely falls back to fractional shares", () => {
  assert.deepEqual(splitHoldingEquity(holding()), {
    current_value_minor: 10_000,
    future_value_minor: 90_000,
    unvested_quantity: 9,
    valuation_basis: "reported_vested_value",
    observed: true,
    invalid: false,
  });

  assert.deepEqual(
    splitHoldingEquity(
      holding({
        quantity: 10.5,
        vested_quantity: 4.25,
        value_minor: 10_500,
        vested_value_minor: null,
        price_minor: 1_000,
      }),
    ),
    {
      current_value_minor: 4_250,
      future_value_minor: 6_250,
      unvested_quantity: 6.25,
      valuation_basis: "quantity_at_reported_price",
      observed: true,
      invalid: false,
    },
  );

  assert.equal(
    splitHoldingEquity(
      holding({
        vested_quantity: null,
        vested_value_minor: null,
      }),
    ).future_value_minor,
    null,
  );
  assert.equal(
    splitHoldingEquity(
      holding({
        vested_quantity: 10,
        vested_value_minor: 100_000,
      }),
    ).future_value_minor,
    0,
  );
  assert.equal(
    splitHoldingEquity(
      holding({
        vested_quantity: 11,
        vested_value_minor: 50_000,
      }),
    ).invalid,
    true,
  );
  assert.equal(
    splitHoldingEquity(
      holding({
        vested_value_minor: 100_001,
      }),
    ).invalid,
    true,
  );
});

test("portfolio totals and concentration use vested value while future equity stays separate", () => {
  const regular = holding({
    id: "holding-regular",
    account_id: "account-brokerage",
    account_name: "Brokerage",
    security_id: "security-regular",
    name: "Index fund",
    ticker_symbol: "INDEX",
    quantity: 1,
    vested_quantity: null,
    value_minor: 90_000,
    vested_value_minor: null,
    price_minor: 90_000,
  });
  const foreign = holding({
    id: "holding-foreign",
    security_id: "security-foreign",
    currency_code: "CAD",
    value_minor: 50_000,
    vested_value_minor: 5_000,
  });
  const snapshots = [
    holding({
      snapshot_on: "2026-07-01",
      value_minor: 90_000,
      vested_quantity: null,
      vested_value_minor: null,
      price_minor: null,
    }),
    {
      ...regular,
      snapshot_on: "2026-07-01",
      value_minor: 80_000,
    },
    { ...holding(), snapshot_on: "2026-07-08" },
    { ...regular, snapshot_on: "2026-07-08" },
  ];
  const portfolio = buildPortfolioSummary({
    holdings: [holding(), regular, foreign],
    snapshots,
    investmentTransactions: [],
    currency: "USD",
    now: NOW,
  });

  assert.equal(portfolio.total_value.amount_minor, 100_000);
  assert.equal(
    portfolio.future_equity.total_value.amount_minor,
    90_000,
  );
  assert.equal(portfolio.future_equity.holdings.length, 1);
  assert.equal(portfolio.future_equity.holdings[0].account_name, "Company stock plan");
  assert.deepEqual(
    portfolio.holdings.map((entry) => entry.allocation_basis_points),
    [1_000, 9_000],
  );
  assert.equal(portfolio.holdings[0].quantity, 1);
  assert.deepEqual(
    portfolio.series.map((point) => point.timestamp),
    ["2026-07-08"],
  );

  const findings = detectInvestmentInsights({
    holdings: [holding(), regular],
    snapshots: [],
    investmentTransactions: [],
    asOf: NOW,
  });
  assert.equal(
    findings.some(
      (finding) =>
        finding.type === "concentration" &&
        finding.title.startsWith("ACME "),
    ),
    false,
  );
});

test("portfolio return is hidden when a vest changes inside the selected history", () => {
  const snapshots = Array.from({ length: 8 }, (_, index) => {
    const vestedQuantity = index < 4 ? 4 : 5;
    return holding({
      snapshot_on: `2026-07-${String(index + 1).padStart(2, "0")}`,
      vested_quantity: vestedQuantity,
      vested_value_minor: vestedQuantity * 10_000,
    });
  });
  const portfolio = buildPortfolioSummary({
    holdings: [
      holding({
        vested_quantity: 5,
        vested_value_minor: 50_000,
      }),
    ],
    snapshots,
    investmentTransactions: [],
    currency: "USD",
    now: NOW,
    investmentHistoryComplete: true,
  });

  assert.equal(portfolio.estimated_return_basis_points, null);
  assert.ok(
    portfolio.warnings.some((warning) =>
      warning.includes("vesting changes"),
    ),
  );
});

test("future equity follows portfolio account scope", async () => {
  const holdings = [
    holding(),
    holding({
      id: "holding-retirement",
      account_id: "account-retirement",
      account_name: "Retirement stock plan",
      security_id: "security-retirement",
      quantity: 20,
      vested_quantity: 5,
      value_minor: 200_000,
      vested_value_minor: 50_000,
      balance_group: "retirement",
    }),
  ];
  const accounts = [
    {
      id: "account-stock-plan",
      type: "investment",
      subtype: "stock plan",
      is_liability: false,
    },
    {
      id: "account-retirement",
      type: "investment",
      subtype: "roth",
      is_liability: false,
    },
  ];
  const repository = {
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
      return {
        data_as_of: "2026-07-08T18:00:00.000Z",
        partial: false,
        warnings: [],
      };
    },
    async listAccounts() {
      return accounts;
    },
  };
  const service = createFinanceService({
    repository,
    now: () => NOW,
  });

  const trading = await service.getPortfolioSummary({
    retirement_scope: "exclude",
  });
  const retirement = await service.getPortfolioSummary({
    retirement_scope: "only",
  });

  assert.equal(trading.data.total_value.amount_minor, 10_000);
  assert.equal(
    trading.data.future_equity.total_value.amount_minor,
    90_000,
  );
  assert.equal(retirement.data.total_value.amount_minor, 50_000);
  assert.equal(
    retirement.data.future_equity.total_value.amount_minor,
    150_000,
  );
});
