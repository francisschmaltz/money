import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { PgFinanceRepository } from "../app/db/financeRepository.js";

function compact(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function parsedImport() {
  return {
    digest: "a".repeat(64),
    posted_start_on: "2026-07-02",
    posted_end_on: "2026-07-02",
    total_row_count: 1,
    accepted_row_count: 1,
    rejected_row_count: 0,
    warning_count: 0,
    transactions: [
      {
        id: "transaction-synthetic",
        provider_transaction_id: "apple-card-synthetic",
        provider_pending_transaction_id: null,
        merchant_name: "Example Merchant",
        normalized_merchant: "example merchant",
        name: "Synthetic purchase",
        normalized_name: "synthetic purchase",
        category_primary: "Shopping",
        category_detailed: "Shopping",
        amount_minor: -1234,
        currency_code: "USD",
        authorized_on: "2026-07-01",
        posted_on: "2026-07-02",
        pending: false,
        excluded_from_spending: false,
        cash_flow_role: "spending",
        payment_channel: "other",
        cardholder_name: "Synthetic User",
        source_transaction_type: "Purchase",
      },
    ],
  };
}

test("Apple Card import rolls back every write when audit persistence fails", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = compact(sql);
      calls.push({ sql: statement, params });
      if (statement.startsWith("SELECT provider_transaction_id")) {
        return { rows: [] };
      }
      if (statement.startsWith("INSERT INTO apple_card_imports")) {
        throw new Error("synthetic audit failure");
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = new PgFinanceRepository({
    async connect() {
      return client;
    },
    query: client.query.bind(client),
  });

  await assert.rejects(
    () =>
      repository.importAppleCardTransactions({
        workspaceId: "shared",
        parsed: parsedImport(),
        balanceMinor: 1_234,
        creditLimitMinor: 100_000,
        balanceAsOf: "2026-07-02",
        actorId: "user-synthetic",
      }),
    /synthetic audit failure/,
  );

  const transactionInsert = calls.find((call) =>
    call.sql.startsWith("INSERT INTO transactions"),
  );
  assert.ok(transactionInsert);
  assert.match(
    transactionInsert.sql,
    /source_transaction_type, cash_flow_role/,
  );
  assert.match(
    transactionInsert.sql,
    /cash_flow_role = EXCLUDED\.cash_flow_role/,
  );
  assert.ok(
    calls.some((call) =>
      call.sql.startsWith("INSERT INTO daily_account_snapshots"),
    ),
  );
  assert.equal(calls.at(-1).sql, "ROLLBACK");
  assert.equal(
    calls.some((call) => call.sql === "COMMIT"),
    false,
  );
});

test("Apple Card migration moves shared relationships to generic connections", async () => {
  const migration = await readFile(
    new URL("../migrations/009_apple_card_csv.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE finance_connections/);
  assert.match(
    migration,
    /ALTER TABLE accounts RENAME COLUMN item_id TO connection_id/,
  );
  assert.match(
    migration,
    /ALTER TABLE sync_runs RENAME COLUMN item_id TO connection_id/,
  );
  assert.match(
    migration,
    /provider IN \('plaid', 'apple_card'\)/,
  );
  assert.match(
    migration,
    /ingestion_method IN \('plaid', 'csv', 'financekit'\)/,
  );
  assert.match(migration, /ADD COLUMN authorized_on date/);
  assert.match(migration, /ADD COLUMN cardholder_name text/);
  assert.match(migration, /CREATE TABLE apple_card_imports/);
  const importsTable = migration.match(
    /CREATE TABLE apple_card_imports \(([\s\S]*?)\n\);/,
  )?.[1];
  assert.ok(importsTable);
  assert.doesNotMatch(
    importsTable,
    /raw_csv|csv_body|merchant_name|cardholder_name|amount_minor/,
  );
});
