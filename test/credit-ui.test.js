import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";

import ejs from "ejs";

import {
  buildDemoModel,
  formatMoney,
} from "../app/routes/web.js";

const creditView = path.resolve("app/views/credit.ejs");

async function renderCredit(overrides = {}) {
  return ejs.renderFile(creditView, {
    ...buildDemoModel(),
    formatMoney,
    activePath: "/credit",
    currentPath: "/credit",
    pageTitle: "Credit",
    pageDescription: "Limits, balances, and utilization.",
    query: {},
    csrfToken: "csrf-test-value",
    ...overrides,
  });
}

test("credit page defaults to one month and shows weighted totals", async () => {
  const demo = buildDemoModel();
  const html = await renderCredit();

  assert.match(html, /href="\/credit" aria-current="page"/);
  assert.match(html, /aria-label="Credit page timeframe"/);
  assert.match(
    html,
    /href="\/credit\?period=1m" aria-current="true">1M<\/a>/,
  );
  assert.match(html, /<p class="card-kicker">Total utilization<\/p>/);
  assert.match(html, />\s*23\.5%\s*<\/h2>/);
  assert.match(
    html,
    /\$2,814\.63 used of\s+\$12,000\.00\s+total limit/,
  );
  assert.match(html, /data-chart="credit"/);
  assert.match(html, /Sapphire Preferred/);
  assert.match(html, /Blue Cash Preferred/);
  assert.match(html, />27\.6%<\/strong>/);
  assert.match(html, />17\.6%<\/strong>/);
  assert.match(html, /\$9,185\.37/);
  assert.doesNotMatch(html, /\bAPR\b|Payment due|Rewards/);
  assert.ok(
    html.indexOf("Tracked household average") <
      html.indexOf("Total utilization"),
  );
  assert.match(html, /planning metric only, not a lender or underwriting score/);
  assert.match(html, /data-chart="credit-score"/);
  assert.match(html, /data-series="[^"]*Francis/);
  assert.match(html, /data-series="[^"]*Household member/);
  assert.match(html, /data-series="[^"]*Household average/);
  assert.equal(
    (html.match(/class="period-select period-select--credit"/g) || [])
      .length,
    1,
  );
  assert.ok(
    html.indexOf('class="credit-page-toolbar"') <
      html.indexOf('class="credit-overview-grid"'),
  );
  assert.match(html, /class="credit-overview-grid"/);
  assert.match(
    html,
    /class="credit-overview-grid"[\s\S]*class="card credit-score-card"[\s\S]*class="card credit-hero"/,
  );
  assert.doesNotMatch(html, /score_period=/);
  assert.match(html, /data-credit-score-dialog-open/);
  assert.match(html, /<dialog class="credit-score-dialog"/);
  assert.match(html, /Manage my scores/);
  assert.match(html, /2 sources · updated 6 days ago/);
  assert.match(html, /1 source · updated 16 days ago/);
  assert.match(html, /American Express/);
  assert.match(html, /Credit Karma–TransUnion/);
  assert.match(html, /data-credit-score-source-create/);
  assert.match(html, /data-credit-score-observation/);
  assert.match(html, /Entry history \(1\)/);
  assert.match(html, /data-credit-score-correct/);
  assert.ok(
    html.indexOf("data-credit-score-source-create") >
      html.indexOf('<dialog class="credit-score-dialog"'),
  );

  const credit = demo.creditData;
  assert.equal(
    credit.cards.reduce(
      (sum, card) => sum + card.balance_owed.amount_minor,
      0,
    ),
    credit.summary.total_balance_owed.amount_minor,
  );
  assert.equal(
    credit.cards.reduce(
      (sum, card) => sum + card.credit_limit.amount_minor,
      0,
    ),
    credit.summary.total_credit_limit.amount_minor,
  );
  assert.equal(
    credit.summary.utilization_basis_points,
    Math.round(
      (credit.summary.total_balance_owed.amount_minor /
        credit.summary.total_credit_limit.amount_minor) *
        10_000,
    ),
  );
});

test("credit score forms capture values before disabling their controls", async () => {
  const source = await readFile(
    path.resolve("app/public/js/money.js"),
    "utf8",
  );

  assert.match(
    source,
    /const sourceInput = sourcePayload\(form\);\s+const observation = observationPayload\(form\);\s+setBusy\(form, true, "Adding source…"\);/,
  );
  assert.match(
    source,
    /const observation = observationPayload\(form\);\s+setBusy\(form, true, "Saving score…"\);/,
  );
  assert.match(
    source,
    /const sourceInput = sourcePayload\(form\);\s+setBusy\(form, true, "Saving source…"\);/,
  );
});

test("credit timeframe switcher selects the requested history", async () => {
  const demo = buildDemoModel();
  const html = await renderCredit({
    query: { period: "all" },
    creditData: demo.creditHistories.all,
    creditScoreData: {
      ...demo.creditScoreData,
      period: {
        ...demo.creditScoreData.period,
        name: "all",
        label: "All history",
      },
    },
  });

  assert.match(
    html,
    /href="\/credit\?period=all" aria-current="true">All<\/a>/,
  );
  assert.doesNotMatch(
    html,
    /href="\/credit\?period=1m" aria-current="true"/,
  );
  assert.match(html, /Credit utilization over all history/);
});

test("credit page renders an honest empty state", async () => {
  const demo = buildDemoModel();
  const html = await renderCredit({
    creditData: {
      period: demo.creditHistories["1m"].period,
      summary: {
        card_count: 0,
        total_balance_owed: { amount_minor: 0, currency: "USD" },
        total_credit_limit: { amount_minor: 0, currency: "USD" },
        available_credit: { amount_minor: 0, currency: "USD" },
        utilization_basis_points: null,
        utilization_covered_card_count: 0,
        missing_limit_card_count: 0,
        missing_balance_card_count: 0,
        excluded_from_usd_total_count: 0,
      },
      cards: [],
      series: [],
      partial: false,
      warnings: [],
    },
  });

  assert.match(html, />No credit cards connected</);
  assert.match(html, />Connect account</);
  assert.match(
    html,
    /History begins with the first snapshot that includes a reported limit/,
  );
});
