import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import ejs from "ejs";

import {
  buildDemoModel,
  formatMoney,
} from "../app/routes/web.js";

const dashboardView = path.resolve("app/views/dashboard.ejs");

async function renderDashboard(overrides = {}) {
  return ejs.renderFile(dashboardView, {
    ...buildDemoModel(),
    formatMoney,
    activePath: "/",
    currentPath: "/",
    pageTitle: "Dashboard",
    pageDescription: "Description",
    query: {},
    csrfToken: "csrf-test-value",
    dashboardPeriod: {
      name: "1m",
      label: "Past month",
      comparison_label: "in the past month",
      start_on: "2026-06-26",
      end_on: "2026-07-27",
    },
    ...overrides,
  });
}

test("dashboard makes the one-month balance-history timeframe explicit by default", async () => {
  const html = await renderDashboard();

  assert.match(html, /aria-label="Balance history timeframe"/);
  assert.match(
    html,
    /href="\/\?period=1w"[^>]*>1W<\/a>/,
  );
  assert.match(
    html,
    /href="\/\?period=1m"[^>]*aria-current="true"[^>]*>1M<\/a>/,
  );
  assert.match(
    html,
    /href="\/\?period=1y"[^>]*>1Y<\/a>/,
  );
  assert.match(
    html,
    /href="\/\?period=all"[^>]*>All<\/a>/,
  );
});

test("dashboard keeps the compact balance selector below the history chart without segment rows", async () => {
  const html = await renderDashboard();
  const chartPosition = html.indexOf('data-chart="line"');
  const balanceSwitcherPosition = html.indexOf(
    'aria-label="Dashboard balance view"',
  );

  assert.notEqual(chartPosition, -1);
  assert.notEqual(balanceSwitcherPosition, -1);
  assert.ok(
    chartPosition < balanceSwitcherPosition,
    "expected the balance metric switcher below the history chart",
  );
  assert.match(
    html,
    /data-balance-metric="cash"[\s\S]*?aria-pressed="true"[\s\S]*?>Cash<\/button>/,
  );
  assert.match(html, />Short Term<\/button>/);
  assert.match(html, />Retirement<\/button>/);
  assert.match(html, />Net Worth<\/button>/);
  assert.doesNotMatch(html, /class="split-metrics/);
  assert.doesNotMatch(html, /data-balance-detail-/);
});

test("dashboard labels every independently scoped section instead of implying one global timeframe", async () => {
  const html = await renderDashboard();

  assert.match(html, /Jul 19–25 vs Jul 12–18/);
  assert.match(html, /Last 1 month/);
  assert.match(html, /Current active subscriptions/);
  assert.match(
    html,
    /<p class="card-kicker">This month<\/p>\s*<h2 id="spending-heading">Spend by category<\/h2>/,
  );
  assert.match(html, /-10\.4% MoM/);
  assert.match(
    html,
    /class="category-row__label"><strong>Housing<\/strong><small>35% of spending<\/small><\/span>[\s\S]*?class="category-row__value">[\s\S]*?<strong>\$1,450\.00<\/strong>[\s\S]*?<small class="trend--positive">-6\.5% MoM<\/small>/,
  );
  assert.match(
    html,
    /class="category-row__label"><strong>Dining<\/strong><small>13% of spending<\/small><\/span>[\s\S]*?class="category-row__value">[\s\S]*?<strong>\$521\.46<\/strong>[\s\S]*?<small class="trend--negative">\+38\.0% MoM<\/small>/,
  );
  assert.match(html, /Latest activity across all accounts/);
  assert.doesNotMatch(html, />Current period</);
  assert.doesNotMatch(html, /over the displayed history/);
});

test("dashboard marks a selected non-default history timeframe", async () => {
  const html = await renderDashboard({
    query: { period: "1y", metric: "retirement" },
    dashboardPeriod: {
      name: "1y",
      label: "Past year",
      comparison_label: "in the past year",
      start_on: "2025-07-26",
      end_on: "2026-07-27",
    },
  });

  assert.match(
    html,
    /href="\/\?period=1y(?:&amp;metric=retirement)?"[^>]*aria-current="true"[^>]*>1Y<\/a>/,
  );
  assert.doesNotMatch(
    html,
    /href="\/\?period=1m(?:&amp;metric=retirement)?"[^>]*aria-current="true"/,
  );
});
