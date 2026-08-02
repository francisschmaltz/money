import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PgFinanceRepository } from "../app/db/financeRepository.js";

const migrationUrl = new URL(
  "../migrations/036_pending_edit_field_clocks.sql",
  import.meta.url,
);

function fakePool(handler = async () => ({ rows: [] })) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(compact)) {
        return { rows: [], rowCount: 0 };
      }
      return (await handler(compact, params, calls)) ?? {
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

test("pending edit clocks are stored independently for every handoff field", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  for (const column of [
    "display_name_updated_at",
    "tags_updated_at",
    "budget_month_updated_at",
    "category_updated_at",
    "excluded_from_spending_updated_at",
    "cash_flow_role_updated_at",
    "is_fixed_updated_at",
  ]) {
    assert.match(migration, new RegExp(`${column} timestamptz`));
  }
  for (const column of [
    "category_overridden",
    "excluded_from_spending_overridden",
    "cash_flow_role_overridden",
    "is_fixed_overridden",
  ]) {
    assert.match(
      migration,
      new RegExp(`${column} boolean NOT NULL DEFAULT false`),
    );
  }
  assert.match(
    migration,
    /display_name_updated_at = CASE[\s\S]*display_name_overridden THEN updated_at/,
  );
  assert.match(
    migration,
    /category_updated_at = CASE[\s\S]*category_primary IS NOT NULL[\s\S]*THEN updated_at/,
  );
});

test("linked handoff compares field clocks instead of row updated_at", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("AS handoff_safe")) {
      return {
        rows: [
          {
            workspace_id: "shared",
            pending_id: "pending-1",
            posted_id: "posted-1",
            handoff_safe: true,
            copy_splits: false,
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  await repository.applyTransactionSync({
    itemId: "item-1",
    added: [
      {
        id: "posted-1",
        provider_account_id: "provider-account-1",
        provider_transaction_id: "provider-posted-1",
        provider_pending_transaction_id: "provider-pending-1",
        name: "Store",
        normalized_name: "store",
        amount_minor: -1000,
        currency_code: "USD",
        posted_on: "2026-08-01",
        pending: false,
        excluded_from_spending: false,
      },
    ],
    cursor: "cursor-1",
  });

  const metadata = db.calls.find(
    (call) =>
      call.sql.includes("INSERT INTO transaction_metadata") &&
      call.sql.includes("pending_metadata.display_name_updated_at"),
  );
  assert.ok(metadata);
  assert.match(
    metadata.sql,
    /transaction_metadata\.display_name_updated_at[\s\S]*EXCLUDED\.display_name_updated_at/,
  );
  assert.match(
    metadata.sql,
    /transaction_metadata\.tags_updated_at[\s\S]*EXCLUDED\.tags_updated_at/,
  );
  assert.match(
    metadata.sql,
    /transaction_metadata\.budget_month_updated_at[\s\S]*EXCLUDED\.budget_month_updated_at/,
  );

  const categorization = db.calls.find(
    (call) =>
      call.sql.includes("INSERT INTO categorization_overrides") &&
      call.sql.includes("pending_override.category_overridden"),
  );
  assert.ok(categorization);
  assert.match(
    categorization.sql,
    /EXCLUDED\.category_overridden = true[\s\S]*categorization_overrides\.category_updated_at/,
  );
  assert.match(
    categorization.sql,
    /EXCLUDED\.cash_flow_role_overridden = true[\s\S]*categorization_overrides\.cash_flow_role_updated_at/,
  );
  assert.doesNotMatch(
    categorization.sql,
    /categorization_overrides\.updated_at <=\s*EXCLUDED\.updated_at/,
  );
});

test("recovery attachment lets each newer field win independently", async () => {
  const recovery = {
    id: "recovery-1",
    workspace_id: "shared",
    account_id: "account-1",
    pending_transaction_id: "pending-1",
    provider_pending_transaction_id: "provider-pending-1",
    pending_created_at: "2026-08-01T08:00:00.000Z",
    pending_updated_at: "2026-08-01T13:00:00.000Z",
    recovered_at: "2026-08-01T14:00:00.000Z",
    updated_at: "2026-08-01T14:00:00.000Z",
    user_state: {
      metadata: {
        display_name: null,
        display_name_overridden: true,
        display_name_updated_at: "2026-08-01T10:00:00.000Z",
        tags_overridden: true,
        tags_updated_at: "2026-08-01T12:00:00.000Z",
        note_version: 0,
        budget_month_overridden: false,
        updated_at: "2026-08-01T13:00:00.000Z",
      },
      tags: [],
      categorization_override: {
        category_primary: "Groceries",
        category_overridden: true,
        category_updated_at: "2026-08-01T10:00:00.000Z",
        cash_flow_role: "obligation",
        cash_flow_role_overridden: true,
        cash_flow_role_updated_at: "2026-08-01T12:00:00.000Z",
        updated_at: "2026-08-01T13:00:00.000Z",
      },
    },
    provider_facts: {},
  };
  const db = fakePool(async (sql) => {
    if (
      sql.includes("FROM unmatched_pending_transaction_edits") &&
      sql.includes("FOR UPDATE")
    ) {
      return { rows: [recovery] };
    }
    if (sql.includes("FROM transactions target")) {
      return {
        rows: [
          {
            id: "posted-1",
            workspace_id: "shared",
            account_id: "account-1",
            pending: false,
            amount_minor: -1000,
            currency_code: "USD",
            normalized_name: "store",
            normalized_merchant: "store",
            display_name_overridden: true,
            display_name_updated_at: "2026-08-01T11:00:00.000Z",
            tags_overridden: true,
            tags_updated_at: "2026-08-01T09:00:00.000Z",
            metadata_updated_at: "2026-08-01T14:00:00.000Z",
            override_id: "override-1",
            category_overridden: true,
            category_updated_at: "2026-08-01T11:00:00.000Z",
            cash_flow_role_overridden: true,
            cash_flow_role_updated_at: "2026-08-01T09:00:00.000Z",
            override_updated_at: "2026-08-01T14:00:00.000Z",
            target_split_count: 0,
          },
        ],
      };
    }
    if (
      sql.startsWith("UPDATE unmatched_pending_transaction_edits") &&
      sql.includes("attached_transaction_id")
    ) {
      return {
        rows: [
          {
            ...recovery,
            attached_transaction_id: "posted-1",
            attached_at: "2026-08-01T15:00:00.000Z",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  await repository.attachPendingEditRecovery("shared", {
    recoveryId: "recovery-1",
    transactionId: "posted-1",
    userId: "user-1",
  });

  const metadata = db.calls.find(
    (call) =>
      call.sql.includes("INSERT INTO transaction_metadata") &&
      call.sql.includes("display_name_updated_at"),
  );
  assert.ok(metadata);
  assert.equal(metadata.params[3], false, "newer posted name wins");
  assert.equal(metadata.params[5], true, "newer pending tag clear wins");
  assert.ok(
    db.calls.some((call) =>
      call.sql.startsWith("DELETE FROM transaction_tag_assignments"),
    ),
  );
  assert.equal(
    db.calls.some((call) =>
      call.sql.startsWith("INSERT INTO transaction_tag_assignments"),
    ),
    false,
    "an explicit empty tag set remains empty",
  );

  const categorization = db.calls.find(
    (call) =>
      call.sql.includes("INSERT INTO categorization_overrides") &&
      call.sql.includes("category_updated_at"),
  );
  assert.ok(categorization);
  assert.equal(
    categorization.params[6],
    false,
    "newer posted category wins",
  );
  assert.equal(
    categorization.params[12],
    true,
    "newer pending role wins despite a newer sibling row edit",
  );
});

test("unmatched snapshot locks pending parents before reading child state", async () => {
  const db = fakePool();
  const repository = new PgFinanceRepository(db.pool);

  await repository.applyTransactionSync({
    itemId: "item-1",
    removedProviderIds: ["provider-pending-1"],
    cursor: "cursor-2",
  });

  const lockIndex = db.calls.findIndex(
    (call) =>
      call.sql.startsWith("SELECT pending.id FROM transactions pending") &&
      call.sql.includes("FOR UPDATE OF pending"),
  );
  const snapshotIndex = db.calls.findIndex((call) =>
    call.sql.includes("INSERT INTO unmatched_pending_transaction_edits"),
  );
  const removalIndex = db.calls.findIndex((call) =>
    call.sql.startsWith("DELETE FROM transactions removed"),
  );

  assert.ok(lockIndex >= 0);
  assert.ok(snapshotIndex > lockIndex);
  assert.ok(removalIndex > snapshotIndex);
  assert.deepEqual(db.calls[lockIndex].params, [
    ["provider-pending-1"],
    "item-1",
    [],
  ]);
});
