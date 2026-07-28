import test from "node:test";
import assert from "node:assert/strict";

import { PgFinanceRepository } from "../app/db/financeRepository.js";

function fakePool(handler) {
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

function ruleRow(overrides = {}) {
  return {
    id: "rule-apple",
    workspace_id: "shared",
    match_field: "normalized_name",
    match_mode: "exact",
    match_value: "AAPL SRV",
    normalized_match_value: "aapl srv",
    display_name: "Apple Services",
    category_primary: "Subscriptions",
    tags: ["subscription"],
    enabled: true,
    created_by: "user-1",
    updated_by: "user-1",
    created_at: "2026-07-27T12:00:00.000Z",
    updated_at: "2026-07-27T12:00:00.000Z",
    matched_transaction_count: 1,
    ...overrides,
  };
}

function transactionRow(overrides = {}) {
  return {
    id: "transaction-1",
    account_id: "account-1",
    account_name: "Checking",
    account_mask: "1234",
    institution_name: "Bank",
    merchant_name: "APPLE",
    normalized_merchant: "apple",
    name: "AAPL SRV",
    normalized_name: "aapl srv",
    display_name: "Manual Apple",
    tags: [],
    category_primary: "Shopping",
    effective_category_primary: "Manual Category",
    category_detailed: null,
    effective_category_detailed: null,
    amount_minor: -1_299,
    currency_code: "USD",
    authorized_at: null,
    posted_on: "2026-07-27",
    pending: false,
    excluded_from_spending: false,
    is_fixed: false,
    original_transaction_id: null,
    payment_channel: "online",
    ...overrides,
  };
}

test("rule list counts deterministic exact-or-contains winners", async () => {
  const db = fakePool(async (sql) => {
    if (sql.startsWith("WITH winning_rules AS")) {
      return { rows: [ruleRow()] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const rules = await repository.listTransactionCleanupRules("shared");

  assert.equal(rules.length, 1);
  assert.equal(rules[0].match_value, "AAPL SRV");
  assert.equal(rules[0].match_mode, "exact");
  assert.equal(rules[0].normalized_match_value, "aapl srv");
  assert.deepEqual(rules[0].tags, ["subscription"]);
  assert.equal(rules[0].matched_transaction_count, 1);
  const query = db.calls.find((call) =>
    call.sql.startsWith("WITH winning_rules AS"),
  );
  assert.match(
    query.sql,
    /transaction_cleanup_rule_matches\(\s*rule\.match_field,\s*rule\.match_mode,\s*rule\.normalized_match_value,\s*t\.normalized_merchant,\s*t\.normalized_name\s*\)/,
  );
  assert.match(
    query.sql,
    /\(rule\.match_mode = 'exact'\) DESC/,
  );
  assert.match(
    query.sql,
    /length\(rule\.normalized_match_value\) DESC/,
  );
  assert.match(query.sql, /t\.pending = false/);
});

test("creating a rule stores match mode and refreshes contained matches", async () => {
  const db = fakePool(async (sql, params) => {
    if (sql.includes("INSERT INTO transaction_cleanup_rules")) {
      return {
        rows: [
          ruleRow({
            match_field: params[2],
            match_mode: params[3],
            match_value: params[4],
            normalized_match_value: params[5],
          }),
        ],
      };
    }
    if (sql.startsWith("SELECT id FROM transactions")) {
      return params[3] === "aapl srv"
        ? { rows: [{ id: "transaction-1" }] }
        : { rows: [] };
    }
    if (sql.startsWith("SELECT t.id FROM transactions t")) {
      return { rows: [{ id: "transaction-1" }] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.createTransactionCleanupRule("shared", {
    id: "rule-apple",
    matchField: "normalized_name",
    matchMode: "contains",
    matchValue: "AAPL SRV",
    normalizedMatchValue: "aapl srv",
    displayName: "Apple Services",
    categoryPrimary: "Subscriptions",
    tags: ["subscription"],
    userId: "user-1",
  });

  assert.equal(result.id, "rule-apple");
  assert.equal(result.matched_transaction_count, 1);
  const insert = db.calls.find((call) =>
    call.sql.includes("INSERT INTO transaction_cleanup_rules"),
  );
  assert.deepEqual(insert.params.slice(2, 6), [
    "normalized_name",
    "contains",
    "AAPL SRV",
    "aapl srv",
  ]);
  assert.equal(insert.params[8], '["subscription"]');
  const match = db.calls.find((call) =>
    call.sql.startsWith("SELECT id FROM transactions"),
  );
  assert.match(
    match.sql,
    /transaction_cleanup_rule_matches\(\s*\$2,\s*\$3,\s*\$4,\s*normalized_merchant,\s*normalized_name\s*\)/,
  );
  assert.deepEqual(match.params.slice(1), [
    "normalized_name",
    "contains",
    "aapl srv",
  ]);
  const winning = db.calls.find((call) =>
    call.sql.startsWith("SELECT t.id FROM transactions t"),
  );
  assert.match(winning.sql, /t\.pending = false/);
  assert.ok(
    db.calls.some(
      (call) =>
        call.sql.includes("INSERT INTO search_documents") &&
        call.params[1]?.includes("transaction-1"),
    ),
  );
});

test("editing and deleting a rule refresh old and new match sets", async () => {
  let phase = "update";
  const oldRule = ruleRow();
  const nextRule = ruleRow({
    match_field: "normalized_merchant",
    match_mode: "contains",
    match_value: "APPLE",
    normalized_match_value: "apple",
    tags: [],
    updated_at: "2026-07-27T13:00:00.000Z",
  });
  const db = fakePool(async (sql, params) => {
    if (
      sql.includes("FROM transaction_cleanup_rules") &&
      sql.includes("FOR UPDATE")
    ) {
      return { rows: [phase === "update" ? oldRule : nextRule] };
    }
    if (sql.startsWith("UPDATE transaction_cleanup_rules")) {
      return { rows: [nextRule] };
    }
    if (sql.startsWith("SELECT id FROM transactions")) {
      return {
        rows: [
          {
            id: params[3] === "aapl srv"
              ? "transaction-old"
              : "transaction-new",
          },
        ],
      };
    }
    if (sql.startsWith("SELECT t.id FROM transactions t")) {
      return { rows: [{ id: "transaction-new" }] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const updated = await repository.updateTransactionCleanupRule(
    "shared",
    {
      ruleId: "rule-apple",
      matchField: "normalized_merchant",
      matchMode: "contains",
      matchValue: "APPLE",
      normalizedMatchValue: "apple",
      displayName: "Apple Services",
      categoryPrimary: "Subscriptions",
      tags: [],
      enabled: true,
      userId: "user-2",
    },
  );

  assert.equal(updated.match_field, "normalized_merchant");
  assert.deepEqual(updated.tags, []);
  const updateRefresh = db.calls.find(
    (call) =>
      call.sql.includes("INSERT INTO search_documents") &&
      call.params[1]?.includes("transaction-old"),
  );
  assert.deepEqual(updateRefresh.params[1].sort(), [
    "transaction-new",
    "transaction-old",
  ]);

  phase = "delete";
  const deleted = await repository.deleteTransactionCleanupRule(
    "shared",
    { ruleId: "rule-apple", userId: "user-2" },
  );

  assert.equal(deleted.id, "rule-apple");
  assert.ok(
    db.calls.some((call) =>
      call.sql.startsWith("DELETE FROM transaction_cleanup_rules"),
    ),
  );
});

test("manual transaction edits beat cleanup output, including empty tags", async () => {
  const db = fakePool(async (sql) => {
    if (
      sql.includes("WHERE t.workspace_id = $1 AND t.id = $2") &&
      sql.includes("LIMIT 1")
    ) {
      return { rows: [transactionRow()] };
    }
    if (sql.includes("FOR UPDATE")) {
      return { rows: [{ id: "transaction-1" }] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const transaction = await repository.getTransaction(
    "shared",
    "transaction-1",
  );
  assert.equal(transaction.display_name, "Manual Apple");
  assert.equal(transaction.category_primary, "Manual Category");
  assert.deepEqual(transaction.tags, []);

  const effectiveQuery = db.calls.find((call) =>
    call.sql.includes("WHERE t.workspace_id = $1 AND t.id = $2"),
  );
  assert.match(
    effectiveQuery.sql,
    /COALESCE\( metadata\.display_name, cleanup_rule\.display_name \)/,
  );
  assert.match(
    effectiveQuery.sql,
    /WHEN metadata\.tags_overridden THEN COALESCE\(tag_data\.tags, '\[\]'::jsonb\) WHEN cleanup_rule\.tags IS NOT NULL/,
  );
  assert.match(
    effectiveQuery.sql,
    /LEFT JOIN transaction_effective_spending_categories effective_category/,
  );
  assert.match(
    effectiveQuery.sql,
    /COALESCE\( effective_category\.category_name, effective_category\.source_category_label \) AS effective_category_primary/,
  );

  await repository.batchEditTransactions("shared", {
    transactionIds: ["transaction-1"],
    changes: { tags: [] },
    userId: "user-1",
  });
  const marker = db.calls.find(
    (call) =>
      call.sql.includes("INSERT INTO transaction_metadata") &&
      call.sql.includes("tags_overridden"),
  );
  assert.ok(marker);
  assert.match(marker.sql, /tags_overridden = true/);
});
