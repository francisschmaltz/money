import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSpendingSummary,
  shiftDateOnly,
} from "../app/services/analytics.js";
import { createFinanceService } from "../app/services/financeService.js";

const CURRENT_PERIOD = {
  start_on: "2026-04-30",
  end_on: "2026-07-29",
};
const PREVIOUS_PERIOD = {
  start_on: "2026-01-30",
  end_on: "2026-04-30",
};
const FRESHNESS = {
  data_as_of: "2026-07-28T18:00:00.000Z",
  partial: false,
  warnings: [],
};

function transaction({
  id,
  postedOn,
  amountMinor = -1_000,
  category = "Dining",
  merchant = "Merchant",
  displayName,
  currency = "USD",
  pending = false,
  excludedFromSpending = false,
}) {
  return {
    id,
    posted_on: postedOn,
    authorized_at: null,
    merchant_name: merchant,
    name: merchant,
    ...(displayName === undefined
      ? {}
      : { display_name: displayName }),
    category_primary: category,
    category_detailed: category,
    account_id: "account-checking",
    account_name: "Checking",
    account_mask: "1234",
    institution_name: "Test Bank",
    amount_minor: amountMinor,
    currency_code: currency,
    pending,
    excluded_from_spending: excludedFromSpending,
    is_fixed: false,
    split_version: 0,
  };
}

function seriesTotal(series) {
  return series.reduce(
    (sum, point) => sum + point.value.amount_minor,
    0,
  );
}

function repositoryFor(transactions) {
  const filteredTransactions = (options = {}) =>
    transactions.filter((entry) => {
      if (
        options.merchant &&
        (entry.display_name ??
          entry.merchant_name ??
          entry.name) !== options.merchant
      ) {
        return false;
      }
      if (
        options.category &&
        entry.category_primary !== options.category
      ) {
        return false;
      }
      return true;
    });
  return {
    async getDataFreshness() {
      return FRESHNESS;
    },
    async listTransactions(_workspaceId, options = {}) {
      const filtered = filteredTransactions(options);
      return {
        transactions: filtered.slice(0, 100),
        pageInfo: {
          has_more: filtered.length > 100,
          next_cursor:
            filtered.length > 100 ? "ledger-page-2" : null,
        },
      };
    },
    async getTransactionsForPeriod(_workspaceId, options = {}) {
      return filteredTransactions(options);
    },
    async listAccounts() {
      return [];
    },
    async listTransactionCategories() {
      return [
        ...new Set(
          transactions.map((entry) => entry.category_primary),
        ),
      ];
    },
  };
}

test("spending summaries group by merchant with stable top-eight segments and summed Other", () => {
  const transactions = Array.from({ length: 10 }, (_, index) =>
    transaction({
      id: `merchant-${index}`,
      postedOn: shiftDateOnly("2026-05-01", index * 7),
      amountMinor: -(index + 1) * 1_000,
      merchant: `Merchant ${index}`,
    }),
  );
  const first = buildSpendingSummary({
    transactions,
    currentPeriod: CURRENT_PERIOD,
    previousPeriod: PREVIOUS_PERIOD,
    groupBy: "merchant",
    segmentLimit: 8,
    includeSegmentDetails: true,
  });
  const reordered = buildSpendingSummary({
    transactions: [...transactions].reverse(),
    currentPeriod: CURRENT_PERIOD,
    previousPeriod: PREVIOUS_PERIOD,
    groupBy: "merchant",
    segmentLimit: 8,
    includeSegmentDetails: true,
  });

  assert.equal(first.series_interval, "week");
  assert.equal(seriesTotal(first.series), first.total.amount_minor);
  assert.equal(first.segments.length, 9);
  assert.equal(first.segments.at(-1).key, "merchant-other");
  assert.equal(first.segments.at(-1).label, "Other");
  assert.equal(first.segments.at(-1).amount.amount_minor, 3_000);
  assert.equal(
    seriesTotal(first.segments.at(-1).series),
    first.segments.at(-1).amount.amount_minor,
  );
  assert.equal(
    new Set(first.segments.map((segment) => segment.key)).size,
    first.segments.length,
  );
  assert.deepEqual(
    new Map(
      first.segments.map((segment) => [
        segment.label,
        segment.key,
      ]),
    ),
    new Map(
      reordered.segments.map((segment) => [
        segment.label,
        segment.key,
      ]),
    ),
  );
  for (const segment of first.segments) {
    assert.equal(seriesTotal(segment.series), segment.amount.amount_minor);
  }
});

test("merchant analytics group and label by the verbatim effective name", () => {
  const summary = buildSpendingSummary({
    transactions: [
      transaction({
        id: "raw-one",
        postedOn: "2026-07-10",
        amountMinor: -1_000,
        merchant: "ACME #0042",
        displayName: "acme & Sons™",
      }),
      transaction({
        id: "raw-two",
        postedOn: "2026-07-11",
        amountMinor: -2_000,
        merchant: "ACME ONLINE 991",
        displayName: "acme & Sons™",
      }),
    ],
    currentPeriod: {
      start_on: "2026-07-01",
      end_on: "2026-08-01",
    },
    previousPeriod: {
      start_on: "2026-06-01",
      end_on: "2026-07-01",
    },
    groupBy: "merchant",
  });

  assert.deepEqual(
    summary.segments.map((segment) => [
      segment.label,
      segment.amount.amount_minor,
      segment.count,
    ]),
    [["acme & Sons™", 3_000, 2]],
  );
});

test("refund-only groups remain in the breakdown so every plotted value reconciles", () => {
  const summary = buildSpendingSummary({
    transactions: [
      transaction({
        id: "purchase",
        postedOn: "2026-07-10",
        amountMinor: -10_000,
        category: "Dining",
      }),
      transaction({
        id: "refund",
        postedOn: "2026-07-11",
        amountMinor: 5_000,
        category: "Travel",
      }),
    ],
    currentPeriod: {
      start_on: "2026-07-01",
      end_on: "2026-08-01",
    },
    previousPeriod: {
      start_on: "2026-06-01",
      end_on: "2026-07-01",
    },
    includeSegmentDetails: true,
  });

  assert.equal(summary.total.amount_minor, 5_000);
  assert.deepEqual(
    summary.segments.map((segment) => [
      segment.label,
      segment.amount.amount_minor,
    ]),
    [
      ["Dining", 10_000],
      ["Travel", -5_000],
    ],
  );
  assert.equal(
    summary.segments.reduce(
      (sum, segment) => sum + segment.amount.amount_minor,
      0,
    ),
    summary.total.amount_minor,
  );
  assert.ok(
    summary.segments.every(
      (segment) =>
        seriesTotal(segment.series) === segment.amount.amount_minor,
    ),
  );
});

test("spending timelines use lossless daily, weekly, and monthly buckets", () => {
  const cases = [
    {
      period: { start_on: "2026-07-01", end_on: "2026-07-31" },
      previous: { start_on: "2026-06-01", end_on: "2026-07-01" },
      interval: "day",
      transactionDates: ["2026-07-01", "2026-07-15", "2026-07-30"],
    },
    {
      period: CURRENT_PERIOD,
      previous: PREVIOUS_PERIOD,
      interval: "week",
      transactionDates: ["2026-04-30", "2026-06-14", "2026-07-28"],
    },
    {
      period: { start_on: "2025-07-29", end_on: "2026-07-29" },
      previous: { start_on: "2024-07-29", end_on: "2025-07-29" },
      interval: "month",
      transactionDates: ["2025-07-29", "2026-01-17", "2026-07-28"],
    },
  ];

  for (const expected of cases) {
    const rows = expected.transactionDates.map((postedOn, index) =>
      transaction({
        id: `${expected.interval}-${index}`,
        postedOn,
        amountMinor: index === 1 ? 250 : -(index + 1) * 1_000,
      }),
    );
    const summary = buildSpendingSummary({
      transactions: rows,
      currentPeriod: expected.period,
      previousPeriod: expected.previous,
      includeSegmentDetails: true,
    });

    assert.equal(summary.series_interval, expected.interval);
    assert.equal(seriesTotal(summary.series), summary.total.amount_minor);
    assert.equal(
      seriesTotal(summary.segments[0].series),
      summary.segments[0].amount.amount_minor,
    );
  }
});

test("spending eligibility explains matches that contain no posted spending", () => {
  const rows = [
    transaction({
      id: "income",
      postedOn: "2026-07-20",
      amountMinor: 100_000,
      category: "Income",
    }),
    transaction({
      id: "pending",
      postedOn: "2026-07-21",
      pending: true,
    }),
    transaction({
      id: "excluded",
      postedOn: "2026-07-22",
      excludedFromSpending: true,
    }),
    transaction({
      id: "foreign",
      postedOn: "2026-07-23",
      currency: "CAD",
    }),
    transaction({
      id: "zero",
      postedOn: "2026-07-24",
      amountMinor: 0,
    }),
  ];
  const summary = buildSpendingSummary({
    transactions: rows,
    currentPeriod: {
      start_on: "2026-07-01",
      end_on: "2026-07-29",
    },
    previousPeriod: {
      start_on: "2026-06-03",
      end_on: "2026-07-01",
    },
  });

  assert.equal(summary.has_eligible_spending, false);
  assert.equal(summary.total.amount_minor, 0);
  assert.equal(seriesTotal(summary.series), 0);
  assert.deepEqual(summary.eligibility, {
    matched_transaction_count: 5,
    eligible_transaction_count: 0,
    excluded_transaction_count: 5,
    reasons: {
      pending: 1,
      income: 1,
      excluded_from_spending: 1,
      other_currency: 1,
      zero_amount: 1,
    },
  });
});

test("transactions page uses the full analysis set and merchant rows become exact filters", async () => {
  const transactions = Array.from({ length: 205 }, (_, index) =>
    transaction({
      id: `transaction-${index}`,
      postedOn: shiftDateOnly("2026-05-01", index % 80),
      amountMinor: -(index + 1) * 10,
      category: `Category ${index % 10}`,
      merchant: `Merchant ${index % 10}`,
    }),
  );
  const expectedTotal = transactions.reduce(
    (sum, entry) => sum - entry.amount_minor,
    0,
  );
  const service = createFinanceService({
    repository: repositoryFor(transactions),
    now: () => new Date("2026-07-28T19:00:00.000Z"),
  });

  const initial = await service.getPageData("transactions", {
    query: {
      period: "90",
      analytics_group: "merchant",
    },
  });

  assert.equal(initial.transactions.length, 100);
  assert.equal(initial.transactionPageInfo.has_more, true);
  assert.equal(initial.spendingDetails.total.amount_minor, expectedTotal);
  assert.equal(initial.spendingDetails.activeGrouping, "merchant");
  assert.equal(initial.spendingDetails.seriesInterval, "week");
  assert.equal(initial.spendingDetails.seriesLabel, "Weekly spending");
  assert.equal(initial.spendingDetails.groupings.category.segments.length, 9);
  assert.equal(initial.spendingDetails.groupings.merchant.segments.length, 9);
  assert.equal(
    initial.spendingDetails.seriesValues.reduce(
      (sum, amount) => sum + amount,
      0,
    ),
    expectedTotal,
  );

  const selectedMerchant =
    initial.spendingDetails.groupings.merchant.segments[0].label;
  const merchantTransactions = transactions.filter(
    (entry) => entry.merchant_name === selectedMerchant,
  );
  const merchantTotal = merchantTransactions.reduce(
    (sum, entry) => sum - entry.amount_minor,
    0,
  );
  const selected = await service.getPageData("transactions", {
    query: {
      period: "90",
      analytics_group: "merchant",
      merchant: selectedMerchant,
    },
  });

  assert.equal(selected.spendingDetails.activeSegmentKey, null);
  assert.equal(selected.spendingDetails.selectedSegment, null);
  assert.equal(selected.transactions.length, merchantTransactions.length);
  assert.ok(
    selected.transactions.every(
      (entry) => entry.displayName === selectedMerchant,
    ),
  );
  assert.equal(selected.spendingDetails.total.amount_minor, merchantTotal);
  assert.equal(
    selected.spendingDetails.seriesValues.reduce(
      (sum, amount) => sum + amount,
      0,
    ),
    merchantTotal,
  );

  const invalid = await service.getPageData("transactions", {
    query: {
      period: "90",
      analytics_group: "not-a-group",
      analytics_segment: "not-a-segment",
    },
  });
  assert.equal(invalid.spendingDetails.activeGrouping, "category");
  assert.equal(invalid.spendingDetails.activeSegmentKey, null);
  assert.equal(invalid.spendingDetails.selectedSegment, null);
});

test("transactions page distinguishes no matches from matches with no eligible spending", async () => {
  const transactions = [
    transaction({
      id: "income",
      postedOn: "2026-07-20",
      amountMinor: 300_000,
      category: "Income",
    }),
    transaction({
      id: "pending",
      postedOn: "2026-07-21",
      pending: true,
    }),
    transaction({
      id: "excluded",
      postedOn: "2026-07-22",
      excludedFromSpending: true,
    }),
  ];
  const service = createFinanceService({
    repository: repositoryFor(transactions),
    now: () => new Date("2026-07-28T19:00:00.000Z"),
  });

  const result = await service.getPageData("transactions", {
    query: { period: "90" },
  });

  assert.equal(result.spendingDetails.hasMatchingTransactions, true);
  assert.equal(result.spendingDetails.hasEligibleSpending, false);
  assert.equal(result.spendingDetails.emptyReason, "no_eligible_spending");
  assert.equal(result.spendingDetails.transactionCount, 0);
  assert.equal(result.spendingDetails.total.amount_minor, 0);
  assert.deepEqual(result.spendingDetails.eligibility.reasons, {
    pending: 1,
    income: 1,
    excludedFromSpending: 1,
    otherCurrency: 0,
    zeroAmount: 0,
  });

  const emptyService = createFinanceService({
    repository: repositoryFor([]),
    now: () => new Date("2026-07-28T19:00:00.000Z"),
  });
  const empty = await emptyService.getPageData("transactions", {
    query: { period: "90", q: "definitely-not-here" },
  });

  assert.equal(empty.spendingDetails.hasMatchingTransactions, false);
  assert.equal(empty.spendingDetails.hasEligibleSpending, false);
  assert.equal(empty.spendingDetails.emptyReason, "no_matches");
});
