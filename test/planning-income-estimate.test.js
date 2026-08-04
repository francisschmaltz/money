import assert from "node:assert/strict";
import test from "node:test";

import { projectedIncomeForTransactions } from "../app/services/planningService.js";

function income({ id, name, account, amount, tags = [] }) {
  return {
    id,
    display_name: name,
    account_id: account,
    amount_minor: amount,
    currency_code: "USD",
    category_id: "income",
    posted_on: "2026-07-01",
    pending: false,
    excluded_from_spending: false,
    tags,
  };
}

test("bonus income uses its name and account normal-check average", () => {
  const transactions = [
    income({ id: "bee-1", name: "Cisco Paycheck", account: "bee", amount: 450_000 }),
    income({ id: "bee-2", name: "Cisco Paycheck", account: "bee", amount: 450_000 }),
    income({ id: "bee-bonus", name: "Cisco Paycheck", account: "bee", amount: 4_000_000, tags: ["Bonus"] }),
    income({ id: "self-1", name: "Cisco Paycheck", account: "self", amount: 47_908 }),
    income({ id: "self-2", name: "Cisco Paycheck", account: "self", amount: 54_628 }),
    income({ id: "east-1", name: "East Bay Foundation Paycheck", account: "bee", amount: 163_890 }),
    income({ id: "east-2", name: "East Bay Foundation Paycheck", account: "bee", amount: 226_950 }),
  ];

  assert.equal(
    projectedIncomeForTransactions(
      transactions,
      new Set(["income"]),
      "USD",
    ),
    450_000 + 450_000 + 450_000 + 47_908 + 54_628 + 163_890 + 226_950,
  );
});

test("a dedicated bonus stream without normal history adds no planned income", () => {
  assert.equal(
    projectedIncomeForTransactions(
      [
        income({
          id: "annual-bonus",
          name: "Annual Bonus",
          account: "self",
          amount: 4_000_000,
          tags: ["bonus"],
        }),
      ],
      new Set(["income"]),
      "USD",
    ),
    0,
  );
});
