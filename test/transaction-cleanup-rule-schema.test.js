import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const migrationUrl = new URL(
  "../migrations/008_transaction_cleanup_rules.sql",
  import.meta.url,
);
const containsMigrationUrl = new URL(
  "../migrations/021_cleanup_rule_contains.sql",
  import.meta.url,
);

test("cleanup rule schema stores exact matchers and nullable changes", async () => {
  const migration = await readFile(fileURLToPath(migrationUrl), "utf8");

  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS unaccent/);
  assert.match(
    migration,
    /UPDATE transactions[\s\S]*lower\(unaccent\(name\)\)[\s\S]*'\[\^a-z0-9\]\+'/,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS transaction_cleanup_rules/,
  );
  assert.match(
    migration,
    /match_field IN \('normalized_merchant', 'normalized_name'\)/,
  );
  assert.match(
    migration,
    /UNIQUE \(workspace_id, match_field, normalized_match_value\)/,
  );
  assert.match(
    migration,
    /display_name IS NOT NULL\s+OR category_primary IS NOT NULL\s+OR tags IS NOT NULL/,
  );
  assert.match(
    migration,
    /tags IS NULL[\s\S]*jsonb_typeof\(tags\) = 'array'/,
  );
  assert.match(
    migration,
    /NULL leaves tags unchanged; an empty JSON array clears tags/,
  );
  assert.doesNotMatch(migration, /similarity\s*\(/i);
});

test("cleanup rule migration preserves explicit empty tag overrides", async () => {
  const migration = await readFile(fileURLToPath(migrationUrl), "utf8");

  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS tags_overridden boolean NOT NULL DEFAULT false/,
  );
  assert.match(
    migration,
    /FROM transaction_tag_assignments assignment[\s\S]*ON CONFLICT \(workspace_id, transaction_id\) DO UPDATE SET\s+tags_overridden = true/,
  );
});

test("cleanup rules support normalized contains with deterministic precedence", async () => {
  const migration = await readFile(
    fileURLToPath(containsMigrationUrl),
    "utf8",
  );

  assert.match(
    migration,
    /ADD COLUMN match_mode text NOT NULL DEFAULT 'exact'/,
  );
  assert.match(
    migration,
    /match_mode IN \('exact', 'contains'\)/,
  );
  assert.match(
    migration,
    /UNIQUE \(\s*workspace_id,\s*match_field,\s*match_mode,\s*normalized_match_value\s*\)/,
  );
  assert.match(
    migration,
    /WHEN 'contains' THEN[\s\S]*strpos\([\s\S]*target_match_value[\s\S]*\) > 0/,
  );
  assert.match(
    migration,
    /\(rule\.match_mode = 'exact'\) DESC[\s\S]*length\(rule\.normalized_match_value\) DESC/,
  );
  assert.match(
    migration,
    /CREATE OR REPLACE VIEW transaction_effective_spending_categories/,
  );
});
