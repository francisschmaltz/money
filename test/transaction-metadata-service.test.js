import test from "node:test";
import assert from "node:assert/strict";

import { createFinanceService } from "../app/services/financeService.js";

const FRESHNESS = {
  data_as_of: "2026-07-27T12:00:00.000Z",
  partial: false,
  warnings: [],
};

function transaction(overrides = {}) {
  return {
    id: "transaction-1",
    account_id: "account-1",
    account_name: "Checking",
    account_mask: "1234",
    institution_name: "Bank",
    merchant_name: "WHOLEFDS MKT 117",
    normalized_merchant: "wholefds mkt",
    name: "WHOLEFDS MKT 117 BROOKLYN",
    normalized_name: "wholefds mkt brooklyn",
    display_name: "Whole Foods",
    note: "Dinner supplies",
    note_version: 2,
    note_updated_by: "user-1",
    note_updated_at: "2026-07-27T18:00:00.000Z",
    tags: ["Groceries", "Household"],
    category_id: "category-groceries",
    category_primary: "Groceries",
    category_detailed: null,
    original_category_primary: "FOOD_AND_DRINK",
    original_category_detailed: "FOOD_AND_DRINK_GROCERIES",
    amount_minor: -6_249,
    currency_code: "USD",
    authorized_at: null,
    posted_on: "2026-07-14",
    pending: false,
    excluded_from_spending: false,
    is_fixed: false,
    ...overrides,
  };
}

test("transaction cards expose effective display and tags without losing provider facts", async () => {
  const repository = {
    async listTransactions() {
      return {
        transactions: [transaction()],
        pageInfo: { has_more: false, next_cursor: null },
      };
    },
    async getDataFreshness() {
      return FRESHNESS;
    },
  };
  const service = createFinanceService({ repository });

  const result = await service.listTransactions({ status: "posted" });
  const card = result.data.transactions[0];

  assert.equal(card.display_name, "Whole Foods");
  assert.equal(card.merchant, "Whole Foods");
  assert.equal(card.raw_merchant, "WHOLEFDS MKT 117");
  assert.equal(card.raw_name, "WHOLEFDS MKT 117 BROOKLYN");
  assert.equal(card.note, "Dinner supplies");
  assert.equal(card.note_version, 2);
  assert.equal(card.note_updated_by, "user-1");
  assert.equal(card.note_updated_at, "2026-07-27T18:00:00.000Z");
  assert.deepEqual(card.tags, ["Groceries", "Household"]);
  assert.equal(card.category_id, "category-groceries");
  assert.equal(card.category, "Groceries");
  assert.equal(card.original_category, "FOOD_AND_DRINK");
  assert.equal(
    card.original_detailed_category,
    "FOOD_AND_DRINK_GROCERIES",
  );
});

test("match lookup returns the strict Settings shape and rejects pending anchors", async () => {
  let received;
  const repository = {
    async findTransactionMatches(_workspaceId, input) {
      received = input;
      return {
        query: "Whole Foods",
        anchor: {
          ...transaction(),
          similarity_basis_points: 10_000,
          match_reason: "anchor",
          preselected: true,
        },
        matches: [
          {
            ...transaction({
              id: "transaction-2",
              display_name: null,
              tags: [],
            }),
            similarity_basis_points: 8_750,
            match_reason: "similar_merchant",
            preselected: false,
          },
        ],
        availableTags: [
          { id: "tag-1", name: "Household" },
          { id: "tag-2", name: "Groceries" },
        ],
      };
    },
  };
  const service = createFinanceService({ repository });

  const result = await service.findTransactionMatches({
    transaction_id: "transaction-1",
    q: "Whole Foods",
    limit: 500,
  });

  assert.deepEqual(received, {
    transactionId: "transaction-1",
    query: "Whole Foods",
    limit: 50,
  });
  assert.deepEqual(Object.keys(result), [
    "query",
    "anchor",
    "matches",
    "available_tags",
  ]);
  assert.deepEqual(result.available_tags, ["Household", "Groceries"]);
  assert.deepEqual(result.anchor.amount, {
    amount_minor: -6_249,
    currency: "USD",
  });
  assert.equal(result.anchor.raw_merchant, "WHOLEFDS MKT 117");
  assert.equal(result.anchor.account_id, "account-1");
  assert.equal(result.matches[0].display_name, "WHOLEFDS MKT 117");
  assert.equal(result.matches[0].similarity_basis_points, 8_750);

  await assert.rejects(
    service.findTransactionMatches({}),
    /transaction_id or q is required/,
  );
});

test("transaction notes trim input and reject stale writes", async () => {
  const calls = [];
  const repository = {
    async updateTransactionNote(workspaceId, input) {
      calls.push({ workspaceId, input });
      if (input.expectedVersion === 1) {
        return {
          conflict: true,
          transaction_id: input.transactionId,
          note: "Someone else changed this",
          note_version: 2,
        };
      }
      return {
        transaction_id: input.transactionId,
        note: input.note,
        note_version: 1,
        note_updated_by: input.userId,
        note_updated_at: "2026-07-28T12:00:00.000Z",
      };
    },
  };
  const service = createFinanceService({ repository });

  const saved = await service.updateTransactionNote(
    {
      transaction_id: "transaction-1",
      note: "  Dinner with Sam  ",
      expected_note_version: 0,
    },
    { id: "user-1" },
  );

  assert.equal(saved.note, "Dinner with Sam");
  assert.deepEqual(calls[0].input, {
    transactionId: "transaction-1",
    note: "Dinner with Sam",
    expectedVersion: 0,
    userId: "user-1",
  });
  await assert.rejects(
    service.updateTransactionNote({
      transaction_id: "transaction-1",
      note: "Stale draft",
      expected_note_version: 1,
    }),
    (error) =>
      error.statusCode === 409 &&
      /changed after you opened it/.test(error.message),
  );
  await assert.rejects(
    service.updateTransactionNote({
      transaction_id: "transaction-1",
      note: "x".repeat(2001),
      expected_note_version: 0,
    }),
    /note must be between 1 and 2000 characters/,
  );
});

test("one batch service call preserves omitted fields and recomputes canonical-name changes", async () => {
  const calls = [];
  const jobs = [];
  const repository = {
    async batchEditTransactions(workspaceId, input) {
      calls.push({ workspaceId, input });
      return {
        updatedCount: input.transactionIds.length,
        transactionIds: input.transactionIds,
      };
    },
  };
  const service = createFinanceService({
    repository,
    jobQueue: {
      async enqueue(...args) {
        jobs.push(args);
      },
    },
  });

  const displayOnly = await service.batchEditTransactions(
    {
      transaction_ids: ["transaction-1", "transaction-2"],
      changes: { display_name: "Whole Foods", tags: [] },
    },
    { id: "user-1" },
  );
  assert.deepEqual(displayOnly, {
    updated_count: 2,
    transaction_ids: ["transaction-1", "transaction-2"],
  });
  assert.deepEqual(calls[0].input, {
    transactionIds: ["transaction-1", "transaction-2"],
    changes: { displayName: "Whole Foods", tags: [] },
    userId: "user-1",
  });
  assert.deepEqual(jobs, [
    [
      "finance.detect_recurring",
      { workspaceId: "shared" },
      { dedupeKey: "shared" },
    ],
  ]);

  await service.batchEditTransactions({
    transaction_ids: ["transaction-1"],
    changes: {
      category_primary: "Fees & interest",
      excluded_from_spending: true,
      budget_month_offset: 1,
    },
  });
  assert.equal(
    calls[1].input.changes.categoryPrimary,
    "Fees & Interest",
  );
  assert.equal(calls[1].input.changes.excludedFromSpending, true);
  assert.equal(calls[1].input.changes.budgetMonthOffset, 1);
  assert.equal(jobs.length, 2);

  await service.batchEditTransactions({
    transaction_ids: ["transaction-1"],
    changes: { budget_month_offset: -1 },
  });
  assert.equal(calls[2].input.changes.budgetMonthOffset, -1);
  assert.equal(jobs.length, 2);

  await assert.rejects(
    service.batchEditTransactions({
      transaction_ids: ["transaction-1", "transaction-1"],
      changes: { tags: [] },
    }),
    /transaction_ids must be unique/,
  );
  await assert.rejects(
    service.batchEditTransactions({
      transaction_ids: ["transaction-1"],
      changes: {},
    }),
    /At least one transaction change is required/,
  );
  await assert.rejects(
    service.batchEditTransactions({
      transaction_ids: ["transaction-1"],
      changes: { budget_month_offset: -2 },
    }),
    /budget_month_offset must be -1, 0, or 1/,
  );
});
