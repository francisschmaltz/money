BEGIN;

ALTER TABLE transactions
  ADD COLUMN posted_at timestamptz;

COMMENT ON COLUMN transactions.posted_at IS
  'Provider-supplied posted timestamp. Null when the source only provides a date.';

COMMIT;
