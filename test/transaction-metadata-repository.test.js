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

test("batch metadata edits lock pending and posted rows and refresh search once", async () => {
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
  assert.doesNotMatch(lock.sql, /pending = false/);
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
    "transfer",
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

test("batch edits persist an obligation role without legacy spending input", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("FOR UPDATE")) {
      return { rows: [{ id: "pending-rent" }] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  await repository.batchEditTransactions("shared", {
    transactionIds: ["pending-rent"],
    changes: { cashFlowRole: "obligation" },
    userId: "user-1",
  });

  const classificationOverride = db.calls.find(
    (call) =>
      call.sql.includes("INSERT INTO categorization_overrides") &&
      call.sql.includes("cash_flow_role = EXCLUDED.cash_flow_role"),
  );
  assert.ok(classificationOverride);
  assert.deepEqual(classificationOverride.params.slice(2), [
    null,
    "obligation",
    "user-1",
    false,
  ]);
});

test("clearing a pending display name records explicit nullable intent", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("FOR UPDATE")) {
      return { rows: [{ id: "pending-store" }] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  await repository.batchEditTransactions("shared", {
    transactionIds: ["pending-store"],
    changes: { displayName: null },
    userId: "user-1",
  });

  const displayWrite = db.calls.find(
    (call) =>
      call.sql.includes("INSERT INTO transaction_metadata") &&
      call.sql.includes("display_name_overridden"),
  );
  assert.ok(displayWrite);
  assert.deepEqual(displayWrite.params, [
    "shared",
    ["pending-store"],
    null,
    "user-1",
  ]);
  assert.match(displayWrite.sql, /display_name_overridden = true/);
  const cleanup = db.calls.find((call) =>
    call.sql.startsWith("DELETE FROM transaction_metadata"),
  );
  assert.match(cleanup.sql, /display_name_overridden = false/);
});

test("transaction reads expose the effective cash-flow role from the view", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("FROM transactions t")) {
      return {
        rows: [
          transactionRow({
            id: "rent",
            cash_flow_role: "spending",
            effective_cash_flow_role: "obligation",
            effective_excluded_from_spending: true,
          }),
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const transaction = await repository.getTransaction("shared", "rent");

  assert.equal(transaction.cash_flow_role, "obligation");
  assert.equal(transaction.excluded_from_spending, true);
  const read = db.calls.find((call) =>
    call.sql.includes("FROM transactions t"),
  );
  assert.match(
    read.sql,
    /JOIN transaction_effective_spending_treatments effective_treatment/,
  );
  assert.match(read.sql, /effective_treatment\.effective_cash_flow_role/);
});

test("analytics period reads quarantine split parents needing review", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("WITH transaction_page AS")) {
      return {
        rows: [
          transactionRow({
            id: "safe",
            split_needs_review: false,
          }),
          transactionRow({
            id: "needs-review",
            split_needs_review: true,
          }),
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const transactions = await repository.getTransactionsForPeriod(
    "shared",
    {
      startOn: "2026-07-01",
      endOn: "2026-08-01",
    },
  );

  assert.deepEqual(
    transactions.map((transaction) => transaction.id),
    ["safe"],
  );
});

test("Plan month edits persist the selected month, including zero offset", async () => {
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

  const currentMonthDb = fakePool(async (sql) => {
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
    currentMonthDb.pool,
  ).batchEditTransactions("shared", {
    transactionIds: ids,
    changes: { budgetMonthOffset: 0 },
    userId: "admin-1",
  });
  const currentMonth = currentMonthDb.calls.find(
    (call) =>
      call.sql.includes("INSERT INTO transaction_metadata") &&
      call.sql.includes("budget_month_on"),
  );
  assert.match(
    currentMonth.sql,
    /date_trunc\('month', selected\.posted_on\)\s*\+ make_interval\(months => \$3::integer\)/,
  );
  assert.doesNotMatch(currentMonth.sql, /THEN NULL/);
  assert.equal(currentMonth.params[2], 0);
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

test("batch role edits atomically reject Transfer while a manual recurring pattern is active", async () => {
  const db = fakePool(async (sql) => {
    if (
      sql.includes("AS has_active_recurring_pattern") &&
      sql.includes("FOR UPDATE OF candidate")
    ) {
      return {
        rows: [
          {
            id: "transaction-1",
            posted_on: "2026-07-01",
            has_active_recurring_pattern: true,
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.batchEditTransactions("shared", {
    transactionIds: ["transaction-1"],
    changes: {
      cashFlowRole: "transfer",
      excludedFromSpending: true,
    },
  });

  assert.deepEqual(result, {
    conflict: "active_recurring_pattern",
    transactionIds: ["transaction-1"],
  });
  assert.equal(
    db.calls.some((call) =>
      call.sql.includes("INSERT INTO categorization_overrides"),
    ),
    false,
  );
});

test("recurring streams use the latest effective transaction name, category, and role", async () => {
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
            current_cash_flow_role: "obligation",
            last_transaction_id: "transaction-1",
            last_transaction_posted_on: "2026-07-01",
            last_transaction_amount_minor: -4_200,
            last_transaction_currency_code: "USD",
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
  assert.equal(streams[0].cash_flow_role, "obligation");
  assert.deepEqual(streams[0].last_transaction, {
    id: "transaction-1",
    posted_on: "2026-07-01",
    amount_minor: -4_200,
    currency_code: "USD",
  });
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
  assert.match(
    query.sql,
    /effective_treatment\.effective_cash_flow_role AS cash_flow_role/,
  );
  assert.match(
    query.sql,
    /current_transaction\.cash_flow_role AS current_cash_flow_role/,
  );
  assert.match(
    query.sql,
    /last_payment\.transaction_id AS last_transaction_id/,
  );
  assert.match(query.sql, /AND t\.pending = false/);
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
