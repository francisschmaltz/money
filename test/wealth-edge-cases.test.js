import assert from "node:assert/strict";
import test from "node:test";

import { PgFinanceRepository } from "../app/db/financeRepository.js";
import {
  buildNetWorthHistory,
  buildOverview,
} from "../app/services/analytics.js";
import { createFinanceService } from "../app/services/financeService.js";

const FRESHNESS = {
  data_as_of: "2026-07-26T18:42:00.000Z",
  partial: false,
  warnings: [],
};

function account(id, type, balance, subtype = null) {
  return {
    id,
    type,
    subtype,
    is_liability: ["credit", "loan"].includes(type),
    currency_code: "USD",
    current_balance_minor: balance,
  };
}

test("signed liability balances let overpayments improve current and historical worth", () => {
  const overview = buildOverview({
    accounts: [
      account("checking", "depository", 100_000, "checking"),
      account("overpaid-card", "credit", -5_000, "credit_card"),
    ],
    transactions: [],
    currency: "USD",
    periodStart: "2026-07-01",
    periodEnd: "2026-08-01",
  });

  assert.equal(overview.credit_card_liabilities.amount_minor, -5_000);
  assert.equal(overview.total_liabilities.amount_minor, -5_000);
  assert.equal(overview.short_term_worth.amount_minor, 105_000);
  assert.equal(overview.net_worth.amount_minor, 105_000);

  const history = buildNetWorthHistory({
    snapshots: [
      {
        ...account("checking", "depository", 100_000, "checking"),
        account_id: "checking",
        snapshot_on: "2026-07-01",
      },
      {
        ...account("card", "credit", 20_000, "credit_card"),
        account_id: "card",
        snapshot_on: "2026-07-01",
      },
      {
        ...account("checking", "depository", 100_000, "checking"),
        account_id: "checking",
        snapshot_on: "2026-07-02",
      },
      {
        ...account("card", "credit", -5_000, "credit_card"),
        account_id: "card",
        snapshot_on: "2026-07-02",
      },
    ],
  });

  assert.deepEqual(
    history.series.map((point) => [
      point.timestamp,
      point.liabilities.amount_minor,
      point.net_worth.amount_minor,
    ]),
    [
      ["2026-07-01", 20_000, 80_000],
      ["2026-07-02", -5_000, 105_000],
    ],
  );
});

test("current overview ignores future manual valuations and keeps the latest eligible value", async () => {
  const manualAssetReads = [];
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
      return FRESHNESS;
    },
    async listManualAssets(_workspaceId, options) {
      manualAssetReads.push(options);
      return [
        {
          id: "future-only",
          name: "Future house",
          asset_type: "real_estate",
          currency_code: "USD",
          active: true,
          current_value_minor: 90_000_000,
          valued_on: "2999-01-01",
        },
        {
          id: "valued-car",
          name: "Car",
          asset_type: "vehicle",
          currency_code: "USD",
          active: true,
          current_value_minor: 2_000_000,
          valued_on: "2999-01-01",
        },
      ];
    },
    async getManualAssetValuations() {
      return [
        {
          asset_id: "future-only",
          value_minor: 90_000_000,
          currency_code: "USD",
          valued_on: "2999-01-01",
        },
        {
          asset_id: "valued-car",
          value_minor: 1_500_000,
          currency_code: "USD",
          valued_on: "2026-07-25",
        },
        {
          asset_id: "valued-car",
          value_minor: 2_000_000,
          currency_code: "USD",
          valued_on: "2999-01-01",
        },
      ];
    },
  };
  const service = createFinanceService({
    repository,
    now: () => new Date("2026-07-26T19:00:00.000Z"),
  });

  const result = await service.getFinanceOverview();

  assert.deepEqual(manualAssetReads, [
    { includeInactive: false, asOf: "2026-07-26" },
  ]);
  assert.equal(result.data.manual_asset_value.amount_minor, 1_500_000);
  assert.equal(result.data.net_worth.amount_minor, 1_500_000);
  assert.equal(result.data.unknown_balance_count, 1);
  assert.equal(
    result.data.manual_assets.find((asset) => asset.id === "future-only")
      .current_value,
    null,
  );
});

test("workspace freshness uses the oldest live Item and flags every incomplete state", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, params });
      return {
        rows: [
          {
            data_as_of: "2026-07-24T12:00:00.000Z",
            has_errors: true,
            warnings: [],
            item_count: "3",
            unsynced_count: "1",
            stale_count: "1",
            manual_due_count: "0",
            error_count: "1",
          },
        ],
      };
    },
  };
  const repository = new PgFinanceRepository(pool);

  const freshness = await repository.getDataFreshness("shared");

  assert.equal(
    freshness.data_as_of,
    "2026-07-24T12:00:00.000Z",
  );
  assert.equal(freshness.partial, true);
  assert.equal(freshness.item_count, 3);
  assert.deepEqual(
    freshness.warnings.map((warning) => warning.code),
    [
      "unsynced_connections",
      "stale_connections",
      "connection_errors",
    ],
  );
  assert.deepEqual(calls[0].params, ["shared"]);
  assert.match(calls[0].sql, /c\.last_synced_at/);
  assert.match(calls[0].sql, /c\.status <> 'removed'/);
  assert.match(calls[0].sql, /interval '24 hours'/);
});

test("manual Apple Card freshness becomes an update reminder, not a sync error", async () => {
  const pool = {
    async query(sql) {
      const statement = String(sql).replace(/\s+/g, " ").trim();
      assert.match(statement, /c\.imported_through_on < current_date - 7/);
      return {
        rows: [
          {
            data_as_of: "2026-07-19T00:00:00.000Z",
            has_errors: true,
            warnings: [],
            item_count: "1",
            unsynced_count: "0",
            stale_count: "0",
            manual_due_count: "1",
            error_count: "0",
          },
        ],
      };
    },
  };
  const repository = new PgFinanceRepository(pool);

  const freshness = await repository.getDataFreshness("shared");

  assert.equal(freshness.partial, true);
  assert.deepEqual(freshness.warnings, [
    {
      code: "manual_update_due",
      message: "1 manual connection is due for a newer import.",
    },
  ]);
});
