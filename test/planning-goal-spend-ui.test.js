import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";

import ejs from "ejs";

import { buildDemoModel } from "../app/demo/webFixtures.js";
import { formatMoney } from "../app/routes/web.js";

const viewsRoot = path.resolve("app/views");

async function renderTransactions(overrides = {}) {
  const demo = buildDemoModel();
  return ejs.renderFile(path.join(viewsRoot, "transactions.ejs"), {
    ...demo,
    formatMoney,
    activePath: "/transactions",
    currentPath: "/transactions",
    pageTitle: "Transactions",
    pageDescription: "Description",
    query: {},
    csrfToken: "csrf-test-value",
    ...overrides,
  });
}

test("posted USD purchases can be partially spent from active goals", async () => {
  const demo = buildDemoModel();
  const selectedTransaction = demo.transactions.find(
    (transaction) => transaction.id === "txn_whole_foods",
  );
  const html = await renderTransactions({
    selectedTransaction,
    selectedTransactionSplits: [],
    selectedTransactionSplitVersion: 0,
    selectedTransactionGoalSpending: {
      transaction_id: selectedTransaction.id,
      goal_spend_version: 3,
      eligible: true,
      goal_spends: [
        {
          id: "goal_spend_road_trip",
          goal_id: "goal_road_trip",
          goal_name: "Road trip",
          goal_version: 7,
          source: "cash",
          amount_minor: 3_500,
        },
      ],
    },
    selectedTransactionGoals: [
      {
        id: "goal_road_trip",
        name: "Road trip",
        status: "active",
        version: 7,
        cash_earmarked: {
          amount_minor: 50_000,
          currency: "USD",
        },
        brokerage_earmarked: {
          amount_minor: 0,
          currency: "USD",
        },
      },
      {
        id: "goal_archived",
        name: "Old goal",
        status: "archived",
        version: 2,
      },
      {
        id: "goal_zero_earmark",
        name: "Vacation overrun",
        status: "active",
        version: 4,
        cash_earmarked: {
          amount_minor: 0,
          currency: "USD",
        },
        brokerage_earmarked: {
          amount_minor: 0,
          currency: "USD",
        },
      },
    ],
  });

  assert.match(html, /<strong>Spend from goal<\/strong>/);
  assert.match(
    html,
    /data-endpoint="\/api\/v1\/transactions\/txn_whole_foods\/goal-spends"/,
  );
  assert.match(
    html,
    /<option value="">Choose a goal<\/option>[\s\S]*?value="goal_road_trip"[\s\S]*?data-goal-version="7"[\s\S]*?>Road trip<\/option>/,
  );
  assert.doesNotMatch(html, /Old goal/);
  assert.match(
    html,
    /value="goal_zero_earmark"[\s\S]*?data-goal-version="4"[\s\S]*?>Vacation overrun<\/option>/,
  );
  assert.match(
    html,
    /value="cash" data-source-label="Cash">Cash · overspend allowed<\/option>/,
  );
  assert.match(
    html,
    /value="brokerage" data-source-label="Brokerage">Brokerage · overspend allowed<\/option>/,
  );
  assert.match(html, /data-money-minor="amount_minor"[^>]*value="103\.42"/);
  assert.match(
    html,
    /name="expected_transaction_version" value="3"/,
  );
  assert.match(
    html,
    /\/goal-spends\/goal_spend_road_trip"[\s\S]*?data-method="DELETE"/,
  );
  assert.match(html, /Road trip[\s\S]*?Cash · \$35\.00/);
  assert.match(html, />Undo<\/button>/);
});

test("income does not expose Spend from goal", async () => {
  const demo = buildDemoModel();
  const selectedTransaction = demo.transactions.find(
    (transaction) => transaction.id === "txn_payroll",
  );
  const html = await renderTransactions({
    selectedTransaction,
    selectedTransactionGoalSpending: {
      transaction_id: selectedTransaction.id,
      goal_spend_version: 0,
      eligible: false,
      goal_spends: [],
    },
    selectedTransactionGoals: [],
  });

  assert.doesNotMatch(html, /Spend from goal/);
});

test("blocked posted outflows disclose why goal spending is unavailable", async () => {
  const demo = buildDemoModel();
  const selectedTransaction = demo.transactions.find(
    (transaction) => transaction.id === "txn_whole_foods",
  );
  const html = await renderTransactions({
    selectedTransaction,
    selectedTransactionGoalSpending: {
      transaction_id: selectedTransaction.id,
      goal_spend_version: 0,
      eligible: false,
      ineligible_reason:
        "Mark this transaction Include in spending before assigning it to a goal.",
      goal_spends: [],
    },
    selectedTransactionGoals: [],
  });

  assert.match(html, /<strong>Spend from goal<\/strong>/);
  assert.match(
    html,
    /Mark this transaction Include in spending before assigning it to a goal\./,
  );
  assert.doesNotMatch(
    html,
    /data-endpoint="\/api\/v1\/transactions\/txn_whole_foods\/goal-spends"\s+data-method="POST"/,
  );
});

test("existing goal spending stays reversible after the transaction becomes ineligible", async () => {
  const demo = buildDemoModel();
  const selectedTransaction = demo.transactions.find(
    (transaction) => transaction.id === "txn_whole_foods",
  );
  const html = await renderTransactions({
    selectedTransaction,
    selectedTransactionGoalSpending: {
      transaction_id: selectedTransaction.id,
      goal_spend_version: 6,
      eligible: false,
      ineligible_reason:
        "This transaction is excluded from spending by its current cleanup rule.",
      goal_spends: [
        {
          id: "goal_spend_preserved",
          goal_id: "goal_vacation",
          goal_name: "Vacation",
          goal_version: 9,
          source: "cash",
          amount_minor: 13_842,
        },
      ],
    },
    selectedTransactionGoals: [],
  });

  assert.match(html, /<strong>Spend from goal<\/strong>/);
  assert.match(html, /Vacation[\s\S]*?Cash · \$138\.42/);
  assert.match(
    html,
    /\/goal-spends\/goal_spend_preserved"[\s\S]*?data-method="DELETE"/,
  );
  assert.match(html, />Undo<\/button>/);
  assert.match(
    html,
    /This transaction is excluded from spending by its current cleanup rule\./,
  );
  assert.doesNotMatch(
    html,
    /data-endpoint="\/api\/v1\/transactions\/txn_whole_foods\/goal-spends"\s+data-method="POST"/,
  );
});

test("goal selection supplies its optimistic version before submit", async () => {
  const source = await readFile(
    path.resolve("app/public/js/money.js"),
    "utf8",
  );

  assert.match(
    source,
    /querySelectorAll\("\[data-goal-spend-form\]"\)[\s\S]*?selectedOptions\?\.\[0\][\s\S]*?dataset\.goalVersion/,
  );
  assert.match(source, /addEventListener\("change", syncGoalVersion\)/);
  assert.match(source, /earmarked · overspend allowed/);
  assert.doesNotMatch(
    source,
    /sourceOption\.disabled\s*=/,
  );
});

test("Plan goal cards show transaction spending", async () => {
  const source = await readFile(
    path.resolve("app/views/plan.ejs"),
    "utf8",
  );

  assert.match(
    source,
    /<dt>Spent<\/dt><dd><%= formatMoney\(goal\.spent/,
  );
});
