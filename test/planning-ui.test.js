import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";

import ejs from "ejs";

import { buildDemoModel } from "../app/demo/webFixtures.js";
import { formatMoney } from "../app/routes/web.js";
import { createDemoPlanningService } from "../app/services/demoPlanningService.js";

const viewsRoot = path.resolve("app/views");

async function renderPlan(overrides = {}) {
  const overview =
    await createDemoPlanningService().getPlanningOverview();
  return ejs.renderFile(path.join(viewsRoot, "plan.ejs"), {
    ...buildDemoModel(),
    ...overview,
    formatMoney,
    activePath: "/plan",
    currentPath: "/plan",
    pageTitle: "Plan",
    query: {},
    csrfToken: "csrf-test-value",
    includeSearchDialog: false,
    ...overrides,
  });
}

test("transaction split Save and Clear include planning idempotency", async () => {
  const source = await readFile(
    path.resolve("app/public/js/money.js"),
    "utf8",
  );
  const splitBranch = source.match(
    /if \(form\.dataset\.transactionSplit !== undefined\) \{[\s\S]*?\n      \}/,
  )?.[0];

  assert.ok(splitBranch);
  assert.match(
    splitBranch,
    /lines: \[\],[\s\S]*expected_version: Number\([\s\S]*idempotency_key: idempotencyKeyFor\(form\)/,
  );
  assert.match(
    splitBranch,
    /lines: \[\.\.\.form\.querySelectorAll\("\[data-split-line\]"\)\][\s\S]*expected_version: Number\([\s\S]*idempotency_key: idempotencyKeyFor\(form\)/,
  );
});

test("Dashboard and Plan share the same link-free Safe to Spend component", async () => {
  const source = await readFile(
    path.resolve("app/public/css/money.css"),
    "utf8",
  );
  const partial = await readFile(
    path.resolve("app/views/partials/safe-to-spend-card.ejs"),
    "utf8",
  );
  const dashboard = await readFile(
    path.resolve("app/views/dashboard.ejs"),
    "utf8",
  );
  const plan = await readFile(
    path.resolve("app/views/plan.ejs"),
    "utf8",
  );

  assert.match(
    source,
    /\.safe-to-spend-hero \.display-money \{[\s\S]*?font-weight: 700;[\s\S]*?\}/,
  );
  assert.match(
    source,
    /\.safe-to-spend-hero \{[\s\S]*?grid-template-columns: minmax\(0, 1\.3fr\) minmax\(260px, 0\.8fr\);/,
  );
  assert.doesNotMatch(partial, /quiet-link|Cash details|<a\b/);
  assert.match(dashboard, /include\("partials\/safe-to-spend-card"/);
  assert.match(plan, /include\("partials\/safe-to-spend-card"/);
  assert.match(source, /\.plan-section \.section-heading \{/);
});

test("the standing budget is view-only by default with linked category status", async () => {
  const plan = await readFile(
    path.resolve("app/views/plan.ejs"),
    "utf8",
  );

  assert.match(plan, /const editBudget = String\(query\.edit_budget/);
  assert.match(plan, /Edit budget/);
  assert.match(plan, /budget-category-link/);
  assert.match(plan, /transactions\?category=/);
  assert.match(plan, /const remainingStatus = \(remaining\)/);
  assert.match(plan, /Previous month actual/);
  assert.match(plan, /budget-row--total/);
  assert.match(
    plan,
    /data-endpoint="\/api\/v1\/plan\/budget"/,
  );
  assert.match(
    plan,
    /data-endpoint="\/api\/v1\/plan\/budget\/<%= encodeURIComponent\(line\.category\) %>"/,
  );
  assert.doesNotMatch(
    plan,
    /name="scope"|name="effective_month_on"|budgetEditMonth/,
  );
  assert.doesNotMatch(
    plan,
    /Copy last month|Save month|Future default|type="month"|Budget month|View month/,
  );
});

test("goal cards are summaries and all goal changes live in dialogs", async () => {
  const plan = await readFile(
    path.resolve("app/views/plan.ejs"),
    "utf8",
  );
  const client = await readFile(
    path.resolve("app/public/js/money.js"),
    "utf8",
  );
  const goalCardTemplate = plan.match(
    /<article class="card goal-card"[\s\S]*?<\/article>/,
  )?.[0];

  assert.ok(goalCardTemplate, "expected a goal card template");
  assert.doesNotMatch(goalCardTemplate, /<form\b|<details\b/);
  assert.doesNotMatch(
    plan,
    /<details class="card plan-create"/,
  );

  for (const action of ["create", "edit", "allocate"]) {
    assert.match(
      plan,
      new RegExp(`data-goal-dialog-open="${action}"`),
    );
    assert.match(
      plan,
      new RegExp(`<dialog[\\s\\S]*?data-goal-dialog="${action}"`),
    );
  }

  assert.match(plan, /data-goal-dialog-target="goal-(?:edit|allocate)-dialog-/);
  assert.match(plan, /data-goal-dialog-close/);
  assert.match(plan, /aria-label="Edit <%= goal\.name %>"/);
  assert.match(plan, /aria-label="Move money for <%= goal\.name %>"/);
  assert.match(
    plan,
    /data-goal-dialog="allocate"[\s\S]*plan-dialog__funding-summary/,
  );
  assert.match(
    plan,
    /data-goal-dialog="edit"[\s\S]*name="expected_version"/,
  );
  assert.match(
    plan,
    /data-goal-dialog="allocate"[\s\S]*name="expected_version"/,
  );
  assert.match(
    client,
    /opener\.dataset\.goalDialogTarget[\s\S]*dialog\.showModal\(\)/,
  );
  assert.match(
    client,
    /data-goal-dialog-close[\s\S]*button\.addEventListener\("click", \(\) => dialog\.close\(\)\)/,
  );
  assert.match(
    client,
    /dialog\.addEventListener\("click", \(event\) => \{[\s\S]*event\.target === dialog[\s\S]*dialog\.close\(\)/,
  );
  assert.match(
    client,
    /dialog\.addEventListener\("close"[\s\S]*goalDialogOpenersByDialog\.get\(dialog\)\?\.focus\(\)/,
  );
  assert.doesNotMatch(
    client,
    /delete form\.dataset\.idempotencyKey/,
  );
});

test("goal purpose and finishing controls stay in goal dialogs", async () => {
  const html = await renderPlan();

  for (const purpose of [
    "vacation",
    "home",
    "vehicle",
    "education",
    "emergency",
    "event",
    "purchase",
    "other",
  ]) {
    assert.match(html, new RegExp(`<option value="${purpose}"`));
  }
  assert.match(
    html,
    /data-goal-dialog="edit"[\s\S]*?<select name="purpose" required>/,
  );
  assert.match(
    html,
    /data-goal-dialog="create"[\s\S]*?<select name="purpose" required>/,
  );
  assert.match(
    html,
    /data-endpoint="\/api\/v1\/plan\/goals\/[^"]+\/finish" data-method="POST"[\s\S]*?<select name="outcome"[\s\S]*?value="completed"[\s\S]*?value="cancelled"[\s\S]*?>Finish goal<\/button>/,
  );
  assert.doesNotMatch(html, /Release both earmarks before archiving/);
});

test("finished goals show positive over and unused amounts with uncapped usage", async () => {
  const archivedGoal = {
    id: "goal_finished_vacation",
    name: "Summer vacation",
    purpose: "vacation",
    status: "archived",
    archive_outcome: "completed",
    archived_at: "2026-07-26T19:00:00.000Z",
    target_amount_minor: 500_00,
    currency_code: "USD",
    planned: { amount_minor: 500_00, currency: "USD" },
    actual: { amount_minor: 550_00, currency: "USD" },
    plan_remaining: { amount_minor: 0, currency: "USD" },
    over_by: { amount_minor: 50_00, currency: "USD" },
    used_basis_points: 11_000,
  };
  const underusedGoal = {
    ...archivedGoal,
    id: "goal_finished_under",
    name: "Quiet weekend",
    actual: { amount_minor: 450_00, currency: "USD" },
    plan_remaining: { amount_minor: 50_00, currency: "USD" },
    over_by: { amount_minor: 0, currency: "USD" },
    used_basis_points: 9_000,
  };
  const html = await renderPlan({
    archivedGoals: [archivedGoal, underusedGoal],
    historyInsights: [
      {
        kind: "purpose_actual_variance",
        purpose: "vacation",
        completed_goal_count: 3,
        median_actual_variance_basis_points: 1_000,
        evidence_goal_ids_truncated: false,
        evidence_goal_ids: [archivedGoal.id],
      },
    ],
  });
  const finishedSection = html.match(
    /<details class="card plan-section finished-goals"[\s\S]*?<\/details>/,
  )?.[0];

  assert.ok(finishedSection);
  assert.doesNotMatch(
    finishedSection.match(
      /<article class="finished-goal-card">[\s\S]*?<\/article>/,
    )?.[0] ?? "",
    /<form\b|<button\b|<a\b/,
  );
  assert.match(finishedSection, /Summer vacation/);
  assert.match(finishedSection, /Vacation · Finished Jul 26, 2026/);
  assert.match(finishedSection, />Completed<\/span>/);
  assert.match(
    finishedSection,
    /goal-plan-summary__usage--over[\s\S]*?<dt>Usage<\/dt>[\s\S]*?110%/,
  );
  assert.match(
    finishedSection,
    /<dt>Remaining<\/dt>[\s\S]*?\$0\.00[\s\S]*?goal-plan-overage[\s\S]*?Over by[\s\S]*?\$50\.00/,
  );
  assert.doesNotMatch(finishedSection, /-\$50\.00/);
  assert.match(
    finishedSection,
    /Quiet weekend[\s\S]*?<dt>Usage<\/dt>[\s\S]*?90%[\s\S]*?<dt>Unused<\/dt>[\s\S]*?\$50\.00/,
  );
  assert.match(
    finishedSection,
    /You tend to spend 10% more on vacation goals than planned\./,
  );
});
