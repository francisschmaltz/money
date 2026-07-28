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
    async listSpendingCategories() {
      return [
        {
          id: "dining",
          name: "Dining",
          path: "Dining",
          parent_category_id: null,
        },
        {
          id: "groceries",
          name: "Groceries",
          path: "Groceries",
          parent_category_id: null,
        },
        {
          id: "shopping",
          name: "Shopping",
          path: "Shopping",
          parent_category_id: null,
        },
      ];
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

test("a parent category includes direct, child, nested, and split activity once", async () => {
  const ledgerCalls = [];
  const transactions = [
    {
      ...transaction({
        id: "direct-home",
        postedOn: "2026-07-03",
        amountMinor: -1_000,
        category: "Home",
      }),
      category_id: "home",
    },
    {
      ...transaction({
        id: "rent",
        postedOn: "2026-07-04",
        amountMinor: -5_600,
        category: "Home / Rent",
      }),
      category_id: "rent",
    },
    {
      ...transaction({
        id: "electric",
        postedOn: "2026-07-05",
        amountMinor: -700,
        category: "Home / Utilities / Electric",
      }),
      category_id: "electric",
    },
    {
      ...transaction({
        id: "split-purchase",
        postedOn: "2026-07-06",
        amountMinor: -2_000,
        category: "Shopping",
      }),
      category_id: "shopping",
      split_version: 1,
    },
  ];
  const categories = [
    {
      id: "home",
      name: "Home",
      path: "Home",
      parent_category_id: null,
    },
    {
      id: "rent",
      name: "Rent",
      path: "Home / Rent",
      parent_category_id: "home",
    },
    {
      id: "utilities",
      name: "Utilities",
      path: "Home / Utilities",
      parent_category_id: "home",
    },
    {
      id: "electric",
      name: "Electric",
      path: "Home / Utilities / Electric",
      parent_category_id: "utilities",
    },
    {
      id: "shopping",
      name: "Shopping",
      path: "Shopping",
      parent_category_id: null,
    },
  ];
  const repository = {
    async listTransactions(_workspaceId, options) {
      ledgerCalls.push(options);
      return {
        transactions,
        pageInfo: { has_more: false, next_cursor: null },
      };
    },
    async getTransactionsForPeriod() {
      return transactions;
    },
    async listTransactionSplits() {
      return [
        {
          id: "split-home",
          transaction_id: "split-purchase",
          split_version: 1,
          line_index: 0,
          category_id: "rent",
          category: "Home / Rent",
          amount_minor: -800,
        },
        {
          id: "split-shopping",
          transaction_id: "split-purchase",
          split_version: 1,
          line_index: 1,
          category_id: "shopping",
          category: "Shopping",
          amount_minor: -1_200,
        },
      ];
    },
    async listSpendingCategories() {
      return categories;
    },
    async listTransactionCategories() {
      return categories.map((category) => category.path);
    },
    async listAccounts() {
      return [];
    },
    async getDataFreshness() {
      return FRESHNESS;
    },
  };
  const service = createFinanceService({
    repository,
    now: () => new Date("2026-07-27T19:00:00.000Z"),
  });

  const page = await service.getPageData("transactions", {
    query: { period: "month", category: "home" },
  });

  assert.equal(ledgerCalls[0].category, "home");
  assert.equal(page.spendingDetails.total.amount_minor, 8_100);
  assert.equal(page.spendingDetails.transactionCount, 4);
  assert.deepEqual(
    page.spendingDetails.categories.map((entry) => [
      entry.label,
      entry.amount.amount_minor,
    ]),
    [["Home", 8_100]],
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
