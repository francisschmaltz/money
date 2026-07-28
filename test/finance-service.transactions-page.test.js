import assert from "node:assert/strict";
import test from "node:test";

import { createFinanceService } from "../app/services/financeService.js";

const FRESHNESS = {
  data_as_of: "2026-07-26T18:42:00.000Z",
  partial: false,
  warnings: [],
};

function transaction({
  id,
  postedOn,
  amountMinor,
  category,
  merchant = id,
  pending = false,
  excludedFromSpending = false,
  splitVersion = 0,
}) {
  return {
    id,
    posted_on: postedOn,
    authorized_at: null,
    merchant_name: merchant,
    name: merchant,
    category_primary: category,
    category_detailed: category,
    account_id: "account-checking",
    account_name: "Checking",
    account_mask: "1234",
    institution_name: "Test Bank",
    amount_minor: amountMinor,
    currency_code: "USD",
    pending,
    excluded_from_spending: excludedFromSpending,
    is_fixed: false,
    split_version: splitVersion,
  };
}

function daysBetween(start, end) {
  return (
    (new Date(`${end}T00:00:00.000Z`) -
      new Date(`${start}T00:00:00.000Z`)) /
    86_400_000
  );
}

test("transactions page builds detailed spending from one complete filtered analysis fetch", async () => {
  const ledgerCalls = [];
  const analysisCalls = [];
  const paginatedLedger = transaction({
    id: "ledger-only",
    postedOn: "2026-07-02",
    amountMinor: -999_999,
    category: "Shopping",
    merchant: "Paginated sentinel",
    splitVersion: 4,
  });
  const analysisTransactions = [
    transaction({
      id: "previous-dining",
      postedOn: "2026-06-01",
      amountMinor: -8_000,
      category: "Dining",
    }),
    transaction({
      id: "previous-fee",
      postedOn: "2026-06-15",
      amountMinor: -4_000,
      category: "Fees & interest",
    }),
    transaction({
      id: "current-dining-boundary",
      postedOn: "2026-06-27",
      amountMinor: -4_000,
      category: "Dining",
    }),
    transaction({
      id: "current-groceries",
      postedOn: "2026-07-01",
      amountMinor: -10_000,
      category: "Groceries",
    }),
    transaction({
      id: "current-dining",
      postedOn: "2026-07-03",
      amountMinor: -3_000,
      category: "Dining",
    }),
    transaction({
      id: "current-dining-refund",
      postedOn: "2026-07-03",
      amountMinor: 500,
      category: "Dining",
    }),
    transaction({
      id: "pending-is-not-spending",
      postedOn: "2026-07-04",
      amountMinor: -70_000,
      category: "Travel",
      pending: true,
    }),
    transaction({
      id: "excluded-is-not-spending",
      postedOn: "2026-07-05",
      amountMinor: -80_000,
      category: "Transfer",
      excludedFromSpending: true,
    }),
  ];
  const repository = {
    async getDataFreshness() {
      return FRESHNESS;
    },
    async listTransactions(_workspaceId, options) {
      ledgerCalls.push(options);
      return {
        transactions: [paginatedLedger],
        pageInfo: { has_more: true, next_cursor: "ledger-page-2" },
      };
    },
    async getTransactionsForPeriod(_workspaceId, options) {
      analysisCalls.push(options);
      return analysisTransactions;
    },
    async listAccounts() {
      return [];
    },
    async listTransactionCategories() {
      return ["Dining", "Fees & interest", "Groceries", "Shopping"];
    },
  };
  const service = createFinanceService({
    repository,
    now: () => new Date("2026-07-26T19:00:00.000Z"),
  });

  const result = await service.getPageData("transactions", {
    query: {
      period: "30",
      q: "coffee",
      account: "account-checking",
      category: "Dining",
      cursor: "ledger-page-1",
    },
  });

  assert.equal(analysisCalls.length, 1);
  assert.deepEqual(analysisCalls[0], {
    startOn: "2026-05-28",
    endOn: "2026-07-27",
    accountId: "account-checking",
    category: "Dining",
    search: "coffee",
  });
  assert.equal(ledgerCalls.length, 1);
  assert.deepEqual(ledgerCalls[0], {
    search: "coffee",
    startOn: "2026-06-27",
    endOn: "2026-07-27",
    accountId: "account-checking",
    category: "Dining",
    status: "all",
    includePending: true,
    limit: 100,
    cursor: "ledger-page-1",
  });
  assert.equal(
    daysBetween(analysisCalls[0].startOn, ledgerCalls[0].startOn),
    daysBetween(ledgerCalls[0].startOn, ledgerCalls[0].endOn),
  );
  assert.equal(analysisCalls[0].endOn, ledgerCalls[0].endOn);

  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].merchant, "Paginated sentinel");
  assert.equal(result.transactions[0].splitVersion, 4);
  assert.equal(result.transactionPageInfo.has_more, true);
  assert.equal(
    result.categories.filter(
      (category) => category.label.toLocaleLowerCase() === "fees & interest",
    ).length,
    1,
  );
  assert.ok(
    result.categories.some(
      (category) => category.label === "Fees & Interest",
    ),
  );
  assert.equal(result.spendingDetails.total.amount_minor, 16_500);
  assert.equal(result.spendingDetails.previousTotal.amount_minor, 12_000);
  assert.equal(result.spendingDetails.change.amount_minor, 4_500);
  assert.equal(result.spendingDetails.trendDirection, "up");
  assert.equal(
    result.spendingDetails.trendLabel,
    "37.5% more than the prior period",
  );
  assert.equal(result.spendingDetails.transactionCount, 4);
  assert.equal(result.spendingDetails.averageTransaction.amount_minor, 4_125);
  assert.equal(
    result.spendingDetails.periodLabel,
    "Jun 27, 2026–Jul 26, 2026",
  );
  assert.equal(
    result.spendingDetails.previousPeriodLabel,
    "May 28, 2026–Jun 26, 2026",
  );
  assert.deepEqual(
    result.spendingDetails.categories.map((category) => ({
      label: category.label,
      amount: category.amount.amount_minor,
      count: category.count,
    })),
    [
      { label: "Groceries", amount: 10_000, count: 1 },
      { label: "Dining", amount: 6_500, count: 3 },
    ],
  );
  assert.equal(result.spendingDetails.seriesLabels.length, 30);
  assert.equal(result.spendingDetails.seriesLabels[0], "Jun 27");
  assert.equal(result.spendingDetails.seriesValues[0], 4_000);
  assert.equal(result.spendingDetails.seriesValues[4], 10_000);
  assert.equal(result.spendingDetails.seriesValues[5], 0);
  assert.equal(result.spendingDetails.seriesValues[6], 2_500);
  assert.equal(
    result.spendingDetails.seriesValues.reduce(
      (sum, amount) => sum + amount,
      0,
    ),
    16_500,
  );
  assert.equal(
    result.spendingDetails.categories.some(
      (category) => category.label === "Shopping",
    ),
    false,
  );
});

test("transactions page presents provider categories and dates as human text", async () => {
  const restaurant = {
    ...transaction({
      id: "restaurant",
      postedOn: "2026-07-27",
      amountMinor: -2_916,
      category: "FOOD_AND_DRINK",
      merchant: "Deans",
      pending: true,
    }),
    posted_on: new Date("2026-07-27T00:00:00.000Z"),
    category_detailed: "FOOD_AND_DRINK_RESTAURANT",
  };
  const repository = {
    async getDataFreshness() {
      return FRESHNESS;
    },
    async listTransactions() {
      return {
        transactions: [restaurant],
        pageInfo: { has_more: false, next_cursor: null },
      };
    },
    async getTransactionsForPeriod() {
      return [];
    },
    async listAccounts() {
      return [];
    },
    async listTransactionCategories() {
      return ["FOOD_AND_DRINK", "GENERAL_MERCHANDISE"];
    },
  };
  const service = createFinanceService({
    repository,
    now: () => new Date("2026-07-27T19:00:00.000Z"),
  });

  const result = await service.getPageData("transactions");

  assert.equal(result.transactions[0].category, "Dining");
  assert.equal(
    result.transactions[0].categoryValue,
    "FOOD_AND_DRINK",
  );
  assert.equal(
    result.transactions[0].accountId,
    "account-checking",
  );
  assert.equal(result.transactions[0].accountMask, "1234");
  assert.equal(result.transactions[0].institution, "Test Bank");
  assert.equal(
    result.transactions[0].detailedCategoryValue,
    "FOOD_AND_DRINK_RESTAURANT",
  );
  assert.equal(result.transactions[0].date, "Jul 27, 2026");
  assert.deepEqual(
    result.categories
      .filter((category) =>
        ["FOOD_AND_DRINK", "GENERAL_MERCHANDISE"].includes(
          category.value,
        ),
      ),
    [
      { value: "FOOD_AND_DRINK", label: "Food & Drink" },
      { value: "GENERAL_MERCHANDISE", label: "Shopping" },
    ],
  );
});

test("transactions prefer trustworthy source times and keep date-only precision honest", async () => {
  const precise = {
    ...transaction({
      id: "precise",
      postedOn: "2026-07-27",
      amountMinor: -2_916,
      category: "FOOD_AND_DRINK",
    }),
    authorized_on: "2026-07-27",
    authorized_at: "2026-07-27T20:34:00.000Z",
    posted_at: "2026-07-28T15:10:09.000Z",
  };
  const postedFallback = {
    ...transaction({
      id: "posted-fallback",
      postedOn: "2026-07-27",
      amountMinor: -1_000,
      category: "SHOPPING",
    }),
    authorized_on: "2026-07-26",
    authorized_at: "2026-07-26T00:00:00.000Z",
    posted_at: "2026-07-27T15:10:09.000Z",
  };
  const placeholderMidnight = {
    ...transaction({
      id: "placeholder-midnight",
      postedOn: "2026-07-27",
      amountMinor: -500,
      category: "UTILITIES",
    }),
    authorized_on: "2026-07-26",
    authorized_at: "2026-07-26T00:00:00.000Z",
    posted_at: "2026-07-27T00:00:00.000Z",
  };
  const repository = {
    async getDataFreshness() {
      return FRESHNESS;
    },
    async listTransactions() {
      return {
        transactions: [precise, postedFallback, placeholderMidnight],
        pageInfo: { has_more: false, next_cursor: null },
      };
    },
    async getTransactionsForPeriod() {
      return [];
    },
    async listAccounts() {
      return [];
    },
    async listTransactionCategories() {
      return [];
    },
  };
  const service = createFinanceService({
    repository,
    now: () => new Date("2026-07-27T21:00:00.000Z"),
  });

  const result = await service.getPageData("transactions");

  assert.deepEqual(
    result.transactions.map(({ id, dateIso, dateTime }) => ({
      id,
      dateIso,
      dateTime,
    })),
    [
      {
        id: "precise",
        dateIso: "2026-07-27",
        dateTime: "2026-07-27T20:34:00.000Z",
      },
      {
        id: "posted-fallback",
        dateIso: "2026-07-27",
        dateTime: "2026-07-27T15:10:09.000Z",
      },
      {
        id: "placeholder-midnight",
        dateIso: "2026-07-26",
        dateTime: null,
      },
    ],
  );

  const publicResult = await service.listTransactions();
  assert.deepEqual(
    publicResult.data.transactions.map(
      ({ id, authorized_on, posted_at }) => ({
        id,
        authorized_on,
        posted_at,
      }),
    ),
    [
      {
        id: "precise",
        authorized_on: "2026-07-27",
        posted_at: "2026-07-28T15:10:09.000Z",
      },
      {
        id: "posted-fallback",
        authorized_on: "2026-07-26",
        posted_at: "2026-07-27T15:10:09.000Z",
      },
      {
        id: "placeholder-midnight",
        authorized_on: "2026-07-26",
        posted_at: "2026-07-27T00:00:00.000Z",
      },
    ],
  );
});

test("category drill-down keeps split ledger, detail, and summary on the same amount", async () => {
  const parent = transaction({
    id: "split-parent",
    postedOn: "2026-07-20",
    amountMinor: -10_000,
    category: "Shopping",
    merchant: "Family market",
    splitVersion: 3,
  });
  const projected = {
    ...parent,
    amount_minor: -4_250,
    provider_amount_minor: -10_000,
    category_primary: "Dining",
    category_detailed: null,
    is_split_category_projection: true,
    split_category_line_count: 2,
  };
  const splits = [
    {
      id: "split-dining-1",
      transaction_id: parent.id,
      line_index: 0,
      category: "Dining",
      amount_minor: -2_500,
    },
    {
      id: "split-dining-2",
      transaction_id: parent.id,
      line_index: 1,
      category: "Dining",
      amount_minor: -1_750,
    },
    {
      id: "split-groceries",
      transaction_id: parent.id,
      line_index: 2,
      category: "Groceries",
      amount_minor: -5_750,
    },
  ];
  const repository = {
    async getDataFreshness() {
      return FRESHNESS;
    },
    async listTransactions(_workspaceId, options) {
      assert.equal(options.category, "Dining");
      assert.equal(options.search, "family");
      return {
        transactions: [projected],
        pageInfo: { has_more: false, next_cursor: null },
      };
    },
    async getTransactionsForPeriod(_workspaceId, options) {
      assert.equal(options.category, null);
      return [parent];
    },
    async listTransactionSplits() {
      return splits;
    },
    async listAccounts() {
      return [];
    },
    async listTransactionCategories() {
      return ["Dining", "Groceries"];
    },
    async getTransaction() {
      return parent;
    },
  };
  const service = createFinanceService({
    repository,
    now: () => new Date("2026-07-26T19:00:00.000Z"),
  });

  const result = await service.getPageData("transactions", {
    query: {
      category: "Dining",
      q: "family",
      transaction: parent.id,
    },
  });

  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].id, parent.id);
  assert.equal(result.transactions[0].category, "Dining");
  assert.equal(result.transactions[0].amount.amount_minor, -4_250);
  assert.equal(
    result.transactions[0].providerAmount.amount_minor,
    -10_000,
  );
  assert.equal(result.transactions[0].isSplitCategoryProjection, true);
  assert.equal(result.transactions[0].splitCategoryLineCount, 2);
  assert.equal(result.selectedTransaction.category, "Dining");
  assert.equal(
    result.selectedTransaction.amount.amount_minor,
    -4_250,
  );
  assert.equal(
    result.selectedTransaction.providerAmount.amount_minor,
    -10_000,
  );
  assert.equal(result.spendingDetails.total.amount_minor, 4_250);
  assert.equal(result.spendingDetails.transactionCount, 1);
  assert.deepEqual(
    result.spendingDetails.categories.map((entry) => ({
      label: entry.label,
      amount: entry.amount.amount_minor,
      count: entry.count,
    })),
    [{ label: "Dining", amount: 4_250, count: 1 }],
  );
});
