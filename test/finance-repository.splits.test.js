import assert from "node:assert/strict";
import test from "node:test";

import { PgFinanceRepository } from "../app/db/financeRepository.js";

function fakePool(rows = []) {
  const calls = [];
  return {
    calls,
    pool: {
      async query(sql, params = []) {
        calls.push({
          sql: String(sql).replace(/\s+/g, " ").trim(),
          params,
        });
        return { rows };
      },
    },
  };
}

test("transaction category and text filters include split categories", async () => {
  const db = fakePool();
  const repository = new PgFinanceRepository(db.pool);

  await repository.listTransactions("shared", {
    category: "Dining",
    search: "dining",
    minAmountMinor: 1_000,
    maxAmountMinor: 5_000,
    merchant: "Exact Merchant",
  });

  assert.match(
    db.calls[0].sql,
    /SUM\(split_filter\.amount_minor\)::bigint AS amount_minor/,
  );
  assert.match(
    db.calls[0].sql,
    /active_spending_category_id\( split_filter\.workspace_id, split_filter\.category_id \) IN/,
  );
  assert.match(
    db.calls[0].sql,
    /GROUP BY 1, 2/,
  );
  assert.match(
    db.calls[0].sql,
    /OR category_split\.category IS NOT NULL/,
  );
  assert.match(
    db.calls[0].sql,
    /FROM transaction_splits split_override/,
  );
  assert.match(
    db.calls[0].sql,
    /FROM transaction_splits split_search/,
  );
  assert.match(
    db.calls[0].sql,
    /spending_category_name_for_id\( split_search\.workspace_id, split_search\.category_id \)/,
  );
  assert.match(
    db.calls[0].sql,
    /spending_category_descendant_ids\( split_search\.workspace_id/,
  );
  assert.equal(
    (
      db.calls[0].sql.match(
        /abs\( COALESCE\(category_split\.amount_minor, t\.amount_minor\) \)/g,
      ) ?? []
    ).length,
    2,
  );
  assert.deepEqual(db.calls[0].params.slice(12, 14), [1_000, 5_000]);
  assert.equal(db.calls[0].params[15], "Exact Merchant");
  assert.match(
    db.calls[0].sql,
    /COALESCE\( metadata\.display_name, cleanup_rule\.display_name, t\.merchant_name, t\.name \) = \$16/,
  );
});

test("finance repository selects transactions by effective Plan month only when requested", async () => {
  const db = fakePool([
    {
      id: "rent",
      account_id: "checking",
      account_name: "Checking",
      amount_minor: "-560000",
      currency_code: "USD",
      posted_on: "2026-07-02",
      budget_month_on: "2026-06-01",
      pending: false,
    },
  ]);
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.getTransactionsForPeriod("shared", {
    startOn: "2026-06-01",
    endOn: "2026-07-01",
    dateMode: "budget",
  });

  assert.equal(db.calls[0].params[16], true);
  assert.match(
    db.calls[0].sql,
    /COALESCE\(\s*metadata\.budget_month_on,\s*date_trunc\('month', t\.posted_on\)::date\s*\)/,
  );
  assert.equal(result[0].budget_month_on, "2026-06-01");
  assert.equal(result[0].posted_on, "2026-07-02");
});

test("category-filtered transactions expose one split aggregate without replacing provider data", async () => {
  const db = fakePool([
    {
      id: "transaction-1",
      account_id: "account-1",
      account_name: "Checking",
      account_mask: "1234",
      institution_name: "Bank",
      merchant_name: "Family market",
      name: "Family market",
      category_primary: "Shopping",
      category_detailed: "Shopping other",
      effective_category_primary: "Shopping",
      effective_category_detailed: "Shopping other",
      split_category: "Dining",
      split_category_amount_minor: "-4250",
      split_category_line_count: "2",
      amount_minor: "-10000",
      currency_code: "USD",
      posted_on: "2026-07-27",
      pending: false,
      split_version: "3",
    },
  ]);
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.listTransactions("shared", {
    category: "Dining",
  });
  const [transaction] = result.transactions;

  assert.equal(transaction.id, "transaction-1");
  assert.equal(transaction.category_primary, "Dining");
  assert.equal(transaction.category_detailed, null);
  assert.equal(transaction.amount_minor, -4_250);
  assert.equal(transaction.provider_amount_minor, -10_000);
  assert.equal(transaction.is_split_category_projection, true);
  assert.equal(transaction.split_category_line_count, 2);
  assert.equal(transaction.split_version, 3);
});

test("observed categories include split-only categories", async () => {
  const db = fakePool();
  const repository = new PgFinanceRepository(db.pool);

  await repository.listTransactionCategories("shared");

  assert.match(db.calls[0].sql, /WITH category_transactions AS/);
  assert.match(
    db.calls[0].sql,
    /UNION SELECT active_spending_category_id\( split\.workspace_id, split\.category_id \) AS category_id, split\.transaction_id FROM transaction_splits split/,
  );
});

test("finance repository returns typed split lines for analytics", async () => {
  const db = fakePool([
    {
      id: "split-1",
      transaction_id: "transaction-1",
      split_version: "3",
      line_index: "0",
      category: "Dining",
      amount_minor: "-2500",
      note: null,
      created_at: "2026-07-27T10:00:00.000Z",
      updated_at: "2026-07-27T10:00:00.000Z",
    },
  ]);
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.listTransactionSplits("shared", {
    startOn: "2026-07-01",
    endOn: "2026-08-01",
  });

  assert.equal(result[0].line_index, 0);
  assert.equal(result[0].split_version, 3);
  assert.equal(result[0].amount_minor, -2_500);
  assert.match(
    db.calls[0].sql,
    /SELECT split\.\*, active_spending_category_id\(/,
  );
  assert.match(db.calls[0].sql, /transaction\.split_version/);
  assert.deepEqual(db.calls[0].params, [
    "shared",
    null,
    "2026-07-01",
    "2026-08-01",
    false,
  ]);
});

test("finance repository can select split lines by effective Plan month", async () => {
  const db = fakePool();
  const repository = new PgFinanceRepository(db.pool);

  await repository.listTransactionSplits("shared", {
    startOn: "2026-06-01",
    endOn: "2026-07-01",
    dateMode: "budget",
  });

  assert.match(
    db.calls[0].sql,
    /COALESCE\(\s*metadata\.budget_month_on,\s*date_trunc\('month', transaction\.posted_on\)::date\s*\)/,
  );
  assert.deepEqual(db.calls[0].params, [
    "shared",
    null,
    "2026-06-01",
    "2026-07-01",
    true,
  ]);
});

test("finance repository returns the parent split version with transactions", async () => {
  const db = fakePool([
    {
      id: "transaction-1",
      posted_on: "2026-07-27",
      amount_minor: "-5000",
      currency_code: "USD",
      pending: false,
      split_version: "4",
      goal_spend_version: "2",
    },
  ]);
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.listTransactions("shared");

  assert.equal(result.transactions[0].split_version, 4);
  assert.equal(result.transactions[0].goal_spend_version, 2);
  assert.equal(result.transactions[0].provider_amount_minor, -5_000);
  assert.equal(
    result.transactions[0].is_split_category_projection,
    false,
  );
});

test("transaction sorting uses stable keys and sort-aware cursors", async () => {
  const cases = [
    {
      sort: "date",
      order: /ORDER BY posted_on DESC, id DESC/,
      key: "2026-07-26",
    },
    {
      sort: "merchant",
      order:
        /ORDER BY transaction_sort_merchant ASC, posted_on DESC, id DESC/,
      key: "alpha market",
    },
    {
      sort: "category",
      order:
        /ORDER BY transaction_sort_category ASC, posted_on DESC, id DESC/,
      key: "groceries",
    },
    {
      sort: "cost",
      order:
        /ORDER BY transaction_sort_cost DESC, posted_on DESC, id DESC/,
      key: "5000",
      expression:
        /CASE\s+WHEN COALESCE\(\s*category_split\.amount_minor,\s*t\.amount_minor\s*\) < 0[\s\S]*?ELSE -1\s+END AS transaction_sort_cost/,
    },
  ];

  for (const expected of cases) {
    const db = fakePool([
      {
        id: "transaction-1",
        posted_on: "2026-07-26",
        amount_minor: "-5000",
        currency_code: "USD",
        transaction_sort_merchant: "alpha market",
        transaction_sort_category: "groceries",
        transaction_sort_cost: "5000",
      },
      {
        id: "transaction-2",
        posted_on: "2026-07-25",
        amount_minor: "-4000",
        currency_code: "USD",
        transaction_sort_merchant: "zulu market",
        transaction_sort_category: "travel",
        transaction_sort_cost: "4000",
      },
    ]);
    const repository = new PgFinanceRepository(db.pool);

    const first = await repository.listTransactions("shared", {
      sort: expected.sort,
      limit: 1,
    });
    const cursor = JSON.parse(
      Buffer.from(
        first.pageInfo.next_cursor,
        "base64url",
      ).toString("utf8"),
    );

    assert.match(db.calls[0].sql, expected.order);
    if (expected.expression) {
      assert.match(db.calls[0].sql, expected.expression);
    }
    assert.equal(cursor.sort, expected.sort);
    assert.equal(cursor.key, expected.key);
    assert.equal(cursor.posted_on, "2026-07-26");
    assert.equal(cursor.id, "transaction-1");

    await repository.listTransactions("shared", {
      sort: expected.sort,
      cursor: first.pageInfo.next_cursor,
      limit: 1,
    });
    assert.deepEqual(
      db.calls[1].params.slice(7, 10),
      [expected.key, "2026-07-26", "transaction-1"],
    );
  }
});

test("transaction cursors cannot be reused with another sort", async () => {
  const db = fakePool([
    {
      id: "transaction-1",
      posted_on: "2026-07-26",
      amount_minor: "-5000",
      currency_code: "USD",
      transaction_sort_merchant: "alpha market",
    },
    {
      id: "transaction-2",
      posted_on: "2026-07-25",
      amount_minor: "-4000",
      currency_code: "USD",
      transaction_sort_merchant: "beta market",
    },
  ]);
  const repository = new PgFinanceRepository(db.pool);
  const first = await repository.listTransactions("shared", {
    sort: "merchant",
    limit: 1,
  });

  await assert.rejects(
    repository.listTransactions("shared", {
      sort: "category",
      cursor: first.pageInfo.next_cursor,
    }),
    /Invalid transaction cursor/,
  );
});

test("cost cursors keep the signed income sentinel and advance within income rows", async () => {
  const db = fakePool([
    {
      id: "income-2",
      posted_on: "2026-07-26",
      amount_minor: "900000",
      currency_code: "USD",
      transaction_sort_cost: "-1",
    },
    {
      id: "income-1",
      posted_on: "2026-07-25",
      amount_minor: "500000",
      currency_code: "USD",
      transaction_sort_cost: "-1",
    },
  ]);
  const repository = new PgFinanceRepository(db.pool);
  const first = await repository.listTransactions("shared", {
    sort: "cost",
    limit: 1,
  });
  const cursor = JSON.parse(
    Buffer.from(
      first.pageInfo.next_cursor,
      "base64url",
    ).toString("utf8"),
  );

  assert.equal(cursor.key, "-1");
  await repository.listTransactions("shared", {
    sort: "cost",
    cursor: first.pageInfo.next_cursor,
    limit: 1,
  });
  assert.deepEqual(
    db.calls[1].params.slice(7, 10),
    ["-1", "2026-07-26", "income-2"],
  );
});
