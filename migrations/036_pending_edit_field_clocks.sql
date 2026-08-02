BEGIN;

-- A transaction_metadata row contains several independently editable fields.
-- The row-level updated_at cannot decide pending-to-posted conflicts because an
-- edit to one field must not make every sibling field appear newer.
ALTER TABLE transaction_metadata
  ADD COLUMN display_name_updated_at timestamptz,
  ADD COLUMN tags_updated_at timestamptz,
  ADD COLUMN budget_month_updated_at timestamptz;

UPDATE transaction_metadata
SET display_name_updated_at = CASE
      WHEN display_name_overridden THEN updated_at
      ELSE NULL
    END,
    tags_updated_at = CASE
      WHEN tags_overridden THEN updated_at
      ELSE NULL
    END,
    budget_month_updated_at = CASE
      WHEN budget_month_overridden THEN updated_at
      ELSE NULL
    END;

ALTER TABLE categorization_overrides
  ADD COLUMN category_overridden boolean NOT NULL DEFAULT false,
  ADD COLUMN category_updated_at timestamptz,
  ADD COLUMN excluded_from_spending_overridden boolean NOT NULL DEFAULT false,
  ADD COLUMN excluded_from_spending_updated_at timestamptz,
  ADD COLUMN cash_flow_role_overridden boolean NOT NULL DEFAULT false,
  ADD COLUMN cash_flow_role_updated_at timestamptz,
  ADD COLUMN is_fixed_overridden boolean NOT NULL DEFAULT false,
  ADD COLUMN is_fixed_updated_at timestamptz;

UPDATE categorization_overrides
SET category_overridden =
      category_primary IS NOT NULL
      OR category_detailed IS NOT NULL
      OR category_id IS NOT NULL,
    category_updated_at = CASE
      WHEN category_primary IS NOT NULL
        OR category_detailed IS NOT NULL
        OR category_id IS NOT NULL
        THEN updated_at
      ELSE NULL
    END,
    excluded_from_spending_overridden =
      excluded_from_spending IS NOT NULL,
    excluded_from_spending_updated_at = CASE
      WHEN excluded_from_spending IS NOT NULL THEN updated_at
      ELSE NULL
    END,
    cash_flow_role_overridden = cash_flow_role IS NOT NULL,
    cash_flow_role_updated_at = CASE
      WHEN cash_flow_role IS NOT NULL THEN updated_at
      ELSE NULL
    END,
    is_fixed_overridden = is_fixed IS NOT NULL,
    is_fixed_updated_at = CASE
      WHEN is_fixed IS NOT NULL THEN updated_at
      ELSE NULL
    END;

COMMENT ON COLUMN transaction_metadata.display_name_updated_at IS
  'Timestamp of the last explicit display-name edit, including a clear.';
COMMENT ON COLUMN transaction_metadata.tags_updated_at IS
  'Timestamp of the last explicit tag-set edit, including clearing all tags.';
COMMENT ON COLUMN transaction_metadata.budget_month_updated_at IS
  'Timestamp of the last explicit Plan-month edit, including a clear.';
COMMENT ON COLUMN categorization_overrides.category_updated_at IS
  'Timestamp of the last transaction category edit, independent of sibling fields.';
COMMENT ON COLUMN categorization_overrides.excluded_from_spending_updated_at IS
  'Timestamp of the last legacy spending-exclusion edit.';
COMMENT ON COLUMN categorization_overrides.cash_flow_role_updated_at IS
  'Timestamp of the last cash-flow-role edit.';
COMMENT ON COLUMN categorization_overrides.is_fixed_updated_at IS
  'Timestamp of the last fixed/flexible edit.';

COMMIT;
