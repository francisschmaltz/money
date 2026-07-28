import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import express from "express";
import request from "supertest";

import { DEMO_IDS } from "../app/demo/fixtureIds.js";
import {
  buildDefaultPortfolioHoldings,
  buildDefaultRecurringPayments,
} from "../app/demo/defaultScenario.js";
import {
  buildUxStressTransactions,
  uxStressAccount,
} from "../app/demo/uxStressScenario.js";
import { buildDemoModel } from "../app/demo/webFixtures.js";
import { createWebRouter } from "../app/routes/web.js";
import {
  createDemoFinanceService,
} from "../app/services/demoFinanceService.js";

const viewsRoot = path.resolve("app/views");

function demoApp(financeService, demoScenario = "default") {
  const app = express();
  app.set("views", viewsRoot);
  app.set("view engine", "ejs");
  app.use(
    createWebRouter({
      demoMode: true,
      demoScenario,
      financeService,
    }),
  );
  return app;
}

test("UX-stress dashboard wealth and transaction account refs use service-owned accounts", async () => {
  const model = buildDemoModel({ scenario: "ux-stress" });
  const service = createDemoFinanceService({
    scenario: "ux-stress",
  });
  const overview = await service.getFinanceOverview();

  assert.equal(
    model.overview.cash.amount_minor,
    overview.data.cash.amount_minor,
  );
  assert.equal(
    model.overview.cashBalance.amount_minor,
    overview.data.cash_balance.amount_minor,
  );
  assert.equal(
    model.overview.shortTermWorth.amount_minor,
    overview.data.short_term_worth.amount_minor,
  );
  assert.equal(
    model.overview.assets.amount_minor,
    overview.data.assets.amount_minor,
  );
  assert.equal(
    model.overview.liabilities.amount_minor,
    overview.data.liabilities.amount_minor,
  );
  assert.equal(
    model.overview.netWorth.amount_minor,
    overview.data.net_worth.amount_minor,
  );
  assert.equal(
    model.wealthSeries.net_worth.at(-1),
    overview.data.net_worth.amount_minor,
  );

  const stressAccount = uxStressAccount();
  const stressTransaction = buildUxStressTransactions().find(
    (transaction) =>
      transaction.account.id === stressAccount.id,
  );
  assert.deepEqual(stressTransaction.account, {
    id: stressAccount.id,
    name: stressAccount.name,
    mask: stressAccount.mask,
    institution: stressAccount.institution_name,
  });
});

test("every rendered recurring item is editable and classification persists after reload", async () => {
  const service = createDemoFinanceService();
  const model = buildDemoModel();
  const renderedIds = new Set(
    [
      ...model.subscriptions,
      ...model.bills,
      ...model.frequentSpending,
    ].map((stream) => stream.id),
  );
  const listed = await service.listRecurringPayments({
    kind: "all",
    limit: 100,
  });
  const serviceIds = new Set(
    listed.data.recurring_payments.map((stream) => stream.id),
  );

  assert.deepEqual(renderedIds, serviceIds);
  assert.deepEqual(
    serviceIds,
    new Set(buildDefaultRecurringPayments().map((stream) => stream.id)),
  );

  await service.updateRecurringClassification({
    stream_id: DEMO_IDS.recurring.adobe,
    type: "bill",
  });
  const response = await request(demoApp(service))
    .get(`/recurring?item=${DEMO_IDS.recurring.adobe}`)
    .expect(200);
  const subscriptions = response.text.slice(
    response.text.indexOf('id="subscriptions-heading"'),
    response.text.indexOf('id="frequent-spending-heading"'),
  );
  const bills = response.text.slice(
    response.text.indexOf('id="bills-heading"'),
  );

  assert.doesNotMatch(
    subscriptions,
    new RegExp(`item=${DEMO_IDS.recurring.adobe}`),
  );
  assert.match(
    bills,
    new RegExp(`item=${DEMO_IDS.recurring.adobe}`),
  );
  assert.match(
    response.text,
    /<option value="bill" selected>Bill<\/option>/,
  );

  const freshService = createDemoFinanceService();
  const freshAdobe = (
    await freshService.listRecurringPayments({
      kind: "all",
      limit: 100,
    })
  ).data.recurring_payments.find(
    (stream) => stream.id === DEMO_IDS.recurring.adobe,
  );
  assert.equal(freshAdobe.type, "subscription");
});

test("web and service portfolio holdings come from the same records", async () => {
  const service = createDemoFinanceService();
  const model = buildDemoModel();
  const result = await service.getPortfolioSummary({
    retirement_scope: "include",
    holdings_limit: 100,
  });
  const serviceById = new Map(
    result.data.holdings.map((holding) => [holding.id, holding]),
  );

  assert.deepEqual(
    new Set(model.holdings.map((holding) => holding.id)),
    new Set(buildDefaultPortfolioHoldings().map((holding) => holding.id)),
  );
  for (const holding of model.holdings) {
    const serviceHolding = serviceById.get(holding.id);
    assert.ok(serviceHolding);
    assert.equal(
      holding.value.amount_minor,
      serviceHolding.value.amount_minor,
    );
    assert.equal(
      holding.costBasis.amount_minor,
      serviceHolding.cost_basis.amount_minor,
    );
    assert.equal(
      holding.price?.amount_minor ?? null,
      serviceHolding.price?.amount_minor ?? null,
    );
    assert.equal(
      holding.symbol,
      serviceHolding.display_symbol,
    );
  }
});

test("single and bulk insight actions persist by stable card ID after reload", async () => {
  const service = createDemoFinanceService();
  const app = demoApp(service);
  const diningId = DEMO_IDS.insights.weeklyDining;
  const coffeeId = DEMO_IDS.insights.weeklyCoffee;

  let response = await request(app).get("/insights").expect(200);
  assert.match(
    response.text,
    new RegExp(`data-finding-id="${diningId}"`),
  );

  await service.actOnFinding({
    finding_id: diningId,
    action: "archive",
  });
  response = await request(app).get("/insights").expect(200);
  assert.doesNotMatch(
    response.text,
    new RegExp(`data-finding-id="${diningId}"`),
  );
  response = await request(app)
    .get("/insights?view=archive")
    .expect(200);
  assert.match(
    response.text,
    new RegExp(`data-finding-id="${diningId}"`),
  );

  await service.batchActOnFindings({
    finding_ids: [diningId, coffeeId],
    action: "restore",
  });
  response = await request(app).get("/insights").expect(200);
  assert.match(
    response.text,
    new RegExp(`data-finding-id="${diningId}"`),
  );
  assert.match(
    response.text,
    new RegExp(`data-finding-id="${coffeeId}"`),
  );

  await assert.rejects(
    service.actOnFinding({
      finding_id: "finding_weekly_dining",
      action: "archive",
    }),
    (error) => error.statusCode === 404,
  );
});
