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

function transactionRow(overrides = {}) {
  return {
    id: "transaction-anchor",
    account_id: "account-1",
    account_name: "Checking",
    account_mask: "1234",
    institution_name: "Bank",
    merchant_name: "WHOLEFDS MKT 117",
    normalized_merchant: "wholefds mkt",
    name: "WHOLEFDS MKT 117 BROOKLYN",
    normalized_name: "wholefds mkt brooklyn",
    display_name: "Whole Foods",
    tags: ["Groceries"],
    category_primary: "FOOD_AND_DRINK",
    effective_category_primary: "Groceries",
    category_detailed: null,
    effective_category_detailed: null,
    amount_minor: -6_249,
    currency_code: "USD",
    authorized_at: null,
    posted_on: "2026-07-14",
    pending: false,
    excluded_from_spending: false,
    is_fixed: false,
    original_transaction_id: null,
    payment_channel: "in store",
    ...overrides,
  };
}

test("posted fuzzy matching ranks exact merchants first and keeps raw facts", async () => {
  const db = fakePool(async (sql) => {
    if (
      sql.includes("WHERE t.workspace_id = $1 AND t.id = $2") &&
      sql.includes("LIMIT 1")
    ) {
      return { rows: [transactionRow()] };
    }
    if (sql.includes("FROM transaction_tags tag")) {
      return {
        rows: [
          {
            id: "tag-1",
            name: "Groceries",
            normalized_name: "groceries",
            transaction_count: 2,
          },
        ],
      };
    }
    if (sql.includes("WITH candidates AS")) {
      return {
        rows: [
          transactionRow({
            id: "transaction-match",
            display_name: null,
            tags: ["Household"],
            posted_on: "2026-07-09",
            similarity_basis_points: 10_000,
            match_reason: "exact_merchant",
            preselected: true,
          }),
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.findTransactionMatches("shared", {
    transactionId: "transaction-anchor",
    limit: 500,
  });

  assert.equal(result.anchor.display_name, "Whole Foods");
  assert.equal(result.anchor.merchant_name, "WHOLEFDS MKT 117");
  assert.deepEqual(result.anchor.tags, ["Groceries"]);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].display_name, "WHOLEFDS MKT 117");
  assert.deepEqual(result.matches[0].tags, ["Household"]);
  assert.deepEqual(result.availableTags.map((tag) => tag.name), [
    "Groceries",
  ]);

  const matchQuery = db.calls.find((call) =>
    call.sql.includes("WITH candidates AS"),
  );
  assert.ok(matchQuery);
  assert.match(matchQuery.sql, /t\.pending = false/);
  assert.match(
    matchQuery.sql,
    /sign\(t\.amount_minor\) = sign\(\$5::bigint\)/,
  );
  assert.match(
    matchQuery.sql,
    /ORDER BY \(candidates\.normalized_merchant = \$4\) DESC/,
  );
  assert.match(matchQuery.sql, /candidates\.similarity_score >= 0\.2/);
  assert.deepEqual(matchQuery.params, [
    "shared",
    "transaction-anchor",
    "wholefds mkt",
    "wholefds mkt",
    -6_249,
    50,
  ]);
});

test("batch metadata edits lock exact posted rows and refresh search once", async () => {
  const ids = ["transaction-1", "transaction-2"];
  const db = fakePool(async (sql) => {
    if (sql.includes("FOR UPDATE")) {
      return { rows: ids.map((id) => ({ id })) };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.batchEditTransactions("shared", {
    transactionIds: ids,
    changes: {
      displayName: "Whole Foods",
      categoryPrimary: "Groceries",
      tags: ["Household", "Reimbursable"],
      excludedFromSpending: true,
    },
    userId: "user-1",
  });

  assert.deepEqual(result, {
    updatedCount: 2,
    transactionIds: ids,
  });
  const lock = db.calls.find((call) => call.sql.includes("FOR UPDATE"));
  assert.match(lock.sql, /pending = false/);
  assert.deepEqual(lock.params, ["shared", ids]);
  assert.ok(
    db.calls.some((call) =>
      call.sql.includes("INSERT INTO transaction_metadata"),
    ),
  );
  assert.ok(
    db.calls.some((call) =>
      call.sql.includes("INSERT INTO categorization_overrides"),
    ),
  );
  const classificationOverride = db.calls.find(
    (call) =>
      call.sql.includes("INSERT INTO categorization_overrides") &&
      call.sql.includes("excluded_from_spending = CASE"),
  );
  assert.ok(classificationOverride);
  assert.deepEqual(classificationOverride.params.slice(2), [
    true,
    "user-1",
    true,
  ]);
  assert.ok(
    db.calls.some((call) =>
      call.sql.includes("INSERT INTO transaction_tags"),
    ),
  );
  assert.ok(
    db.calls.some((call) =>
      call.sql.includes("INSERT INTO transaction_tag_assignments"),
    ),
  );
  assert.equal(
    db.calls.filter((call) =>
      call.sql.includes(
        "INSERT INTO search_documents ( id, workspace_id, entity_type",
      ),
    ).length,
    1,
  );
  const searchRefresh = db.calls.find(
    (call) =>
      call.sql.includes("INSERT INTO search_documents") &&
      call.sql.includes("'transaction:' || t.id"),
  );
  assert.ok(searchRefresh);
  assert.match(searchRefresh.sql, /metadata\.display_name/);
  assert.match(searchRefresh.sql, /metadata\.note/);
  assert.match(searchRefresh.sql, /'note', metadata\.note/);
  assert.match(searchRefresh.sql, /tag_data\.tag_names/);
  assert.match(searchRefresh.sql, /'raw_merchant', t\.merchant_name/);
  assert.equal(
    db.calls.some(
      (call) =>
        call.sql.startsWith("UPDATE transactions") ||
        call.sql.includes("merchant_name ="),
    ),
    false,
  );
});

test("Plan month batch edits are relative to each posted month and clear with zero", async () => {
  const ids = ["january-rent", "december-rent"];
  const db = fakePool(async (sql) => {
    if (sql.includes("FOR UPDATE")) {
      return {
        rows: [
          { id: ids[0], posted_on: "2026-01-02" },
          { id: ids[1], posted_on: "2026-12-31" },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  await repository.batchEditTransactions("shared", {
    transactionIds: ids,
    changes: { budgetMonthOffset: -1 },
    userId: "admin-1",
  });

  const assignment = db.calls.find(
    (call) =>
      call.sql.includes("INSERT INTO transaction_metadata") &&
      call.sql.includes("budget_month_on"),
  );
  assert.ok(assignment);
  assert.match(
    assignment.sql,
    /date_trunc\('month', selected\.posted_on\)\s*\+ make_interval\(months => \$3::integer\)/,
  );
  assert.deepEqual(assignment.params, [
    "shared",
    ids,
    -1,
    "admin-1",
  ]);

  const clearDb = fakePool(async (sql) => {
    if (sql.includes("FOR UPDATE")) {
      return {
        rows: ids.map((id) => ({
          id,
          posted_on: "2026-07-02",
        })),
      };
    }
    return { rows: [] };
  });
  await new PgFinanceRepository(
    clearDb.pool,
  ).batchEditTransactions("shared", {
    transactionIds: ids,
    changes: { budgetMonthOffset: 0 },
    userId: "admin-1",
  });
  const clear = clearDb.calls.find(
    (call) =>
      call.sql.includes("INSERT INTO transaction_metadata") &&
      call.sql.includes("budget_month_on"),
  );
  assert.match(clear.sql, /WHEN \$3::integer = 0 THEN NULL/);
  assert.equal(clear.params[2], 0);
});

test("batch metadata rejects the whole write when any selected row is unavailable", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("FOR UPDATE")) {
      return { rows: [{ id: "transaction-1" }] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.batchEditTransactions("shared", {
    transactionIds: ["transaction-1", "missing-transaction"],
    changes: { displayName: "Corrected" },
  });

  assert.equal(result, null);
  assert.equal(
    db.calls.some(
      (call) =>
        call.sql.includes("INSERT INTO transaction_metadata") ||
        call.sql.includes("INSERT INTO categorization_overrides") ||
        call.sql.includes("DELETE FROM transaction_tag_assignments"),
    ),
    false,
  );
});

test("recurring streams use the latest effective transaction name and category", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("FROM recurring_streams r")) {
      return {
        rows: [
          {
            id: "stream-1",
            service_family: "restaurant",
            display_name: "OLD RESTAURANT",
            current_display_name: "Dinner Club",
            current_category_primary: "Food & Drink",
            stream_type: "frequent_spending",
            cadence: "monthly",
            account_id: "account-1",
            account_name: "Card",
            expected_amount_minor: 4_200,
            min_amount_minor: 4_000,
            max_amount_minor: 4_400,
            monthly_equivalent_minor: 4_200,
            currency_code: "USD",
            first_seen_on: "2026-01-01",
            last_seen_on: "2026-07-01",
            next_expected_on: "2026-08-01",
            confidence_basis_points: 9_000,
            status: "active",
            transaction_ids: ["transaction-1"],
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const streams = await repository.listRecurringStreams("shared");

  assert.equal(streams[0].display_name, "Dinner Club");
  assert.equal(streams[0].category_primary, "Food & Drink");
  const query = db.calls.find((call) =>
    call.sql.includes("FROM recurring_streams r"),
  );
  assert.match(query.sql, /metadata\.display_name/);
  assert.match(query.sql, /cleanup_rule\.display_name/);
  assert.match(query.sql, /effective_category\.category_name/);
  assert.match(
    query.sql,
    /current_transaction\.category_primary AS current_category_primary/,
  );
});

test("transaction notes increment their version and refresh search", async () => {
  const db = fakePool(async (sql) => {
    if (
      sql.includes("SELECT id FROM transactions") &&
      sql.includes("FOR UPDATE")
    ) {
      return { rows: [{ id: "transaction-1" }] };
    }
    if (
      sql.includes(
        "SELECT note, note_version, note_updated_by, note_updated_at",
      )
    ) {
      return { rows: [] };
    }
    if (
      sql.includes("INSERT INTO transaction_metadata") &&
      sql.includes("note_version")
    ) {
      return {
        rows: [
          {
            transaction_id: "transaction-1",
            note: "Dinner with Sam",
            note_version: 1,
            note_updated_by: "user-1",
            note_updated_at: "2026-07-28T12:00:00.000Z",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.updateTransactionNote("shared", {
    transactionId: "transaction-1",
    note: "Dinner with Sam",
    expectedVersion: 0,
    userId: "user-1",
  });

  assert.equal(result.note_version, 1);
  assert.equal(result.note, "Dinner with Sam");
  const write = db.calls.find(
    (call) =>
      call.sql.includes("INSERT INTO transaction_metadata") &&
      call.sql.includes("note_version"),
  );
  assert.deepEqual(write.params, [
    "shared",
    "transaction-1",
    "Dinner with Sam",
    "user-1",
  ]);
  assert.match(
    write.sql,
    /note_version = transaction_metadata\.note_version \+ 1/,
  );
  assert.ok(
    db.calls.some(
      (call) =>
        call.sql.includes("INSERT INTO search_documents") &&
        call.sql.includes("metadata.note"),
    ),
  );
});
