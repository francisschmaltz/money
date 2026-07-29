import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration = fs.readFileSync(
  new URL(
    "../migrations/028_recurring_pattern_rules.sql",
    import.meta.url,
  ),
  "utf8",
);

test("manual recurring rules persist stable matching and audit fields", () => {
  assert.match(
    migration,
    /CREATE TABLE recurring_pattern_rules/,
  );
  assert.match(migration, /stream_id text NOT NULL UNIQUE/);
  assert.match(
    migration,
    /source_transaction_id text REFERENCES transactions\(id\) ON DELETE SET NULL/,
  );
  assert.match(
    migration,
    /match_field IN \('normalized_merchant', 'normalized_name'\)/,
  );
  assert.match(
    migration,
    /stream_type IN \('subscription', 'bill'\)/,
  );
  assert.match(
    migration,
    /'weekly',\s*'biweekly',\s*'monthly',\s*'quarterly',\s*'annual'/,
  );
  assert.match(migration, /active boolean NOT NULL DEFAULT true/);
  assert.match(
    migration,
    /created_by text REFERENCES users\(id\) ON DELETE SET NULL/,
  );
  assert.match(
    migration,
    /updated_by text REFERENCES users\(id\) ON DELETE SET NULL/,
  );
});
