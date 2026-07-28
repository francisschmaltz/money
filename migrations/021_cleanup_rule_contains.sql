BEGIN;

ALTER TABLE transaction_cleanup_rules
  ADD COLUMN match_mode text NOT NULL DEFAULT 'exact';

ALTER TABLE transaction_cleanup_rules
  ADD CONSTRAINT transaction_cleanup_rules_match_mode_check
    CHECK (match_mode IN ('exact', 'contains')),
  ADD CONSTRAINT transaction_cleanup_rules_contains_length_check
    CHECK (
      match_mode <> 'contains'
      OR length(normalized_match_value) >= 3
    );

ALTER TABLE transaction_cleanup_rules
  DROP CONSTRAINT IF EXISTS
    transaction_cleanup_rules_workspace_match_unique;
ALTER TABLE transaction_cleanup_rules
  ADD CONSTRAINT transaction_cleanup_rules_workspace_match_unique
    UNIQUE (
      workspace_id,
      match_field,
      match_mode,
      normalized_match_value
    );

DROP INDEX IF EXISTS transaction_cleanup_rules_workspace_enabled_idx;
CREATE INDEX transaction_cleanup_rules_workspace_enabled_idx
  ON transaction_cleanup_rules (
    workspace_id,
    enabled,
    match_mode,
    match_field,
    normalized_match_value
  );

COMMENT ON TABLE transaction_cleanup_rules IS
  'Deterministic cleanup rules over immutable normalized provider fields. Rules use exact equality or normalized substring containment.';
COMMENT ON COLUMN transaction_cleanup_rules.match_mode IS
  'Exact compares the complete normalized field. Contains matches the normalized value anywhere in the field.';

CREATE OR REPLACE FUNCTION transaction_cleanup_rule_matches(
  target_match_field text,
  target_match_mode text,
  target_match_value text,
  transaction_merchant text,
  transaction_name text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE target_match_field
    WHEN 'normalized_merchant' THEN
      CASE target_match_mode
        WHEN 'exact' THEN
          COALESCE(transaction_merchant, '') = target_match_value
        WHEN 'contains' THEN
          strpos(
            COALESCE(transaction_merchant, ''),
            target_match_value
          ) > 0
        ELSE false
      END
    WHEN 'normalized_name' THEN
      CASE target_match_mode
        WHEN 'exact' THEN
          COALESCE(transaction_name, '') = target_match_value
        WHEN 'contains' THEN
          strpos(
            COALESCE(transaction_name, ''),
            target_match_value
          ) > 0
        ELSE false
      END
    ELSE false
  END
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
 AND merchant_override.normalized_merchant =
   t.normalized_merchant
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

COMMIT;
