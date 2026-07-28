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
      isFixed: false,
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
    false,
    "user-1",
    true,
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
