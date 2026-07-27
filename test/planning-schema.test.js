import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration = fs.readFileSync(
  new URL("../migrations/011_family_planning.sql", import.meta.url),
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
