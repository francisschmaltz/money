import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEMO_IDS } from "../app/demo/fixtureIds.js";
import {
  buildDefaultAccounts,
  buildDefaultBudgetActuals,
  buildDefaultBudgetDefaults,
  buildDefaultRecurringPayments,
  buildDefaultTransactions,
} from "../app/demo/defaultScenario.js";
import { buildDemoModel } from "../app/demo/webFixtures.js";
import {
  createDemoFinanceService,
} from "../app/services/demoFinanceService.js";
import { createDemoPlanningService } from "../app/services/demoPlanningService.js";

test("web routes do not own runtime demo fixtures", async () => {
  const source = await readFile(
    new URL("../app/routes/web.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /from "\.\.\/demo\/webFixtures\.js"/);
  assert.doesNotMatch(
    source,
    /const (transactions|subscriptions|bills|frequentSpending|rawInsights|holdings)\s*=/,
  );
});

test("web and service demo data share canonical entity ids", async () => {
  const model = buildDemoModel();
  const recurringIds = new Set([
    ...model.subscriptions,
    ...model.bills,
    ...model.frequentSpending,
  ].map((item) => item.id));
  const transactionIds = new Set(
    model.transactions.map((transaction) => transaction.id),
  );

  assert.ok(recurringIds.has(DEMO_IDS.recurring.googleWorkspace));
  assert.ok(recurringIds.has(DEMO_IDS.recurring.appleServices));
  assert.ok(transactionIds.has(DEMO_IDS.transactions.delta));

  const service = createDemoFinanceService();
  const accountResult = await service.listAccounts({ limit: 100 });
  const serviceAccounts = accountResult.data.groups.flatMap(
    (group) => group.accounts,
  );
  const transactionResult = await service.listTransactions({
    status: "all",
    limit: 100,
  });
  const result = await service.listRecurringPayments();
  const serviceIds = new Set(
    result.data.recurring_payments.map((item) => item.id),
  );

  assert.ok(serviceIds.has(DEMO_IDS.recurring.googleWorkspace));
  assert.ok(serviceIds.has(DEMO_IDS.recurring.fidelis));
  assert.deepEqual(
    new Set(model.accounts.map((account) => account.id)),
    new Set(serviceAccounts.map((account) => account.id)),
  );
  assert.deepEqual(
    new Set(model.transactions.map((transaction) => transaction.id)),
    new Set(
      transactionResult.data.transactions.map(
        (transaction) => transaction.id,
      ),
    ),
  );
  assert.ok(
    model.transactions.every((transaction) =>
      serviceAccounts.some(
        (account) => account.id === transaction.accountId,
      ),
    ),
  );
  assert.equal(buildDefaultAccounts().length, 8);
  assert.equal(buildDefaultTransactions().length, 16);
});

test("every posted default transaction supports a real batch edit", async () => {
  const service = createDemoFinanceService();
  const listed = await service.listTransactions({
    status: "posted",
    limit: 100,
  });
  const ids = listed.data.transactions.map(
    (transaction) => transaction.id,
  );

  const updated = await service.batchEditTransactions({
    transaction_ids: ids,
    changes: { category_primary: "Reviewed" },
  });
  const refreshed = await service.listTransactions({
    status: "posted",
    limit: 100,
  });

  assert.equal(updated.updated_count, ids.length);
  assert.equal(ids.length, 15);
  assert.ok(
    refreshed.data.transactions.every(
      (transaction) =>
        transaction.category_primary === "Reviewed",
    ),
  );
});

test("planning totals and budget actuals use the canonical defaults", async () => {
  const planning = createDemoPlanningService();
  const safeToSpend = await planning.getSafeToSpend();
  const budget = await planning.getBudgetStatus();
  const accountTotals = buildDefaultAccounts().reduce(
    (totals, account) => {
      totals[account.balance_group] =
        (totals[account.balance_group] ?? 0) +
        account.current_balance.amount_minor;
      return totals;
    },
    {},
  );
  const plannedTotal = [
    ...buildDefaultBudgetDefaults().values(),
  ].reduce((sum, value) => sum + value, 0);
  const actualTotal = [
    ...buildDefaultBudgetActuals().values(),
  ].reduce((sum, value) => sum + value, 0);
  const expectedBills = buildDefaultRecurringPayments()
    .filter((stream) => stream.type === "bill")
    .reduce(
      (sum, stream) => sum + stream.expected_amount.amount_minor,
      0,
    );

  assert.equal(
    safeToSpend.data.liquid_cash.amount_minor,
    accountTotals.cash,
  );
  assert.equal(
    safeToSpend.data.current_card_liabilities.amount_minor,
    accountTotals.credit_card,
  );
  assert.equal(
    safeToSpend.data.taxable_brokerage_value.amount_minor,
    accountTotals.taxable_investment,
  );
  assert.equal(
    safeToSpend.data.expected_bills.amount_minor,
    expectedBills,
  );
  assert.equal(
    safeToSpend.data.safe_to_spend.amount_minor,
    safeToSpend.data.liquid_cash.amount_minor -
      safeToSpend.data.current_card_liabilities.amount_minor -
      expectedBills -
      safeToSpend.data.cash_goal_earmarks.amount_minor,
  );
  assert.equal(
    budget.data.planned_total.amount_minor,
    plannedTotal,
  );
  assert.equal(budget.data.actual_total.amount_minor, actualTotal);
});
