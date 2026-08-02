import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../migrations/034_pending_split_reconciliation.sql",
  import.meta.url,
);
const planningRepositoryUrl = new URL(
  "../app/db/planningRepository.js",
  import.meta.url,
);

test("pending split reconciliation adds a durable analytics quarantine", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(
    migration,
    /ADD COLUMN split_needs_review boolean NOT NULL DEFAULT false/,
  );
  assert.match(
    migration,
    /transactions_split_needs_review_idx[\s\S]*workspace_id,[\s\S]*posted_on DESC,[\s\S]*WHERE split_needs_review = true/,
  );
  assert.match(
    migration,
    /Posted analytics must exclude these transactions until corrected/,
  );
});

test("unchanged provider upserts preserve pending split lines", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const guard = migration.match(
    /CREATE OR REPLACE FUNCTION guard_transaction_split_parent\(\)[\s\S]*?\n\$\$;/,
  )?.[0];
  assert.ok(guard);

  assert.match(
    guard,
    /parent_changed :=[\s\S]*OLD\.amount_minor IS DISTINCT FROM NEW\.amount_minor[\s\S]*OLD\.currency_code IS DISTINCT FROM NEW\.currency_code[\s\S]*OLD\.pending IS DISTINCT FROM NEW\.pending/,
  );
  assert.match(
    guard,
    /IF NOT parent_changed THEN\s+RETURN NEW;/,
  );
  assert.doesNotMatch(guard, /OR NEW\.pending;/);
});

test("compatible amount drift adjusts one deterministic largest line", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(
    migration,
    /array_agg\([\s\S]*split\.id[\s\S]*ORDER BY\s+abs\(split\.amount_minor\) DESC,\s+split\.line_index,\s+split\.id[\s\S]*\)\[1\]/,
  );
  assert.match(
    migration,
    /OLD\.currency_code = NEW\.currency_code[\s\S]*sign\(OLD\.amount_minor\) = sign\(NEW\.amount_minor\)[\s\S]*split_total = OLD\.amount_minor[\s\S]*adjusted_amount_minor <> 0[\s\S]*sign\(adjusted_amount_minor\) = sign\(NEW\.amount_minor\)/,
  );
  assert.match(
    migration,
    /adjusted_amount_minor :=\s+largest_amount_minor \+ \(NEW\.amount_minor - OLD\.amount_minor\)/,
  );
  assert.match(
    migration,
    /UPDATE transaction_splits\s+SET amount_minor = adjusted_amount_minor[\s\S]*AND id = largest_split_id/,
  );
  assert.match(migration, /transaction\.splits_reconciled/);
});

test("invalid reconciliation retains splits and marks review state", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const reviewBranch = migration.match(
    /NEW\.split_needs_review := true;[\s\S]*?RETURN NEW;/,
  )?.[0];
  assert.ok(reviewBranch);

  assert.doesNotMatch(reviewBranch, /DELETE FROM transaction_splits/);
  assert.match(reviewBranch, /transaction\.splits_needs_review/);
  assert.match(reviewBranch, /'currency_changed'/);
  assert.match(reviewBranch, /'sign_changed'/);
  assert.match(reviewBranch, /'adjusted_line_invalid'/);
});

test("manual correction accepts pending splits and clears analytics quarantine", async () => {
  const repository = await readFile(planningRepositoryUrl, "utf8");
  const replacement = repository.match(
    /async replaceTransactionSplits\([\s\S]*?\n  }\n\n  async /,
  )?.[0];
  assert.ok(replacement);

  assert.doesNotMatch(replacement, /parent\.pending\s*\|\|/);
  assert.match(
    replacement,
    /SET split_version = split_version \+ 1,\s+split_needs_review = false/,
  );
  assert.match(
    repository,
    /transaction\.split_needs_review = false\s+OR \$2::text\[\] IS NOT NULL/,
  );
});
