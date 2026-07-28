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
