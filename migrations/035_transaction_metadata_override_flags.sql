BEGIN;

ALTER TABLE transaction_metadata
  ADD COLUMN display_name_overridden boolean NOT NULL DEFAULT false,
  ADD COLUMN budget_month_overridden boolean NOT NULL DEFAULT false;

UPDATE transaction_metadata
SET display_name_overridden = display_name IS NOT NULL,
    budget_month_overridden = budget_month_on IS NOT NULL
WHERE display_name IS NOT NULL
   OR budget_month_on IS NOT NULL;

COMMENT ON COLUMN transaction_metadata.display_name_overridden IS
  'True when the display name was explicitly set or cleared by a user.';
COMMENT ON COLUMN transaction_metadata.budget_month_overridden IS
  'True when the Plan month was explicitly selected or cleared by a user.';

COMMIT;
