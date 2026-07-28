import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PgFinanceRepository,
  inferBalanceGroup,
} from "../app/db/financeRepository.js";

function fakePool(handler) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(compact)) {
        return { rows: [], rowCount: 0 };
      }
      return (await handler(compact, params)) ?? { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return {
    calls,
    pool: {
      async connect() {
        return client;
      },
      query: client.query.bind(client),
    },
  };
}

function accountRow(overrides = {}) {
  return {
    id: "account-1",
    item_id: "item-1",
    institution_id: "institution-1",
    institution_name: "Bank",
    name: "Brokerage",
    official_name: null,
    mask: "1234",
    type: "investment",
    subtype: "brokerage",
    currency_code: "USD",
    current_balance_minor: "125000",
    available_balance_minor: null,
    credit_limit_minor: null,
    is_liability: false,
    balance_group_override: null,
    active: true,
    last_synced_at: "2026-07-26T12:00:00.000Z",
    ...overrides,
  };
}

test("balance groups infer deterministically and explicit overrides win", () => {
  assert.equal(
    inferBalanceGroup({ type: "depository", subtype: "checking" }),
    "cash",
  );
  assert.equal(
    inferBalanceGroup({ type: "investment", subtype: "roth 401k" }),
    "retirement",
  );
  assert.equal(
    inferBalanceGroup({ type: "investment", subtype: "brokerage" }),
    "taxable_investment",
  );
  for (const subtype of [
    "non-taxable brokerage account",
    "profit sharing plan",
    "thrift savings plan",
    "fixed annuity",
    "health savings account",
  ]) {
    assert.equal(
      inferBalanceGroup({ type: "investment", subtype }),
      "retirement",
      subtype,
    );
  }
  assert.equal(
    inferBalanceGroup({ type: "credit", is_liability: true }),
    "credit_card",
  );
  assert.equal(
    inferBalanceGroup({
      type: "investment",
      subtype: "ira",
      balance_group_override: "excluded",
    }),
    "excluded",
  );
  for (const balanceGroup of ["cash", "taxable_investment"]) {
    assert.equal(
      inferBalanceGroup({
        type: "investment",
        subtype: "ira",
        balance_group: balanceGroup,
        balance_group_override: balanceGroup,
      }),
      "retirement",
      balanceGroup,
    );
  }
});

test("account group updates are workspace scoped, clearable, and refresh search", async () => {
  const db = fakePool(async (sql, params) => {
    if (sql.includes("UPDATE accounts a")) {
      assert.match(sql, /a\.workspace_id = \$1/);
      assert.deepEqual(params, ["shared", "account-1", "retirement"]);
      return {
        rows: [
          accountRow({ balance_group_override: "retirement" }),
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);
  const account = await repository.updateAccountBalanceGroup("shared", {
    accountId: "account-1",
    balanceGroup: "retirement",
    userId: "admin",
  });
  assert.equal(account.balance_group_override, "retirement");
  assert.equal(account.balance_group, "retirement");
  assert.ok(
    db.calls.some(
      (call) =>
        call.sql.includes("INSERT INTO search_documents") &&
        call.sql.includes("'account'"),
    ),
  );
  await assert.rejects(
    repository.updateAccountBalanceGroup("shared", {
      accountId: "account-1",
      balanceGroup: "made_up",
    }),
    /balanceGroup is invalid/,
  );
});

test("manual assets create with an initial valuation and a searchable document", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("INSERT INTO manual_assets")) {
      return {
        rows: [
          {
            id: "asset-1",
            workspace_id: "shared",
            name: "Honda Civic",
            asset_type: "vehicle",
            description: "Daily driver",
            currency_code: "USD",
            active: true,
            created_at: "2026-07-26T12:00:00.000Z",
            updated_at: "2026-07-26T12:00:00.000Z",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);
  const asset = await repository.createManualAsset("shared", {
    id: "asset-1",
    name: " Honda Civic ",
    assetType: "vehicle",
    description: "Daily driver",
    currencyCode: "usd",
    valueMinor: 1_875_000,
    valuedOn: "2026-07-26",
  });
  assert.deepEqual(asset, {
    id: "asset-1",
    name: "Honda Civic",
    asset_type: "vehicle",
    description: "Daily driver",
    currency_code: "USD",
    active: true,
    archived_at: null,
    current_value_minor: 1_875_000,
    valued_on: "2026-07-26",
    created_at: "2026-07-26T12:00:00.000Z",
    updated_at: "2026-07-26T12:00:00.000Z",
  });
  const valuation = db.calls.find((call) =>
    call.sql.includes("INSERT INTO manual_asset_valuations"),
  );
  assert.deepEqual(valuation.params, [
    "asset-1",
    "2026-07-26",
    1_875_000,
    "USD",
  ]);
  assert.ok(
    db.calls.some(
      (call) =>
        call.sql.includes("INSERT INTO search_documents") &&
        call.sql.includes("'manual_asset'"),
    ),
  );
});

test("manual asset mutation archives safely and keeps the latest valuation", async () => {
  const db = fakePool(async (sql, params) => {
    if (sql.includes("WITH updated AS")) {
      assert.equal(params[0], "shared");
      assert.equal(params[1], "asset-1");
      assert.equal(params[10], true);
      assert.equal(params[11], false);
      return {
        rows: [
          {
            id: "asset-1",
            name: "Honda Civic",
            asset_type: "vehicle",
            description: null,
            currency_code: "USD",
            active: false,
            archived_at: "2026-07-26T12:00:00.000Z",
            current_value_minor: "1875000",
            valuation_currency_code: "USD",
            valued_on: "2026-07-26",
            created_at: "2026-07-25T12:00:00.000Z",
            updated_at: "2026-07-26T12:00:00.000Z",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);
  const archived = await repository.archiveManualAsset("shared", {
    assetId: "asset-1",
    userId: "admin",
  });
  assert.equal(archived.active, false);
  assert.equal(archived.archived_at, "2026-07-26T12:00:00.000Z");
  assert.equal(archived.current_value_minor, 1_875_000);
  const searchDelete = db.calls.find(
    (call) =>
      call.sql.includes("DELETE FROM search_documents") &&
      call.sql.includes("manual_asset"),
  );
  assert.deepEqual(searchDelete.params, ["shared", "asset-1"]);
});

test("manual asset value updates append a dated valuation atomically", async () => {
  const db = fakePool(async (sql, params) => {
    if (sql.includes("WITH updated AS")) {
      return {
        rows: [
          {
            id: "asset-1",
            name: "Honda Civic",
            asset_type: "vehicle",
            description: null,
            currency_code: "USD",
            active: true,
            current_value_minor: "1875000",
            valuation_currency_code: "USD",
            valued_on: "2026-07-26",
            created_at: "2026-07-25T12:00:00.000Z",
            updated_at: "2026-07-27T12:00:00.000Z",
          },
        ],
      };
    }
    if (
      sql.includes("INSERT INTO manual_asset_valuations") &&
      sql.includes("SELECT id")
    ) {
      assert.deepEqual(params, [
        "shared",
        "asset-1",
        "2026-07-27",
        1_825_000,
      ]);
      return { rows: [] };
    }
    if (
      sql.includes("FROM manual_assets a") &&
      sql.includes("latest.value_minor AS current_value_minor") &&
      !sql.includes("INSERT INTO search_documents")
    ) {
      return {
        rows: [
          {
            id: "asset-1",
            name: "Honda Civic",
            asset_type: "vehicle",
            description: null,
            currency_code: "USD",
            active: true,
            current_value_minor: "1825000",
            valuation_currency_code: "USD",
            valued_on: "2026-07-27",
            created_at: "2026-07-25T12:00:00.000Z",
            updated_at: "2026-07-27T12:00:00.000Z",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);
  const updated = await repository.updateManualAsset("shared", {
    assetId: "asset-1",
    valueMinor: 1_825_000,
    valuedOn: "2026-07-27",
  });
  assert.equal(updated.current_value_minor, 1_825_000);
  assert.equal(updated.valued_on, "2026-07-27");
  await assert.rejects(
    repository.updateManualAsset("shared", {
      assetId: "asset-1",
      valueMinor: 1_800_000,
    }),
    /valuedOn is required/,
  );
});

test("valuation reads support all assets or one asset and reject bad money", async () => {
  const db = fakePool(async (sql, params) => {
    if (sql.includes("SELECT v.*")) {
      assert.match(sql, /\(\$2::text IS NULL OR a\.id = \$2\)/);
      return {
        rows: [
          {
            asset_id: "asset-1",
            valued_on: "2026-07-26",
            value_minor: "1875000",
            currency_code: "USD",
          },
        ],
      };
    }
    if (sql.includes("INSERT INTO manual_asset_valuations")) {
      assert.deepEqual(params, [
        "shared",
        "asset-1",
        "2026-07-27",
        1_900_000,
        null,
      ]);
      return {
        rows: [
          {
            asset_id: "asset-1",
            valued_on: "2026-07-27",
            value_minor: "1900000",
            currency_code: "USD",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);
  const all = await repository.getManualAssetValuations("shared", {
    endOn: "2026-07-27",
  });
  assert.equal(all[0].value_minor, 1_875_000);
  const allCall = db.calls.find((call) => call.sql.includes("SELECT v.*"));
  assert.equal(allCall.params[1], null);

  const snapshot = await repository.takeManualAssetSnapshot(
    "shared",
    "asset-1",
    { valuedOn: "2026-07-27", valueMinor: 1_900_000 },
  );
  assert.equal(snapshot.value_minor, 1_900_000);
  await assert.rejects(
    repository.takeManualAssetSnapshot("shared", "asset-1", {
      valuedOn: "2026-02-31",
      valueMinor: -1,
    }),
    /valuedOn must be an ISO date/,
  );
});

test("holdings expose their effective retirement classification", async () => {
  const db = fakePool(async (sql) => {
    if (!sql.includes("FROM holdings h")) return { rows: [] };
    assert.match(sql, /a\.balance_group_override/);
    return {
      rows: [
        {
          id: "holding-1",
          account_id: "account-1",
          account_name: "Roth IRA",
          account_type: "investment",
          account_subtype: "roth",
          is_liability: false,
          balance_group_override: null,
          security_id: "security-1",
          security_name: "Total Market",
          ticker_symbol: "VTI",
          security_type: "equity",
          quantity: "10",
          vested_quantity: "4",
          institution_value_minor: "250000",
          vested_value_minor: "100000",
          institution_price_minor: "25000",
          cost_basis_minor: "200000",
          currency_code: "USD",
          close_price_as_of: "2026-07-26",
          as_of: "2026-07-26T12:00:00.000Z",
        },
      ],
    };
  });
  const repository = new PgFinanceRepository(db.pool);
  const [holding] = await repository.getHoldings("shared");
  assert.equal(holding.balance_group, "retirement");
  assert.equal(holding.vested_quantity, 4);
  assert.equal(holding.vested_value_minor, 100_000);
});

test("investment replacement and daily snapshots preserve Plaid vesting facts", async () => {
  const db = fakePool(async () => ({ rows: [], rowCount: 1 }));
  const repository = new PgFinanceRepository(db.pool);
  const providerHolding = {
    id: "holding-1",
    provider_account_id: "provider-account",
    provider_security_id: "provider-security",
    quantity: 10,
    vested_quantity: 4,
    institution_value_minor: 250_000,
    vested_value_minor: 100_000,
    institution_price_minor: 25_000,
    cost_basis_minor: null,
    currency_code: "USD",
  };

  await repository.replaceInvestments("connection-1", {
    holdings: [providerHolding],
    asOf: new Date("2026-07-28T12:00:00.000Z"),
  });
  await repository.takeDailySnapshots("shared", "2026-07-28");

  const holdingInsert = db.calls.find((call) =>
    call.sql.includes("INSERT INTO holdings"),
  );
  assert.match(
    holdingInsert.sql,
    /vested_quantity, institution_value_minor, vested_value_minor/,
  );
  assert.deepEqual(JSON.parse(holdingInsert.params[0]), [
    providerHolding,
  ]);

  const snapshotInsert = db.calls.find((call) =>
    call.sql.includes("INSERT INTO daily_holding_snapshots"),
  );
  assert.match(
    snapshotInsert.sql,
    /institution_price_minor, vested_quantity, vested_value_minor/,
  );
  assert.match(
    snapshotInsert.sql,
    /vested_quantity = EXCLUDED\.vested_quantity/,
  );
});

test("refunds inherit the original effective category and expose lineage", async () => {
  const db = fakePool(async (sql) => {
    if (!sql.includes("FROM transactions t")) return { rows: [] };
    assert.match(sql, /original_transaction/);
    assert.match(sql, /original_override/);
    return {
      rows: [
        {
          id: "refund-1",
          account_id: "account-1",
          account_name: "Checking",
          account_mask: "1234",
          institution_name: "Bank",
          merchant_name: "Store",
          normalized_merchant: "store",
          name: "Refund",
          category_primary: "INCOME",
          category_detailed: "INCOME_OTHER",
          effective_category_primary: "GENERAL_MERCHANDISE",
          effective_category_detailed: "GENERAL_MERCHANDISE_OTHER",
          amount_minor: "2500",
          currency_code: "USD",
          authorized_at: null,
          posted_on: "2026-07-26",
          pending: false,
          excluded_from_spending: false,
          effective_excluded_from_spending: false,
          is_fixed: false,
          original_transaction_id: "purchase-1",
          payment_channel: "online",
        },
      ],
    };
  });
  const repository = new PgFinanceRepository(db.pool);
  const result = await repository.listTransactions("shared");
  assert.equal(
    result.transactions[0].category_primary,
    "GENERAL_MERCHANDISE",
  );
  assert.equal(
    result.transactions[0].original_transaction_id,
    "purchase-1",
  );
});

test("Plaid modifications cannot erase a locally linked original transaction", async () => {
  let upsertSql = "";
  const db = fakePool(async (sql) => {
    if (sql.includes("INSERT INTO transactions")) upsertSql = sql;
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);
  await repository.applyTransactionSync({
    itemId: "item-1",
    modified: [
      {
        id: "refund-1",
        provider_account_id: "provider-account-1",
        provider_transaction_id: "provider-refund-1",
        name: "Refund",
        amount_minor: 2_500,
        currency_code: "USD",
        posted_on: "2026-07-26",
        pending: false,
        excluded_from_spending: false,
      },
    ],
    cursor: "cursor-1",
  });
  assert.match(
    upsertSql,
    /original_transaction_id = COALESCE\( EXCLUDED\.original_transaction_id, transactions\.original_transaction_id \)/,
  );
});

test("wealth migrations define each money currency column once", async () => {
  const initial = await readFile(
    fileURLToPath(new URL("../migrations/001_initial.sql", import.meta.url)),
    "utf8",
  );
  const wealth = await readFile(
    fileURLToPath(
      new URL("../migrations/003_wealth_model.sql", import.meta.url),
    ),
    "utf8",
  );
  assert.match(initial, /balance_group_override text/);
  assert.match(initial, /CREATE TABLE manual_assets/);
  assert.match(initial, /CREATE TABLE manual_asset_valuations/);
  assert.match(initial, /archived_at timestamptz/);
  assert.match(initial, /original_transaction_id text REFERENCES transactions/);
  assert.match(wealth, /ADD COLUMN IF NOT EXISTS balance_group_override/);
  assert.match(wealth, /CREATE TABLE IF NOT EXISTS manual_assets/);
  assert.match(
    wealth,
    /ADD COLUMN IF NOT EXISTS archived_at timestamptz/,
  );

  for (const [, table, body] of initial.matchAll(
    /CREATE TABLE(?: IF NOT EXISTS)? ([a-z_]+) \(([\s\S]*?)\n\);/g,
  )) {
    const declarations = body.match(/^\s*currency_code\s+/gm) ?? [];
    assert.ok(
      declarations.length <= 1,
      `${table} declares currency_code ${declarations.length} times`,
    );
  }
});
