import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../migrations/020_spending_categories.sql",
  import.meta.url,
);
const splitMigrationUrl = new URL(
  "../migrations/022_spending_category_split.sql",
  import.meta.url,
);
const repositoryUrl = new URL(
  "../app/db/financeRepository.js",
  import.meta.url,
);

test("spending category schema preserves raw labels and adds durable taxonomy lineage", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /CREATE TABLE spending_categories/);
  assert.match(migration, /classification text NOT NULL DEFAULT 'flexible'/);
  assert.match(migration, /parent_category_id text/);
  assert.match(migration, /merged_into_category_id text/);
  assert.match(migration, /version integer NOT NULL DEFAULT 1/);
  assert.match(migration, /CREATE TABLE spending_category_aliases/);
  assert.match(migration, /CREATE TABLE spending_category_events/);
  assert.match(migration, /CREATE VIEW transaction_effective_spending_categories/);
  assert.match(
    migration,
    /t\.category_primary AS original_category_primary/,
  );
  assert.match(
    migration,
    /t\.category_detailed AS original_category_detailed/,
  );
  assert.doesNotMatch(
    migration,
    /ALTER TABLE transactions\s+ADD COLUMN category_id/,
  );
});

test("taxonomy backfill covers every durable category consumer", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  for (const table of [
    "categorization_overrides",
    "transaction_cleanup_rules",
    "transaction_splits",
    "budget_lines",
    "budget_default_revisions",
    "budget_category_versions",
  ]) {
    assert.match(
      migration,
      new RegExp(`ALTER TABLE ${table}[\\s\\S]*ADD COLUMN category_id text`),
    );
  }
  assert.match(migration, /CREATE TRIGGER transactions_observe_spending_category/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION spending_category_descendant_ids/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION active_spending_category_id/);
});

test("transaction fixed status comes from the canonical category", async () => {
  const repository = await readFile(repositoryUrl, "utf8");

  assert.match(
    repository,
    /effective_category_definition\.classification = 'fixed'/,
  );
  assert.match(repository, /category\.classification = 'fixed' AS is_fixed/);
  assert.doesNotMatch(repository, /transaction_override\.is_fixed/);
  assert.doesNotMatch(repository, /merchant_override\.is_fixed/);
});

test("category event history records categories split out of a merge", async () => {
  const migration = await readFile(splitMigrationUrl, "utf8");
  const repository = await readFile(repositoryUrl, "utf8");

  assert.match(migration, /'split'/);
  assert.match(repository, /async splitSpendingCategory/);
  assert.match(repository, /'split'/);
  assert.match(repository, /SET merged_into_category_id = NULL/);
});
