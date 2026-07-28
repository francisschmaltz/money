BEGIN;

ALTER TABLE transaction_metadata
  ADD COLUMN IF NOT EXISTS budget_month_on date;

ALTER TABLE transaction_metadata
  ADD CONSTRAINT transaction_metadata_budget_month_check
    CHECK (
      budget_month_on IS NULL
      OR budget_month_on =
        date_trunc('month', budget_month_on)::date
    );

CREATE INDEX IF NOT EXISTS transaction_metadata_budget_month_idx
  ON transaction_metadata (workspace_id, budget_month_on)
  WHERE budget_month_on IS NOT NULL;

COMMENT ON COLUMN transaction_metadata.budget_month_on IS
  'Optional calendar month override used only by Plan actuals. Null follows the transaction posted month.';

COMMIT;
