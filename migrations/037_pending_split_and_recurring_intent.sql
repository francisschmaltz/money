BEGIN;

-- A missing split row is ambiguous: it can mean the transaction was never
-- split, or that the user explicitly cleared a split. Persist the intent and
-- its own clock so pending handoff can merge it independently from provider
-- updates and unrelated transaction edits.
ALTER TABLE transactions
  ADD COLUMN split_overridden boolean NOT NULL DEFAULT false,
  ADD COLUMN split_updated_at timestamptz,
  ADD COLUMN recurring_needs_review boolean NOT NULL DEFAULT false;

UPDATE transactions parent
SET split_overridden = true,
    split_updated_at = COALESCE(
      (
        SELECT max(split.updated_at)
        FROM transaction_splits split
        WHERE split.workspace_id = parent.workspace_id
          AND split.transaction_id = parent.id
      ),
      parent.updated_at
    )
WHERE EXISTS (
  SELECT 1
  FROM transaction_splits split
  WHERE split.workspace_id = parent.workspace_id
    AND split.transaction_id = parent.id
);

CREATE INDEX transactions_recurring_needs_review_idx
  ON transactions (workspace_id, posted_on DESC, id)
  WHERE recurring_needs_review = true;

COMMENT ON COLUMN transactions.split_overridden IS
  'True after an explicit user split edit, including clearing every split line.';
COMMENT ON COLUMN transactions.split_updated_at IS
  'Timestamp of the last explicit split edit; provider reconciliation does not advance this intent clock.';
COMMENT ON COLUMN transactions.recurring_needs_review IS
  'True when pending recurring intent could not be safely re-anchored after a sign, currency, or stable-identity change.';

COMMIT;
