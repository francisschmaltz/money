import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PgFinanceRepository } from "../app/db/financeRepository.js";

const migrationUrl = new URL(
  "../migrations/037_pending_split_and_recurring_intent.sql",
  import.meta.url,
);
const financeRepositoryUrl = new URL(
  "../app/db/financeRepository.js",
  import.meta.url,
);
const planningRepositoryUrl = new URL(
  "../app/db/planningRepository.js",
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

function recoveryFixture(overrides = {}) {
  return {
    id: "recovery-1",
    workspace_id: "shared",
    account_id: "account-1",
    pending_transaction_id: "pending-1",
    provider_pending_transaction_id: "provider-pending-1",
    pending_created_at: "2026-08-01T08:00:00.000Z",
    pending_updated_at: "2026-08-01T12:00:00.000Z",
    recovered_at: "2026-08-01T13:00:00.000Z",
    updated_at: "2026-08-01T13:00:00.000Z",
    user_state: {
      splits: [],
      split_overridden: true,
      split_updated_at: "2026-08-01T11:00:00.000Z",
      split_version: 2,
      split_needs_review: false,
    },
    provider_facts: {
      amount_minor: -1000,
      currency_code: "USD",
    },
    attached_transaction_id: null,
    attached_at: null,
    dismissed_at: null,
    ...overrides,
  };
}

function postedTarget(overrides = {}) {
  return {
    id: "posted-1",
    workspace_id: "shared",
    account_id: "account-1",
    pending: false,
    amount_minor: -1000,
    currency_code: "USD",
    normalized_name: "merchant charge",
    normalized_merchant: "merchant",
    split_version: 1,
    split_overridden: false,
    split_updated_at: null,
    target_split_count: 0,
    ...overrides,
  };
}

test("split and recurring lifecycle state has an independent durable clock", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const financeRepository = await readFile(financeRepositoryUrl, "utf8");
  const planningRepository = await readFile(planningRepositoryUrl, "utf8");

  assert.match(
    migration,
    /ADD COLUMN split_overridden boolean NOT NULL DEFAULT false/,
  );
  assert.match(migration, /ADD COLUMN split_updated_at timestamptz/);
  assert.match(
    migration,
    /ADD COLUMN recurring_needs_review boolean NOT NULL DEFAULT false/,
  );
  assert.match(
    migration,
    /UPDATE transactions parent[\s\S]*split_overridden = true[\s\S]*max\(split\.updated_at\)/,
  );
  assert.match(
    planningRepository,
    /split_needs_review = false,\s+split_overridden = true,\s+split_updated_at = now\(\)/,
  );
  assert.match(
    financeRepository,
    /WHEN candidate\.split_overridden = true[\s\S]*'splits', candidate\.split_state[\s\S]*'split_updated_at', candidate\.split_updated_at/,
  );
});

test("an explicit recovered split clear deletes target lines and stays empty", async () => {
  const recovery = recoveryFixture();
  const db = fakePool(async (sql) => {
    if (
      sql.includes("FROM unmatched_pending_transaction_edits") &&
      sql.includes("FOR UPDATE")
    ) {
      return { rows: [recovery] };
    }
    if (sql.includes("FROM transactions target")) {
      return { rows: [postedTarget()] };
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
            attached_at: "2026-08-01T14:00:00.000Z",
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

  assert.ok(
    db.calls.some((call) =>
      call.sql.startsWith("DELETE FROM transaction_splits"),
    ),
  );
  assert.equal(
    db.calls.some((call) =>
      call.sql.startsWith("INSERT INTO transaction_splits"),
    ),
    false,
  );
  const intentUpdate = db.calls.find(
    (call) =>
      call.sql.startsWith("UPDATE transactions") &&
      call.sql.includes("split_overridden = true"),
  );
  assert.ok(intentUpdate);
  assert.equal(intentUpdate.params[2], false);
  assert.equal(intentUpdate.params[3], 2);
  assert.equal(intentUpdate.params[4], "2026-08-01T11:00:00.000Z");
});

test("a newer posted split clear wins over recovered pending lines", async () => {
  const recovery = recoveryFixture({
    user_state: {
      splits: [
        { line_index: 0, category: "A", amount_minor: -600 },
        { line_index: 1, category: "B", amount_minor: -400 },
      ],
      split_overridden: true,
      split_updated_at: "2026-08-01T11:00:00.000Z",
      split_version: 2,
    },
  });
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
          postedTarget({
            split_overridden: true,
            split_updated_at: "2026-08-01T11:01:00.000Z",
          }),
        ],
      };
    }
    if (
      sql.startsWith("UPDATE unmatched_pending_transaction_edits") &&
      sql.includes("attached_transaction_id")
    ) {
      return { rows: [{ ...recovery, attached_transaction_id: "posted-1" }] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  await repository.attachPendingEditRecovery("shared", {
    recoveryId: "recovery-1",
    transactionId: "posted-1",
  });

  assert.equal(
    db.calls.some((call) =>
      call.sql.startsWith("DELETE FROM transaction_splits"),
    ),
    false,
  );
});

test("unsafe recovered recurring intent is retained inactive for review", async () => {
  const recovery = recoveryFixture({
    user_state: {
      recurring_patterns: [
        {
          id: "pattern-1",
          active: true,
          updated_at: "2026-08-01T11:00:00.000Z",
        },
      ],
    },
    provider_facts: {
      amount_minor: 1000,
      currency_code: "USD",
    },
  });
  const db = fakePool(async (sql) => {
    if (
      sql.includes("FROM unmatched_pending_transaction_edits") &&
      sql.includes("FOR UPDATE")
    ) {
      return { rows: [recovery] };
    }
    if (sql.includes("FROM transactions target")) {
      return { rows: [postedTarget({ amount_minor: 1000 })] };
    }
    if (
      sql.startsWith("UPDATE recurring_pattern_rules rule") &&
      sql.includes("RETURNING rule.id")
    ) {
      return { rows: [{ id: "pattern-1" }] };
    }
    if (
      sql.startsWith("UPDATE unmatched_pending_transaction_edits") &&
      sql.includes("attached_transaction_id")
    ) {
      return { rows: [{ ...recovery, attached_transaction_id: "posted-1" }] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  await repository.attachPendingEditRecovery("shared", {
    recoveryId: "recovery-1",
    transactionId: "posted-1",
  });

  assert.equal(
    db.calls.some(
      (call) =>
        call.sql.includes("anchor_amount_minor = abs") &&
        call.sql.includes("UPDATE recurring_pattern_rules rule"),
    ),
    false,
  );
  assert.ok(
    db.calls.some(
      (call) =>
        call.sql.startsWith("UPDATE transactions") &&
        call.sql.includes("recurring_needs_review = true"),
    ),
  );
});

test("linked handoff copies explicit clears and gates recurring re-anchor", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("AS handoff_safe")) {
      return {
        rows: [
          {
            workspace_id: "shared",
            pending_id: "pending-1",
            posted_id: "posted-1",
            handoff_safe: true,
            copy_splits: true,
            recurring_safe: false,
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
        name: "Refund",
        normalized_name: "refund",
        amount_minor: 1000,
        currency_code: "USD",
        posted_on: "2026-08-01",
        pending: false,
        excluded_from_spending: false,
      },
    ],
    cursor: "cursor-1",
  });

  const pairRead = db.calls.find((call) =>
    call.sql.includes("AS handoff_safe"),
  );
  assert.match(
    pairRead.sql,
    /pending\.split_overridden = true[\s\S]*posted\.split_updated_at[\s\S]*pending\.split_updated_at/,
  );
  assert.match(
    pairRead.sql,
    /posted\.currency_code = pending\.currency_code[\s\S]*AS recurring_safe/,
  );
  assert.match(pairRead.sql, /posted\.amount_minor < 0/);
  const safeReanchor = db.calls.find(
    (call) =>
      call.sql.includes("UPDATE recurring_pattern_rules rule") &&
      call.sql.includes("account_id = posted.account_id"),
  );
  assert.ok(safeReanchor);
  assert.match(safeReanchor.sql, /pair\.recurring_safe = true/);
  assert.match(
    safeReanchor.sql,
    /rule\.currency_code = posted\.currency_code/,
  );
  assert.match(safeReanchor.sql, /match_field = CASE/);
  assert.match(safeReanchor.sql, /currency_code = posted\.currency_code/);
  const occurrenceCopy = db.calls.find((call) =>
    call.sql.includes("INSERT INTO recurring_stream_transactions"),
  );
  assert.match(
    occurrenceCopy.sql,
    /NOT EXISTS[\s\S]*rule\.currency_code <> posted\.currency_code/,
  );
  assert.ok(
    db.calls.some(
      (call) =>
        call.sql.includes("UPDATE transactions posted") &&
        call.sql.includes("recurring_needs_review = true"),
    ),
  );
  const splitUpdate = db.calls.find(
    (call) =>
      call.sql.includes("UPDATE transactions posted") &&
      call.sql.includes("split_overridden = true"),
  );
  assert.ok(splitUpdate);
  assert.match(splitUpdate.sql, /GREATEST\([\s\S]*\) \+ 1/);
  assert.match(splitUpdate.sql, /split_updated_at = COALESCE/);
});

test("repeating an attachment to the same target is idempotent", async () => {
  const recovery = recoveryFixture({
    attached_transaction_id: "posted-1",
    attached_at: "2026-08-01T14:00:00.000Z",
  });
  const db = fakePool(async (sql) => {
    if (
      sql.includes("FROM unmatched_pending_transaction_edits") &&
      sql.includes("FOR UPDATE")
    ) {
      return { rows: [recovery] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.attachPendingEditRecovery("shared", {
    recoveryId: "recovery-1",
    transactionId: "posted-1",
  });

  assert.equal(result.attached_transaction_id, "posted-1");
  assert.equal(
    db.calls.some((call) => call.sql.includes("FROM transactions target")),
    false,
  );
});

test("repeating a dismissal returns the existing resolution", async () => {
  const recovery = recoveryFixture({
    dismissed_at: "2026-08-01T14:00:00.000Z",
  });
  const db = fakePool(async (sql) => {
    if (
      sql.startsWith("UPDATE unmatched_pending_transaction_edits") &&
      sql.includes("dismissed_at = now()")
    ) {
      return { rows: [] };
    }
    if (
      sql.includes("FROM unmatched_pending_transaction_edits") &&
      sql.includes("dismissed_at IS NOT NULL")
    ) {
      return { rows: [recovery] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.dismissPendingEditRecovery("shared", {
    recoveryId: "recovery-1",
  });

  assert.equal(result.id, "recovery-1");
  assert.ok(result.dismissed_at);
});
