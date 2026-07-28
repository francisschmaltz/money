import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEMO_IDS } from "../app/demo/fixtureIds.js";
import { buildDemoModel } from "../app/demo/webFixtures.js";
import {
  createDemoFinanceService,
} from "../app/services/demoFinanceService.js";

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
  const result = await service.listRecurringPayments();
  const serviceIds = new Set(
    result.data.recurring_payments.map((item) => item.id),
  );

  assert.ok(serviceIds.has(DEMO_IDS.recurring.googleWorkspace));
  assert.ok(serviceIds.has(DEMO_IDS.recurring.fidelis));
});
