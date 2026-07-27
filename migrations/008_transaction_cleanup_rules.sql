BEGIN;

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Migration 006 predated the application normalizer and preserved diacritics.
-- Rebuild every stored name with the same ASCII/number rules used for new
-- Plaid rows so an exact cleanup rule behaves identically across old and
-- future transactions.
UPDATE transactions
SET normalized_name = NULLIF(
  btrim(
    regexp_replace(
      regexp_replace(
        lower(unaccent(name)),
        E'\\m[0-9]{3,}\\M',
        ' ',
        'g'
      ),
      '[^a-z0-9]+',
      ' ',
      'g'
    )
  ),
  ''
)
WHERE name IS NOT NULL;

ALTER TABLE transaction_metadata
  ADD COLUMN IF NOT EXISTS tags_overridden boolean NOT NULL DEFAULT false;

UPDATE transaction_metadata metadata
SET tags_overridden = true,
    updated_at = now()
WHERE metadata.tags_overridden = false
  AND EXISTS (
    SELECT 1
    FROM transaction_tag_assignments assignment
    WHERE assignment.workspace_id = metadata.workspace_id
      AND assignment.transaction_id = metadata.transaction_id
  );

INSERT INTO transaction_metadata (
  workspace_id,
  transaction_id,
  tags_overridden
)
SELECT DISTINCT
  assignment.workspace_id,
  assignment.transaction_id,
  true
FROM transaction_tag_assignments assignment
ON CONFLICT (workspace_id, transaction_id) DO UPDATE SET
  tags_overridden = true,
  updated_at = now();

CREATE TABLE IF NOT EXISTS transaction_cleanup_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  match_field text NOT NULL,
  match_value text NOT NULL,
  normalized_match_value text NOT NULL,
  display_name text,
  category_primary text,
  tags jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transaction_cleanup_rules_match_field_check
    CHECK (match_field IN ('normalized_merchant', 'normalized_name')),
  CONSTRAINT transaction_cleanup_rules_match_value_check
    CHECK (
      match_value = btrim(match_value)
      AND length(match_value) BETWEEN 1 AND 160
    ),
  CONSTRAINT transaction_cleanup_rules_normalized_value_check
    CHECK (
      normalized_match_value = btrim(normalized_match_value)
      AND normalized_match_value = lower(normalized_match_value)
      AND length(normalized_match_value) BETWEEN 1 AND 160
    ),
  CONSTRAINT transaction_cleanup_rules_display_name_check
    CHECK (
      display_name IS NULL
      OR (
        display_name = btrim(display_name)
        AND length(display_name) BETWEEN 1 AND 160
      )
    ),
  CONSTRAINT transaction_cleanup_rules_category_check
    CHECK (
      category_primary IS NULL
      OR (
        category_primary = btrim(category_primary)
        AND length(category_primary) BETWEEN 1 AND 100
      )
    ),
  CONSTRAINT transaction_cleanup_rules_tags_check
    CHECK (
      tags IS NULL
      OR (
        jsonb_typeof(tags) = 'array'
        AND jsonb_array_length(tags) <= 20
      )
    ),
  CONSTRAINT transaction_cleanup_rules_has_change_check
    CHECK (
      display_name IS NOT NULL
      OR category_primary IS NOT NULL
      OR tags IS NOT NULL
    ),
  CONSTRAINT transaction_cleanup_rules_workspace_match_unique
    UNIQUE (workspace_id, match_field, normalized_match_value)
);

CREATE INDEX IF NOT EXISTS transaction_cleanup_rules_workspace_enabled_idx
  ON transaction_cleanup_rules (
    workspace_id,
    enabled,
    match_field,
    normalized_match_value
  );

COMMENT ON TABLE transaction_cleanup_rules IS
  'Exact deterministic cleanup rules over immutable normalized provider fields. Fuzzy similarity is discovery-only.';
COMMENT ON COLUMN transaction_cleanup_rules.tags IS
  'NULL leaves tags unchanged; an empty JSON array clears tags.';
COMMENT ON COLUMN transaction_metadata.tags_overridden IS
  'True when explicit per-transaction tags, including an empty set, override cleanup rules.';

COMMIT;
