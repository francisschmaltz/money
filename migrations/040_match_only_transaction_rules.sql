BEGIN;

ALTER TABLE transaction_cleanup_rules
  DROP CONSTRAINT IF EXISTS transaction_cleanup_rules_has_change_check,
  DROP CONSTRAINT IF EXISTS transaction_cleanup_rules_workspace_match_unique,
  ADD COLUMN match_amount_operator text,
  ADD COLUMN match_amount_minor bigint,
  ADD CONSTRAINT transaction_cleanup_rules_amount_operator_check
    CHECK (
      match_amount_operator IS NULL
      OR match_amount_operator IN ('exact', 'less_than', 'more_than')
    ),
  ADD CONSTRAINT transaction_cleanup_rules_amount_pair_check
    CHECK (
      (match_amount_operator IS NULL) = (match_amount_minor IS NULL)
      AND (match_amount_minor IS NULL OR match_amount_minor > 0)
    );

CREATE UNIQUE INDEX transaction_cleanup_rules_workspace_match_unique
  ON transaction_cleanup_rules (
    workspace_id,
    match_field,
    match_mode,
    normalized_match_value,
    COALESCE(match_amount_operator, ''),
    COALESCE(match_amount_minor, -1)
  );

CREATE OR REPLACE FUNCTION transaction_cleanup_rule_amount_matches(
  match_operator text,
  match_amount_minor bigint,
  transaction_amount_minor bigint
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN match_operator IS NULL AND match_amount_minor IS NULL THEN true
    WHEN transaction_amount_minor IS NULL THEN false
    WHEN match_operator = 'exact'
      THEN abs(transaction_amount_minor::numeric) = match_amount_minor
    WHEN match_operator = 'less_than'
      THEN abs(transaction_amount_minor::numeric) < match_amount_minor
    WHEN match_operator = 'more_than'
      THEN abs(transaction_amount_minor::numeric) > match_amount_minor
    ELSE false
  END;
$$;

CREATE OR REPLACE VIEW transaction_effective_spending_categories AS
SELECT
  t.workspace_id,
  t.id AS transaction_id,
  t.category_primary AS original_category_primary,
  t.category_detailed AS original_category_detailed,
  COALESCE(
    transaction_override.category_primary,
    cleanup_rule.category_primary,
    merchant_override.category_primary,
    original_transaction_override.category_primary,
    original_cleanup_rule.category_primary,
    original_merchant_override.category_primary,
    original_transaction.category_primary,
    t.category_primary
  ) AS source_category_label,
  spending_category_id_for_label(
    t.workspace_id,
    COALESCE(
      transaction_override.category_primary,
      cleanup_rule.category_primary,
      merchant_override.category_primary,
      original_transaction_override.category_primary,
      original_cleanup_rule.category_primary,
      original_merchant_override.category_primary,
      original_transaction.category_primary,
      t.category_primary
    )
  ) AS category_id,
  spending_category_name_for_label(
    t.workspace_id,
    COALESCE(
      transaction_override.category_primary,
      cleanup_rule.category_primary,
      merchant_override.category_primary,
      original_transaction_override.category_primary,
      original_cleanup_rule.category_primary,
      original_merchant_override.category_primary,
      original_transaction.category_primary,
      t.category_primary
    )
  ) AS category_name
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
    AND transaction_cleanup_rule_amount_matches(
      rule.match_amount_operator,
      rule.match_amount_minor,
      t.amount_minor
    )
  ORDER BY
    (rule.match_mode = 'exact') DESC,
    (rule.match_amount_operator IS NOT NULL) DESC,
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
    AND transaction_cleanup_rule_amount_matches(
      rule.match_amount_operator,
      rule.match_amount_minor,
      original_transaction.amount_minor
    )
  ORDER BY
    (rule.match_mode = 'exact') DESC,
    (rule.match_amount_operator IS NOT NULL) DESC,
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
   original_transaction.normalized_merchant;

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
      AND transaction_cleanup_rule_amount_matches(
        rule.match_amount_operator,
        rule.match_amount_minor,
        t.amount_minor
      )
    ORDER BY
    (rule.match_mode = 'exact') DESC,
    (rule.match_amount_operator IS NOT NULL) DESC,
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
      AND transaction_cleanup_rule_amount_matches(
        rule.match_amount_operator,
        rule.match_amount_minor,
        original_transaction.amount_minor
      )
    ORDER BY
    (rule.match_mode = 'exact') DESC,
    (rule.match_amount_operator IS NOT NULL) DESC,
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

COMMENT ON TABLE transaction_cleanup_rules IS
  'Deterministic transaction matching rules. Optional changes clean up matching transactions; match-only rules provide identity for recurring occurrence reconciliation.';

COMMENT ON COLUMN transaction_cleanup_rules.match_amount_minor IS
  'Optional positive absolute amount threshold in minor currency units.';

COMMIT;
