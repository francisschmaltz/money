import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../migrations/033_unmatched_pending_edits.sql",
  import.meta.url,
);

test("unmatched pending edits retain identity, state, and provider facts", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(
    migration,
    /CREATE TABLE unmatched_pending_transaction_edits/,
  );
  assert.match(
    migration,
    /workspace_id text NOT NULL[\s\S]*REFERENCES workspaces\(id\) ON DELETE CASCADE/,
  );
  assert.match(
    migration,
    /account_id text NOT NULL[\s\S]*REFERENCES accounts\(id\) ON DELETE CASCADE/,
  );
  assert.match(migration, /pending_transaction_id text NOT NULL/);
  assert.match(
    migration,
    /provider_pending_transaction_id text NOT NULL/,
  );
  assert.match(
    migration,
    /jsonb_typeof\(user_state\) = 'object'[\s\S]*user_state <> '\{\}'::jsonb/,
  );
  assert.match(
    migration,
    /jsonb_typeof\(provider_facts\) = 'object'[\s\S]*provider_facts <> '\{\}'::jsonb/,
  );
});

test("unmatched pending edit lifecycle is timestamped and mutually exclusive", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  for (const field of [
    "pending_created_at",
    "pending_updated_at",
    "recovered_at",
    "updated_at",
    "attached_at",
    "dismissed_at",
  ]) {
    assert.match(migration, new RegExp(`${field} timestamptz`));
  }
  assert.match(
    migration,
    /unmatched_pending_edits_resolution_check[\s\S]*attached_transaction_id IS NULL[\s\S]*attached_at IS NULL[\s\S]*dismissed_at IS NULL[\s\S]*OR \([\s\S]*attached_transaction_id IS NOT NULL[\s\S]*attached_at IS NOT NULL[\s\S]*dismissed_at IS NULL[\s\S]*OR \([\s\S]*attached_transaction_id IS NULL[\s\S]*attached_at IS NULL[\s\S]*dismissed_at IS NOT NULL/,
  );
  assert.match(
    migration,
    /attached_by text REFERENCES users\(id\) ON DELETE SET NULL/,
  );
  assert.match(
    migration,
    /dismissed_by text REFERENCES users\(id\) ON DELETE SET NULL/,
  );
  assert.doesNotMatch(
    migration,
    /attached_transaction_id text REFERENCES transactions/,
  );
});

test("unmatched pending edit recovery has idempotency and queue indexes", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(
    migration,
    /CREATE UNIQUE INDEX unmatched_pending_edits_provider_unique[\s\S]*workspace_id,[\s\S]*provider_pending_transaction_id/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX unmatched_pending_edits_source_unique[\s\S]*workspace_id,[\s\S]*pending_transaction_id/,
  );
  assert.match(
    migration,
    /unmatched_pending_edits_workspace_open_idx[\s\S]*recovered_at DESC[\s\S]*WHERE attached_at IS NULL\s+AND dismissed_at IS NULL/,
  );
  assert.match(
    migration,
    /unmatched_pending_edits_attached_idx[\s\S]*attached_transaction_id[\s\S]*WHERE attached_transaction_id IS NOT NULL/,
  );
});
