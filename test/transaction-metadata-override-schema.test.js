import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../migrations/035_transaction_metadata_override_flags.sql",
  import.meta.url,
);

test("transaction metadata records explicit nullable-field intent", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(
    migration,
    /ALTER TABLE transaction_metadata[\s\S]*ADD COLUMN display_name_overridden boolean NOT NULL DEFAULT false,[\s\S]*ADD COLUMN budget_month_overridden boolean NOT NULL DEFAULT false/,
  );
  assert.match(
    migration,
    /COMMENT ON COLUMN transaction_metadata\.display_name_overridden[\s\S]*explicitly set or cleared/,
  );
  assert.match(
    migration,
    /COMMENT ON COLUMN transaction_metadata\.budget_month_overridden[\s\S]*explicitly selected or cleared/,
  );
});

test("existing non-null display names and Plan months are backfilled as overrides", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(
    migration,
    /UPDATE transaction_metadata\s+SET display_name_overridden = display_name IS NOT NULL,\s+budget_month_overridden = budget_month_on IS NOT NULL\s+WHERE display_name IS NOT NULL\s+OR budget_month_on IS NOT NULL/,
  );
});
