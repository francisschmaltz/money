BEGIN;

ALTER TABLE transactions
  ADD COLUMN cash_flow_role text;

ALTER TABLE categorization_overrides
  ADD COLUMN cash_flow_role text;

ALTER TABLE transaction_cleanup_rules
  ADD COLUMN cash_flow_role text;

-- Provider evidence outranks the legacy exclusion bit. In particular, older
-- Plaid loan payments were all excluded, but known debt-service subtypes are
-- obligations rather than transfers. Unknown categories retain their old
-- inclusion/exclusion behavior.
UPDATE transactions
SET cash_flow_role = CASE
  -- Apple Card merchant credits reverse Spending. Only statement payments
  -- move money between accounts and therefore default to Transfer.
  WHEN lower(btrim(coalesce(source_transaction_type, ''))) = 'payment'
    THEN 'transfer'
  WHEN source_transaction_type IS NOT NULL
    THEN 'spending'
  WHEN upper(
    regexp_replace(
      btrim(coalesce(category_primary, '')),
      '[^A-Za-z0-9]+',
      '_',
      'g'
    )
  ) IN ('TRANSFER_IN', 'TRANSFER_OUT')
    THEN 'transfer'
  WHEN upper(
    regexp_replace(
      btrim(coalesce(category_primary, '')),
      '[^A-Za-z0-9]+',
      '_',
      'g'
    )
  ) = 'LOAN_PAYMENTS'
    AND upper(
      regexp_replace(
        btrim(coalesce(category_detailed, '')),
        '[^A-Za-z0-9]+',
        '_',
        'g'
      )
    ) = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
    THEN 'transfer'
  WHEN upper(
    regexp_replace(
      btrim(coalesce(category_primary, '')),
      '[^A-Za-z0-9]+',
      '_',
      'g'
    )
  ) = 'LOAN_PAYMENTS'
    AND concat_ws(' ', merchant_name, name) ~*
      '\m((extra|additional)[[:space:]]+principal|principal[[:space:]-]+only)\M'
    THEN 'transfer'
  WHEN (
    upper(
      regexp_replace(
        btrim(coalesce(category_primary, '')),
        '[^A-Za-z0-9]+',
        '_',
        'g'
      )
    ) = 'LOAN_PAYMENTS'
    AND upper(
      regexp_replace(
        btrim(coalesce(category_detailed, '')),
        '[^A-Za-z0-9]+',
        '_',
        'g'
      )
    ) IN (
      'LOAN_PAYMENTS_CAR_PAYMENT',
      'LOAN_PAYMENTS_MORTGAGE_PAYMENT',
      'LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT',
      'LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT'
    )
  ) OR (
    upper(
      regexp_replace(
        btrim(coalesce(category_primary, '')),
        '[^A-Za-z0-9]+',
        '_',
        'g'
      )
    ) = 'RENT_AND_UTILITIES'
    AND upper(
      regexp_replace(
        btrim(coalesce(category_detailed, '')),
        '[^A-Za-z0-9]+',
        '_',
        'g'
      )
    ) = 'RENT_AND_UTILITIES_RENT'
  )
    THEN 'obligation'
  WHEN excluded_from_spending THEN 'transfer'
  ELSE 'spending'
END;

-- These booleans are explicit user choices, unlike the provider-owned bit on
-- transactions. Preserve every true/false override exactly.
UPDATE categorization_overrides
SET cash_flow_role = CASE
  WHEN excluded_from_spending THEN 'transfer'
  ELSE 'spending'
END
WHERE excluded_from_spending IS NOT NULL;

ALTER TABLE transactions
  ALTER COLUMN cash_flow_role SET DEFAULT 'spending',
  ALTER COLUMN cash_flow_role SET NOT NULL,
  ADD CONSTRAINT transactions_cash_flow_role_check
    CHECK (cash_flow_role IN ('spending', 'obligation', 'transfer'));

ALTER TABLE categorization_overrides
  ADD CONSTRAINT categorization_overrides_cash_flow_role_check
    CHECK (
      cash_flow_role IS NULL
      OR cash_flow_role IN ('spending', 'obligation', 'transfer')
    );

ALTER TABLE transaction_cleanup_rules
  ADD CONSTRAINT transaction_cleanup_rules_cash_flow_role_check
    CHECK (
      cash_flow_role IS NULL
      OR cash_flow_role IN ('spending', 'obligation', 'transfer')
    ),
  DROP CONSTRAINT transaction_cleanup_rules_has_change_check,
  ADD CONSTRAINT transaction_cleanup_rules_has_change_check
    CHECK (
      display_name IS NOT NULL
      OR category_primary IS NOT NULL
      OR tags IS NOT NULL
      OR cash_flow_role IS NOT NULL
    );

CREATE OR REPLACE VIEW transaction_effective_spending_treatments AS
WITH effective_roles AS (
  SELECT
    t.workspace_id,
    t.id AS transaction_id,
    COALESCE(
      transaction_override.cash_flow_role,
      CASE transaction_override.excluded_from_spending
        WHEN true THEN 'transfer'
        WHEN false THEN 'spending'
      END,
      cleanup_rule.cash_flow_role,
      merchant_override.cash_flow_role,
      CASE merchant_override.excluded_from_spending
        WHEN true THEN 'transfer'
        WHEN false THEN 'spending'
      END,
      original_transaction_override.cash_flow_role,
      CASE original_transaction_override.excluded_from_spending
        WHEN true THEN 'transfer'
        WHEN false THEN 'spending'
      END,
      original_cleanup_rule.cash_flow_role,
      original_merchant_override.cash_flow_role,
      CASE original_merchant_override.excluded_from_spending
        WHEN true THEN 'transfer'
        WHEN false THEN 'spending'
      END,
      original_transaction.cash_flow_role,
      t.cash_flow_role
    ) AS effective_cash_flow_role
  FROM transactions t
  LEFT JOIN LATERAL (
    SELECT rule.*
    FROM transaction_cleanup_rules rule
    WHERE rule.workspace_id = t.workspace_id
      AND rule.enabled = true
      AND transaction_cleanup_rule_matches(
        rule.match_field,
        rule.match_mode,
        rule.normalized_match_value,
        t.normalized_merchant,
        t.normalized_name
      )
    ORDER BY
      (rule.match_mode = 'exact') DESC,
      (rule.match_field = 'normalized_merchant') DESC,
      length(rule.normalized_match_value) DESC,
      rule.updated_at DESC,
      rule.id
    LIMIT 1
  ) cleanup_rule ON true
  LEFT JOIN transactions original_transaction
    ON original_transaction.workspace_id = t.workspace_id
   AND original_transaction.id = t.original_transaction_id
  LEFT JOIN LATERAL (
    SELECT rule.*
    FROM transaction_cleanup_rules rule
    WHERE original_transaction.id IS NOT NULL
      AND rule.workspace_id = original_transaction.workspace_id
      AND rule.enabled = true
      AND transaction_cleanup_rule_matches(
        rule.match_field,
        rule.match_mode,
        rule.normalized_match_value,
        original_transaction.normalized_merchant,
        original_transaction.normalized_name
      )
    ORDER BY
      (rule.match_mode = 'exact') DESC,
      (rule.match_field = 'normalized_merchant') DESC,
      length(rule.normalized_match_value) DESC,
      rule.updated_at DESC,
      rule.id
    LIMIT 1
  ) original_cleanup_rule ON true
  LEFT JOIN categorization_overrides transaction_override
    ON transaction_override.workspace_id = t.workspace_id
   AND transaction_override.transaction_id = t.id
  LEFT JOIN categorization_overrides merchant_override
    ON merchant_override.workspace_id = t.workspace_id
   AND merchant_override.transaction_id IS NULL
   AND merchant_override.normalized_merchant = t.normalized_merchant
  LEFT JOIN categorization_overrides original_transaction_override
    ON original_transaction_override.workspace_id =
      original_transaction.workspace_id
   AND original_transaction_override.transaction_id =
      original_transaction.id
  LEFT JOIN categorization_overrides original_merchant_override
    ON original_merchant_override.workspace_id =
      original_transaction.workspace_id
   AND original_merchant_override.transaction_id IS NULL
   AND original_merchant_override.normalized_merchant =
      original_transaction.normalized_merchant
)
SELECT
  workspace_id,
  transaction_id,
  effective_cash_flow_role <> 'spending'
    AS effective_excluded_from_spending,
  effective_cash_flow_role
FROM effective_roles;

COMMENT ON COLUMN transactions.cash_flow_role IS
  'Provider-default role: spending, obligation, or transfer.';
COMMENT ON COLUMN categorization_overrides.cash_flow_role IS
  'Nullable transaction or merchant override of the provider cash-flow role.';
COMMENT ON COLUMN transaction_cleanup_rules.cash_flow_role IS
  'Nullable role assigned by a matching deterministic cleanup rule.';
COMMENT ON VIEW transaction_effective_spending_treatments IS
  'Effective cash-flow role after transaction, cleanup-rule, merchant, and original-transaction precedence; excluded_from_spending remains a compatibility read.';

COMMIT;
