import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("insight lifecycle migration preserves history and detached delete events", async () => {
  const migration = await readFile(
    fileURLToPath(
      new URL(
        "../migrations/007_insight_lifecycle.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS finding_key text/,
  );
  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true/,
  );
  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS retired_at timestamptz/,
  );
  assert.match(
    migration,
    /state IN \([\s\S]*'archived'[\s\S]*'bad'[\s\S]*'dismissed'[\s\S]*'resolved'/,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS insight_finding_preferences/,
  );
  assert.match(
    migration,
    /PRIMARY KEY \(workspace_id, finding_key\)/,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS insight_finding_events/,
  );
  assert.match(
    migration,
    /finding_id text NOT NULL,[\s\S]*finding_key text NOT NULL/,
  );
  assert.doesNotMatch(
    migration,
    /finding_id text[^;]*REFERENCES insight_findings/,
  );
  assert.match(
    migration,
    /WHERE is_current = true AND state = 'active'/,
  );
});
