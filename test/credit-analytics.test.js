import test from "node:test";
import assert from "node:assert/strict";

import { buildCreditSummary } from "../app/services/analytics.js";

function card(
  id,
  balance,
  limit,
  {
    currency = "USD",
    institution = "Bank",
    active = true,
  } = {},
) {
  return {
    id,
    institution_name: institution,
    name: `Card ${id}`,
    mask: id.padStart(4, "0").slice(-4),
    type: "credit",
    subtype: "credit_card",
    current_balance_minor: balance,
    credit_limit_minor: limit,
    currency_code: currency,
    is_liability: true,
    active,
  };
}

function snapshot(accountId, date, balance, limit, currency = "USD") {
  return {
    account_id: accountId,
    snapshot_on: date,
    current_balance_minor: balance,
    credit_limit_minor: limit,
    currency_code: currency,
  };
}

test("credit summary uses a weighted covered ratio without hiding incomplete cards", () => {
  const result = buildCreditSummary({
    accounts: [
      card("a", 250_000, 1_000_000),
      card("b", 100_000, 200_000),
      card("c", 50_000, null),
      card("d", null, 500_000),
      card("e", 40_000, 100_000, { currency: "EUR" }),
      card("closed", 900_000, 1_000_000, { active: false }),
    ],
    currency: "USD",
  });

  assert.deepEqual(result.summary, {
    card_count: 5,
    total_balance_owed: {
      amount_minor: 400_000,
      currency: "USD",
    },
    total_credit_limit: {
      amount_minor: 1_700_000,
      currency: "USD",
    },
    available_credit: {
      amount_minor: 850_000,
      currency: "USD",
    },
    utilization_basis_points: 2_917,
    utilization_covered_card_count: 2,
    missing_limit_card_count: 1,
    missing_balance_card_count: 1,
    excluded_from_usd_total_count: 1,
  });
  assert.equal(result.cards.length, 5);
  assert.equal(
    result.cards.find((entry) => entry.id === "e").credit_limit.currency,
    "EUR",
  );
});

test("credit usage treats overpayments as zero usage and preserves over-limit utilization", () => {
  const result = buildCreditSummary({
    accounts: [
      card("overpaid", -5_000, 100_000),
      card("over-limit", 150_000, 100_000),
    ],
    currency: "USD",
  });
  const overpaid = result.cards.find((entry) => entry.id === "overpaid");
  const overLimit = result.cards.find(
    (entry) => entry.id === "over-limit",
  );

  assert.equal(overpaid.current_balance.amount_minor, -5_000);
  assert.equal(overpaid.balance_owed.amount_minor, 0);
  assert.equal(overpaid.available_credit.amount_minor, 100_000);
  assert.equal(overpaid.utilization_basis_points, 0);
  assert.equal(overpaid.over_limit, false);

  assert.equal(overLimit.balance_owed.amount_minor, 150_000);
  assert.equal(overLimit.available_credit.amount_minor, -50_000);
  assert.equal(overLimit.utilization_basis_points, 15_000);
  assert.equal(overLimit.over_limit, true);
});

test("credit history carries observed cards forward and appends current facts", () => {
  const result = buildCreditSummary({
    accounts: [
      card("a", 200_000, 1_000_000),
      card("b", 100_000, 500_000),
    ],
    snapshots: [
      snapshot("a", "2026-07-01", 100_000, 1_000_000),
      snapshot("b", "2026-07-02", 50_000, 500_000),
    ],
    currency: "USD",
    currentOn: "2026-07-03",
  });

  assert.deepEqual(
    result.series.map((point) => ({
      timestamp: point.timestamp,
      balance: point.balance_owed.amount_minor,
      limit: point.total_credit_limit.amount_minor,
      utilization: point.utilization_basis_points,
      partial: point.partial,
    })),
    [
      {
        timestamp: "2026-07-01",
        balance: 100_000,
        limit: 1_000_000,
        utilization: 1_000,
        partial: false,
      },
      {
        timestamp: "2026-07-02",
        balance: 150_000,
        limit: 1_500_000,
        utilization: 1_000,
        partial: false,
      },
      {
        timestamp: "2026-07-03",
        balance: 300_000,
        limit: 1_500_000,
        utilization: 2_000,
        partial: false,
      },
    ],
  );
  assert.equal(result.cards[0].series.at(-1).timestamp, "2026-07-03");
  assert.equal(
    result.cards[0].series.at(-1).balance_owed.amount_minor,
    200_000,
  );
});

test("historical utilization stays unknown when the captured limit is unknown", () => {
  const result = buildCreditSummary({
    accounts: [card("a", 200_000, 1_000_000)],
    snapshots: [
      snapshot("a", "2026-07-01", 100_000, null),
    ],
    currency: "USD",
    currentOn: "2026-07-02",
  });

  assert.equal(result.cards[0].series[0].credit_limit, null);
  assert.equal(result.cards[0].series[0].utilization_basis_points, null);
  assert.equal(result.series[0].total_credit_limit.amount_minor, 0);
  assert.equal(result.series[0].utilization_basis_points, null);
  assert.equal(result.series[0].partial, true);
  assert.equal(result.series[1].utilization_basis_points, 2_000);
});
