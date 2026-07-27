import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalTransactionCategory,
  FEES_INTEREST_CATEGORY,
  transactionCategoryOptions,
} from "../app/services/transactionCategories.js";

test("bank fees canonicalize without swallowing interest income or loan payments", () => {
  assert.equal(
    canonicalTransactionCategory("BANK_FEES", "BANK_FEES_OVERDRAFT"),
    FEES_INTEREST_CATEGORY,
  );
  assert.equal(
    canonicalTransactionCategory("Bank Fees"),
    FEES_INTEREST_CATEGORY,
  );
  assert.equal(
    canonicalTransactionCategory(null, "BANK_FEES_INTEREST_CHARGE"),
    FEES_INTEREST_CATEGORY,
  );
  assert.equal(
    canonicalTransactionCategory("INCOME", "INCOME_INTEREST_EARNED"),
    "INCOME",
  );
  assert.equal(
    canonicalTransactionCategory("LOAN_PAYMENTS", "LOAN_PAYMENTS_CAR"),
    "LOAN_PAYMENTS",
  );
});

test("transaction category options always expose one canonical fee category", () => {
  assert.deepEqual(
    transactionCategoryOptions([
      "Fees & interest",
      "BANK_FEES",
      "Dining",
      null,
    ]),
    [
      { label: "Dining" },
      { label: FEES_INTEREST_CATEGORY },
    ],
  );
});

test("transaction category options keep Other last", () => {
  assert.deepEqual(
    transactionCategoryOptions([
      "Other",
      "Utilities",
      "Dining",
    ]).map((entry) => entry.label),
    [
      "Dining",
      FEES_INTEREST_CATEGORY,
      "Utilities",
      "Other",
    ],
  );
});

test("fee category migration preserves detailed provider categories", async () => {
  const migration = await readFile(
    new URL("../migrations/004_fees_interest_category.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /UPDATE transactions/);
  assert.match(migration, /UPDATE categorization_overrides/);
  assert.match(migration, /category_primary = 'Fees & Interest'/);
  assert.match(migration, /category_detailed/);
  assert.doesNotMatch(migration, /SET category_detailed/);
});
