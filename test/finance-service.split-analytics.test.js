import assert from "node:assert/strict";
import test from "node:test";

import { createFinanceService } from "../app/services/financeService.js";

const FRESHNESS = {
  data_as_of: "2026-07-27T18:42:00.000Z",
  partial: false,
  warnings: [],
};

function transaction({
  id,
  postedOn,
  amountMinor,
  category = "Shopping",
}) {
  return {
    id,
    posted_on: postedOn,
    authorized_at: null,
    merchant_name: id,
    name: id,
    category_primary: category,
    category_detailed: category,
    account_id: "checking",
    account_name: "Checking",
    amount_minor: amountMinor,
    currency_code: "USD",
    pending: false,
    excluded_from_spending: false,
  };
}

function splitAwareService() {
  const transactionCalls = [];
  const splitCalls = [];
  const transactions = [
    transaction({
      id: "purchase",
      postedOn: "2026-07-10",
      amountMinor: -10_000,
    }),
    transaction({
      id: "prior-dining",
      postedOn: "2026-06-10",
      amountMinor: -2_000,
      category: "Dining",
    }),
  ];
  const splits = [
    {
      id: "split-dining-1",
      transaction_id: "purchase",
      line_index: 0,
      category: "Dining",
      amount_minor: -1_500,
    },
    {
      id: "split-dining-2",
      transaction_id: "purchase",
      line_index: 1,
      category: "Dining",
      amount_minor: -2_500,
    },
    {
      id: "split-groceries",
      transaction_id: "purchase",
      line_index: 2,
      category: "Groceries",
      amount_minor: -6_000,
    },
  ];
  const repository = {
    async listTransactions() {
      return {
        transactions: [],
        pageInfo: { has_more: false, next_cursor: null },
      };
    },
    async getTransactionsForPeriod(_workspaceId, options) {
      transactionCalls.push(options);
      return transactions;
    },
    async listTransactionSplits(_workspaceId, options) {
      splitCalls.push(options);
      return splits;
    },
    async getDataFreshness() {
      return FRESHNESS;
    },
    async listAccounts() {
      return [];
    },
    async listTransactionCategories() {
      return ["Dining", "Groceries", "Shopping"];
    },
  };
  return {
    service: createFinanceService({
      repository,
      now: () => new Date("2026-07-27T19:00:00.000Z"),
    }),
    transactionCalls,
    splitCalls,
  };
}

test("spending segments and category filters use split lines instead of the parent category", async () => {
  const { service, transactionCalls, splitCalls } =
    splitAwareService();
  const result = await service.getSpendingSummary({
    period: "custom",
    startOn: "2026-07-01",
    endOn: "2026-08-01",
    previousStartOn: "2026-06-01",
    previousEndOn: "2026-07-01",
    category: "Dining",
  });

  assert.equal(transactionCalls[0].category, null);
  assert.deepEqual(splitCalls[0], {
    startOn: "2026-06-01",
    endOn: "2026-08-01",
  });
  assert.equal(result.data.total.amount_minor, 4_000);
  assert.equal(result.data.previous_total.amount_minor, 2_000);
  assert.deepEqual(
    result.data.segments.map((segment) => [
      segment.label,
      segment.amount.amount_minor,
    ]),
    [["Dining", 4_000]],
  );
});

test("cash-flow category filters use only the matching split amount", async () => {
  const { service, transactionCalls } = splitAwareService();
  const result = await service.getCashFlow({
    period: "custom",
    startOn: "2026-07-01",
    endOn: "2026-08-01",
    category: "Groceries",
    interval: "month",
  });

  assert.equal(transactionCalls[0].category, null);
  assert.equal(result.data.spending.amount_minor, 6_000);
  assert.equal(result.data.net.amount_minor, -6_000);
});

test("split dollars do not multiply purchase counts or shrink the average purchase", async () => {
  const { service } = splitAwareService();
  const page = await service.getPageData("transactions", {
    query: { period: "30" },
  });

  assert.equal(page.spendingDetails.total.amount_minor, 10_000);
  assert.equal(page.spendingDetails.transactionCount, 1);
  assert.equal(
    page.spendingDetails.averageTransaction.amount_minor,
    10_000,
  );
  assert.deepEqual(
    page.spendingDetails.categories.map((category) => ({
      label: category.label,
      amount: category.amount.amount_minor,
      count: category.count,
    })),
    [
      { label: "Groceries", amount: 6_000, count: 1 },
      { label: "Dining", amount: 4_000, count: 1 },
    ],
  );
});
