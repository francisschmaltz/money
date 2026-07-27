import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const migrationUrl = new URL(
  "../migrations/008_transaction_cleanup_rules.sql",
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
