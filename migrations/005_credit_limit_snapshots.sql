BEGIN;

ALTER TABLE daily_account_snapshots
  ADD COLUMN IF NOT EXISTS credit_limit_minor bigint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'accounts_credit_limit_nonnegative'
      AND conrelid = 'accounts'::regclass
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_credit_limit_nonnegative
      CHECK (
        credit_limit_minor IS NULL
        OR credit_limit_minor >= 0
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'daily_account_snapshots_credit_limit_nonnegative'
      AND conrelid = 'daily_account_snapshots'::regclass
  ) THEN
    ALTER TABLE daily_account_snapshots
      ADD CONSTRAINT daily_account_snapshots_credit_limit_nonnegative
      CHECK (
        credit_limit_minor IS NULL
        OR credit_limit_minor >= 0
      );
  END IF;
END
$$;

COMMIT;
