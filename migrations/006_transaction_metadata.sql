BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS normalized_name text;

UPDATE transactions
SET normalized_name = NULLIF(
  btrim(
    regexp_replace(
      regexp_replace(
        lower(name),
        E'\\m[0-9]{3,}\\M',
        ' ',
        'g'
      ),
      '[^[:alnum:]]+',
      ' ',
      'g'
    )
  ),
  ''
)
WHERE normalized_name IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS transactions_workspace_id_unique
  ON transactions (workspace_id, id);

CREATE INDEX IF NOT EXISTS transactions_workspace_normalized_name_idx
  ON transactions (workspace_id, normalized_name, posted_on DESC)
  WHERE normalized_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS transactions_normalized_name_trgm_idx
  ON transactions USING gin (normalized_name gin_trgm_ops)
  WHERE normalized_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS transactions_normalized_merchant_trgm_idx
  ON transactions USING gin (normalized_merchant gin_trgm_ops)
  WHERE normalized_merchant IS NOT NULL;

WITH ranked_transaction_overrides AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY workspace_id, transaction_id
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS precedence
  FROM categorization_overrides
  WHERE transaction_id IS NOT NULL
)
DELETE FROM categorization_overrides
WHERE id IN (
  SELECT id
  FROM ranked_transaction_overrides
  WHERE precedence > 1
);

WITH ranked_merchant_overrides AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY workspace_id, normalized_merchant
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS precedence
  FROM categorization_overrides
  WHERE transaction_id IS NULL
    AND normalized_merchant IS NOT NULL
)
DELETE FROM categorization_overrides
WHERE id IN (
  SELECT id
  FROM ranked_merchant_overrides
  WHERE precedence > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS
  categorization_overrides_workspace_transaction_unique
  ON categorization_overrides (workspace_id, transaction_id)
  WHERE transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  categorization_overrides_workspace_merchant_unique
  ON categorization_overrides (workspace_id, normalized_merchant)
  WHERE transaction_id IS NULL
    AND normalized_merchant IS NOT NULL;

CREATE TABLE IF NOT EXISTS transaction_metadata (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transaction_id text NOT NULL,
  display_name text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, transaction_id),
  CONSTRAINT transaction_metadata_transaction_fk
    FOREIGN KEY (workspace_id, transaction_id)
    REFERENCES transactions (workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT transaction_metadata_display_name_check
    CHECK (
      display_name IS NULL
      OR (
        display_name = btrim(display_name)
        AND length(display_name) BETWEEN 1 AND 160
      )
    )
);

CREATE INDEX IF NOT EXISTS transaction_metadata_display_name_trgm_idx
  ON transaction_metadata USING gin (lower(display_name) gin_trgm_ops)
  WHERE display_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS transaction_tags (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  normalized_name text NOT NULL,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT transaction_tags_name_check
    CHECK (
      name = btrim(name)
      AND length(name) BETWEEN 1 AND 64
    ),
  CONSTRAINT transaction_tags_normalized_name_check
    CHECK (
      normalized_name = btrim(normalized_name)
      AND normalized_name = lower(normalized_name)
      AND length(normalized_name) BETWEEN 1 AND 64
    ),
  CONSTRAINT transaction_tags_workspace_normalized_name_unique
    UNIQUE (workspace_id, normalized_name)
);

CREATE INDEX IF NOT EXISTS transaction_tags_normalized_name_trgm_idx
  ON transaction_tags USING gin (normalized_name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS transaction_tag_assignments (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transaction_id text NOT NULL,
  tag_id text NOT NULL,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, transaction_id, tag_id),
  CONSTRAINT transaction_tag_assignments_transaction_fk
    FOREIGN KEY (workspace_id, transaction_id)
    REFERENCES transactions (workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT transaction_tag_assignments_tag_fk
    FOREIGN KEY (workspace_id, tag_id)
    REFERENCES transaction_tags (workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS transaction_tag_assignments_tag_idx
  ON transaction_tag_assignments (workspace_id, tag_id, transaction_id);

COMMENT ON TABLE transaction_metadata IS
  'User-owned transaction display metadata. Provider transaction facts remain unchanged.';
COMMENT ON TABLE transaction_tags IS
  'Workspace-owned custom tags available for explicit transaction assignment.';
COMMENT ON TABLE transaction_tag_assignments IS
  'Exact user-selected transaction-to-tag assignments; fuzzy matches are never persisted as rules.';

COMMIT;
