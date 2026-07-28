import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration = fs.readFileSync(
  new URL("../migrations/011_family_planning.sql", import.meta.url),
  "utf8",
);
const integrityMigration = fs.readFileSync(
  new URL("../migrations/013_planning_integrity.sql", import.meta.url),
  "utf8",
);
const versionMigration = fs.readFileSync(
  new URL("../migrations/014_planning_write_versions.sql", import.meta.url),
  "utf8",
);
const goalSpendMigration = fs.readFileSync(
  new URL("../migrations/015_goal_transaction_spends.sql", import.meta.url),
  "utf8",
);
const goalHistoryMigration = fs.readFileSync(
  new URL("../migrations/016_goal_history.sql", import.meta.url),
  "utf8",
);
const hierarchicalBudgetMigration = fs.readFileSync(
  new URL("../migrations/025_hierarchical_budgets.sql", import.meta.url),
  "utf8",
);

test("family planning migration persists every durable planning record", () => {
  for (const table of [
    "finance_goals",
    "goal_allocation_events",
    "goal_funding_schedules",
    "goal_schedule_runs",
    "budget_months",
    "budget_lines",
    "budget_default_revisions",
    "transaction_splits",
    "plan_audit_events",
    "plan_idempotency_keys",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}\\b`));
  }
  assert.match(migration, /ADD COLUMN IF NOT EXISTS timezone/);
  assert.match(migration, /UNIQUE \(schedule_id, due_on\)/);
  assert.match(
    migration,
    /PRIMARY KEY \(\s*workspace_id,\s*actor_type,\s*actor_id,\s*operation,\s*idempotency_key\s*\)/,
  );
});

test("planning schema keeps retirement out and schedule shapes explicit", () => {
  assert.match(
    migration,
    /source text NOT NULL CHECK \(source IN \('cash', 'brokerage'\)\)/,
  );
  assert.doesNotMatch(migration, /source IN \([^)]*retirement/);
  assert.match(migration, /cadence IN \('monthly', 'biweekly_friday'\)/);
  assert.match(migration, /monthly_day BETWEEN 1 AND 31/);
});

test("planning integrity enforces Friday anchors and audits invalid split cleanup", () => {
  assert.match(
    integrityMigration,
    /goal\.schedule_anchor_repaired/,
  );
  assert.match(
    integrityMigration,
    /status = 'paused'/,
  );
  assert.match(
    integrityMigration,
    /EXTRACT\(ISODOW FROM anchor_on\) = 5/,
  );
  assert.match(
    integrityMigration,
    /CREATE TRIGGER guard_transaction_split_parent_change[\s\S]*BEFORE DELETE OR UPDATE OF amount_minor, currency_code, pending/,
  );
  assert.match(
    integrityMigration,
    /transaction\.splits_invalidated/,
  );
  assert.match(
    integrityMigration,
    /DELETE FROM transaction_splits[\s\S]*transaction_id = OLD\.id/,
  );
});

test("planning writes persist budget and transaction split versions", () => {
  assert.match(
    versionMigration,
    /CREATE TABLE budget_category_versions/,
  );
  assert.match(
    versionMigration,
    /PRIMARY KEY \(workspace_id, category\)/,
  );
  assert.match(
    versionMigration,
    /ALTER TABLE transactions[\s\S]*ADD COLUMN split_version integer NOT NULL DEFAULT 0/,
  );
  assert.match(
    versionMigration,
    /UPDATE transactions parent[\s\S]*SET split_version = 1[\s\S]*FROM transaction_splits/,
  );
  assert.match(
    versionMigration,
    /CREATE TRIGGER a_bump_split_version_before_invalidation[\s\S]*BEFORE UPDATE OF amount_minor, currency_code, pending/,
  );
});

test("hierarchical budgets use category IDs and preserve tracking history", () => {
  assert.match(
    hierarchicalBudgetMigration,
    /PRIMARY KEY \(workspace_id, category_id, effective_month_on\)/,
  );
  assert.match(
    hierarchicalBudgetMigration,
    /PRIMARY KEY \(workspace_id, month_on, category_id\)/,
  );
  assert.match(
    hierarchicalBudgetMigration,
    /tracking_mode IN \('tracked', 'informational'\)/,
  );
  assert.match(hierarchicalBudgetMigration, /is_removed boolean/);
  assert.match(
    hierarchicalBudgetMigration,
    /CREATE TABLE budget_income_categories/,
  );
  assert.match(
    hierarchicalBudgetMigration,
    /CREATE FUNCTION budget_hierarchy_is_valid/,
  );
  assert.match(
    hierarchicalBudgetMigration,
    /INSERT INTO budget_lines[\s\S]*GREATEST\([\s\S]*SUM\(/,
  );
});

test("goal transaction spending is reversible, versioned, and source-safe", () => {
  assert.match(
    goalSpendMigration,
    /CREATE TABLE goal_transaction_spends/,
  );
  assert.match(
    goalSpendMigration,
    /source IN \('cash', 'brokerage'\)/,
  );
  assert.match(
    goalSpendMigration,
    /amount_minor bigint NOT NULL\s+CHECK \(amount_minor > 0\)/,
  );
  assert.match(
    goalSpendMigration,
    /status IN \('active', 'reversed', 'invalidated'\)/,
  );
  assert.match(
    goalSpendMigration,
    /WHERE status = 'active'/,
  );
  assert.match(
    goalSpendMigration,
    /ADD COLUMN goal_spend_version integer NOT NULL DEFAULT 0/,
  );
});

test("provider transaction changes invalidate goal spending and restore archived goals", () => {
  assert.match(
    goalSpendMigration,
    /CREATE TRIGGER b_guard_goal_transaction_spend_parent_change[\s\S]*BEFORE DELETE OR UPDATE OF[\s\S]*amount_minor,[\s\S]*currency_code,[\s\S]*pending,[\s\S]*excluded_from_spending/,
  );
  assert.match(
    goalSpendMigration,
    /NEW\.goal_spend_version := OLD\.goal_spend_version \+ 1/,
  );
  assert.match(
    goalSpendMigration,
    /transaction\.goal_spends_invalidated/,
  );
  assert.match(
    goalSpendMigration,
    /status = 'invalidated'/,
  );
  assert.match(
    goalSpendMigration,
    /goal\.reactivated_after_spend_invalidation/,
  );
  assert.match(
    goalSpendMigration,
    /'archive_outcome', to_jsonb\(goal\) -> 'archive_outcome'/,
  );
  assert.match(
    goalSpendMigration,
    /'archive_outcome', NULL/,
  );
  assert.match(
    goalSpendMigration,
    /status = 'active',\s+archived_at = NULL/,
  );
});

test("goal history records purpose and a normalized archive outcome", () => {
  assert.match(
    goalHistoryMigration,
    /ADD COLUMN purpose text NOT NULL DEFAULT 'other'/,
  );
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
    assert.match(goalHistoryMigration, new RegExp(`'${purpose}'`));
  }
  assert.match(
    goalHistoryMigration,
    /archive_outcome IN \('completed', 'cancelled'\)/,
  );
  assert.match(
    goalHistoryMigration,
    /archive_outcome = 'completed'\s+WHERE status = 'archived'/,
  );
  assert.match(
    goalHistoryMigration,
    /status = 'active'[\s\S]*archived_at IS NULL[\s\S]*archive_outcome IS NULL/,
  );
  assert.match(
    goalHistoryMigration,
    /status = 'archived'[\s\S]*archived_at IS NOT NULL[\s\S]*archive_outcome IS NOT NULL/,
  );
  assert.match(
    goalHistoryMigration,
    /CREATE TRIGGER normalize_finance_goal_lifecycle[\s\S]*BEFORE INSERT OR UPDATE ON finance_goals/,
  );
  assert.match(
    goalHistoryMigration,
    /CREATE INDEX finance_goals_workspace_history_idx[\s\S]*workspace_id,[\s\S]*purpose,[\s\S]*archived_at DESC,[\s\S]*WHERE status = 'archived'/,
  );
  assert.match(
    goalHistoryMigration,
    /IF NEW\.status = 'active' THEN[\s\S]*NEW\.archived_at := NULL;[\s\S]*NEW\.archive_outcome := NULL;/,
  );
});
