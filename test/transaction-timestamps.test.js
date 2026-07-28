import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

import "../app/db/pool.js";
import { PgFinanceRepository } from "../app/db/financeRepository.js";
import { buildSpendingSummary } from "../app/services/analytics.js";

function repositoryTransaction(index) {
  return {
    id: `transaction-${String(index).padStart(3, "0")}`,
    account_id: "account-1",
    account_name: "Checking",
    account_mask: "1234",
    institution_name: "Test Bank",
    merchant_name: `Merchant ${index}`,
    normalized_merchant: `merchant ${index}`,
    name: `Merchant ${index}`,
    normalized_name: `merchant ${index}`,
    category_primary: "Dining",
    category_detailed: "Dining",
    amount_minor: -100,
    currency_code: "USD",
    authorized_at: null,
    authorized_on: null,
    posted_at: null,
    posted_on: "2026-07-25",
    pending: false,
    excluded_from_spending: false,
  };
}

test("PostgreSQL DATE values stay canonical and remain eligible for spending", () => {
  const parser = pg.types.getTypeParser(pg.types.builtins.DATE);
  const postedOn = parser("2026-07-25");

  assert.equal(postedOn, "2026-07-25");
  const spending = buildSpendingSummary({
    transactions: [
      {
        ...repositoryTransaction(1),
        posted_on: postedOn,
        amount_minor: -7_425,
      },
    ],
    currentPeriod: {
      start_on: "2026-07-01",
      end_on: "2026-07-28",
    },
    previousPeriod: {
      start_on: "2026-06-04",
      end_on: "2026-07-01",
    },
  });

  assert.equal(spending.total.amount_minor, 7_425);
  assert.equal(spending.transaction_count, 1);
  assert.equal(
    spending.series.reduce(
      (total, point) => total + point.value.amount_minor,
      0,
    ),
    7_425,
  );
});

test("complete period reads paginate beyond two hundred transactions", async () => {
  const rows = Array.from({ length: 205 }, (_, index) =>
    repositoryTransaction(index),
  );
  const batches = [
    rows.slice(0, 101),
    rows.slice(100, 201),
    rows.slice(200),
  ];
  let call = 0;
  const repository = new PgFinanceRepository({
    async query() {
      return { rows: batches[call++] ?? [] };
    },
  });

  const result = await repository.getTransactionsForPeriod("shared", {
    startOn: "2026-07-01",
    endOn: "2026-07-28",
  });

  assert.equal(call, 3);
  assert.equal(result.length, 205);
  assert.equal(new Set(result.map((transaction) => transaction.id)).size, 205);
});

test("transaction timestamp migration adds only nullable source precision", async () => {
  const migration = await readFile(
    new URL("../migrations/018_transaction_timestamps.sql", import.meta.url),
    "utf8",
  );

  assert.match(
    migration,
    /ALTER TABLE transactions\s+ADD COLUMN posted_at timestamptz/,
  );
  assert.doesNotMatch(migration, /posted_at timestamptz NOT NULL/);
  assert.doesNotMatch(migration, /UPDATE transactions/);
});
