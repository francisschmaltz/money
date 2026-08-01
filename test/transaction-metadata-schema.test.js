import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PgFinanceRepository } from "../app/db/financeRepository.js";

function fakePool(handler = async () => ({ rows: [] })) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(compact)) {
        return { rows: [], rowCount: 0 };
      }
      return (await handler(compact, params)) ?? {
        rows: [],
        rowCount: 0,
      };
    },
    release() {},
  };
  return {
    calls,
    pool: {
      connect: async () => client,
      query: client.query.bind(client),
    },
  };
}

test("transaction metadata migration keeps user metadata separate and workspace scoped", async () => {
  const migration = await readFile(
    fileURLToPath(
      new URL(
        "../migrations/006_transaction_metadata.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  assert.match(
    migration,
    /ALTER TABLE transactions\s+ADD COLUMN IF NOT EXISTS normalized_name text/,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS transaction_metadata/,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS transaction_tags/,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS transaction_tag_assignments/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \(workspace_id, transaction_id\)\s+REFERENCES transactions \(workspace_id, id\)/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \(workspace_id, tag_id\)\s+REFERENCES transaction_tags \(workspace_id, id\)/,
  );
  assert.match(
    migration,
    /UNIQUE \(workspace_id, normalized_name\)/,
  );
  assert.match(
    migration,
    /PARTITION BY workspace_id, transaction_id[\s\S]*ORDER BY updated_at DESC, created_at DESC, id DESC/,
  );
  assert.match(
    migration,
    /PARTITION BY workspace_id, normalized_merchant[\s\S]*ORDER BY updated_at DESC, created_at DESC, id DESC/,
  );
  assert.match(
    migration,
    /categorization_overrides_workspace_transaction_unique[\s\S]*WHERE transaction_id IS NOT NULL/,
  );
  assert.match(
    migration,
    /categorization_overrides_workspace_merchant_unique[\s\S]*WHERE transaction_id IS NULL\s+AND normalized_merchant IS NOT NULL/,
  );
  assert.match(
    migration,
    /transactions_normalized_name_trgm_idx[\s\S]*gin_trgm_ops/,
  );
  assert.match(
    migration,
    /transaction_metadata_display_name_trgm_idx[\s\S]*gin_trgm_ops/,
  );
});

test("transaction notes are versioned, searchable metadata", async () => {
  const migration = await readFile(
    fileURLToPath(
      new URL(
        "../migrations/024_transaction_notes.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  assert.match(migration, /ADD COLUMN note text/);
  assert.match(
    migration,
    /ADD COLUMN note_version integer NOT NULL DEFAULT 0/,
  );
  assert.match(
    migration,
    /ADD COLUMN note_updated_by text REFERENCES users\(id\)/,
  );
  assert.match(
    migration,
    /note = btrim\(note\)[\s\S]*char_length\(note\) BETWEEN 1 AND 2000/,
  );
  assert.match(
    migration,
    /transaction_metadata_note_trgm_idx[\s\S]*gin_trgm_ops/,
  );
});

test("Plan month overrides are nullable month starts on transaction metadata", async () => {
  const migration = await readFile(
    fileURLToPath(
      new URL(
        "../migrations/027_transaction_budget_month.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS budget_month_on date/,
  );
  assert.match(
    migration,
    /budget_month_on IS NULL\s+OR budget_month_on =\s+date_trunc\('month', budget_month_on\)::date/,
  );
  assert.match(
    migration,
    /ON transaction_metadata \(workspace_id, budget_month_on\)\s+WHERE budget_month_on IS NOT NULL/,
  );
});

test("transaction provider locations are private JSON and active Plaid cursors are rebuilt", async () => {
  const migration = await readFile(
    fileURLToPath(
      new URL(
        "../migrations/031_transaction_provider_location.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  assert.match(
    migration,
    /ADD COLUMN provider_location jsonb/,
  );
  assert.match(
    migration,
    /jsonb_typeof\(provider_location\) = 'object'/,
  );
  assert.match(
    migration,
    /UPDATE plaid_connection_details AS details[\s\S]*SET transactions_cursor = NULL/,
  );
  assert.match(
    migration,
    /connection\.provider = 'plaid'[\s\S]*connection\.ingestion_method = 'plaid'[\s\S]*connection\.status = 'active'/,
  );
});

test("transaction sync inserts and updates normalized provider names", async () => {
  const db = fakePool();
  const repository = new PgFinanceRepository(db.pool);

  await repository.applyTransactionSync({
    itemId: "item-1",
    added: [
      {
        id: "transaction-1",
        provider_account_id: "provider-account-1",
        provider_transaction_id: "provider-transaction-1",
        merchant_name: "Café",
        normalized_merchant: "cafe",
        name: "CAFE #48192",
        normalized_name: "cafe",
        amount_minor: -1_234,
        currency_code: "USD",
        posted_on: "2026-07-27",
        pending: false,
        excluded_from_spending: false,
        provider_location: {
          address: "123 Main St",
          city: "New York",
          region: "NY",
          postal_code: "10001",
          country: "US",
          lat: 40.7505,
          lon: -73.9934,
          store_number: "42",
        },
      },
    ],
    cursor: "cursor-1",
  });

  const insert = db.calls.find((call) =>
    call.sql.includes("INSERT INTO transactions"),
  );
  assert.ok(insert);
  assert.match(insert.sql, /name, normalized_name, category_primary/);
  assert.match(
    insert.sql,
    /normalized_name = EXCLUDED\.normalized_name/,
  );
  assert.equal(JSON.parse(insert.params[0])[0].normalized_name, "cafe");
  assert.match(insert.sql, /payment_channel, provider_location/);
  assert.match(
    insert.sql,
    /provider_location = EXCLUDED\.provider_location/,
  );
  assert.deepEqual(
    JSON.parse(insert.params[0])[0].provider_location,
    {
      address: "123 Main St",
      city: "New York",
      region: "NY",
      postal_code: "10001",
      country: "US",
      lat: 40.7505,
      lon: -73.9934,
      store_number: "42",
    },
  );
});

test("transaction sync clears a provider location when Plaid removes it", async () => {
  const db = fakePool();
  const repository = new PgFinanceRepository(db.pool);

  await repository.applyTransactionSync({
    itemId: "item-1",
    modified: [
      {
        id: "transaction-1",
        provider_account_id: "provider-account-1",
        provider_transaction_id: "provider-transaction-1",
        name: "Store",
        normalized_name: "store",
        amount_minor: -1_234,
        currency_code: "USD",
        posted_on: "2026-07-27",
        pending: false,
        excluded_from_spending: false,
        provider_location: null,
      },
    ],
    cursor: "cursor-2",
  });

  const insert = db.calls.find((call) =>
    call.sql.includes("INSERT INTO transactions"),
  );
  assert.equal(
    JSON.parse(insert.params[0])[0].provider_location,
    null,
  );
  assert.match(
    insert.sql,
    /provider_location = EXCLUDED\.provider_location/,
  );
});

test("repository transaction reads include provider location only when requested", async () => {
  const row = {
    id: "transaction-1",
    account_id: "account-1",
    name: "Store",
    amount_minor: "-1234",
    currency_code: "USD",
    posted_on: "2026-07-27",
    pending: false,
    provider_location: {
      address: "123 Main St",
      lat: 40.7505,
      lon: -73.9934,
    },
  };
  const db = fakePool(async (sql) =>
    sql.includes("FROM transactions t")
      ? { rows: [row], rowCount: 1 }
      : { rows: [], rowCount: 0 },
  );
  const repository = new PgFinanceRepository(db.pool);

  const ordinary = await repository.getTransaction(
    "workspace-1",
    row.id,
  );
  const selected = await repository.getTransaction(
    "workspace-1",
    row.id,
    { includeProviderLocation: true },
  );

  assert.equal(Object.hasOwn(ordinary, "provider_location"), false);
  assert.deepEqual(selected.provider_location, row.provider_location);
});

test("transaction sync carries a pending note to its posted replacement before deletion", async () => {
  const db = fakePool();
  const repository = new PgFinanceRepository(db.pool);

  await repository.applyTransactionSync({
    itemId: "item-1",
    added: [
      {
        id: "posted-transaction",
        provider_account_id: "provider-account-1",
        provider_transaction_id: "posted-provider-id",
        provider_pending_transaction_id: "pending-provider-id",
        name: "Restaurant",
        normalized_name: "restaurant",
        amount_minor: -4_200,
        currency_code: "USD",
        posted_on: "2026-07-27",
        pending: false,
        excluded_from_spending: false,
      },
    ],
    cursor: "cursor-1",
  });

  const copyIndex = db.calls.findIndex((call) =>
    call.sql.includes("INSERT INTO transaction_metadata"),
  );
  const deleteIndex = db.calls.findIndex((call) =>
    call.sql.includes("DELETE FROM transactions pending"),
  );
  assert.ok(copyIndex >= 0);
  assert.ok(deleteIndex > copyIndex);
  assert.match(
    db.calls[copyIndex].sql,
    /pending_metadata\.note[\s\S]*pending_metadata\.note_version/,
  );
  assert.match(
    db.calls[copyIndex].sql,
    /WHERE transaction_metadata\.note IS NULL[\s\S]*transaction_metadata\.note_version = 0/,
  );
  assert.deepEqual(db.calls[copyIndex].params, [
    ["pending-provider-id"],
  ]);
});
