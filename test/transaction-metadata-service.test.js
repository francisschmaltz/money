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
    tags: ["Groceries", "Household"],
    category_primary: "Groceries",
    category_detailed: null,
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
  assert.deepEqual(card.tags, ["Groceries", "Household"]);
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
  assert.equal(result.matches[0].display_name, "WHOLEFDS MKT 117");
  assert.equal(result.matches[0].similarity_basis_points, 8_750);

  await assert.rejects(
    service.findTransactionMatches({}),
    /transaction_id or q is required/,
  );
});

test("one batch service call preserves omitted fields and recomputes only for category edits", async () => {
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
  assert.equal(jobs.length, 0);

  await service.batchEditTransactions({
    transaction_ids: ["transaction-1"],
    changes: { category_primary: "Fees & interest" },
  });
  assert.equal(
    calls[1].input.changes.categoryPrimary,
    "Fees & Interest",
  );
  assert.equal(jobs.length, 1);

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
});
