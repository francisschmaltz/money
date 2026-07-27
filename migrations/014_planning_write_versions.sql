BEGIN;

CREATE TABLE budget_category_versions (
  workspace_id text NOT NULL
    REFERENCES workspaces(id) ON DELETE CASCADE,
  category text NOT NULL,
  version integer NOT NULL DEFAULT 0
    CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, category)
);

INSERT INTO budget_category_versions (
  workspace_id,
  category,
  version
)
SELECT existing.workspace_id, existing.category, 1
FROM (
  SELECT workspace_id, category FROM budget_lines
  UNION
  SELECT workspace_id, category FROM budget_default_revisions
) existing
ON CONFLICT (workspace_id, category) DO NOTHING;

ALTER TABLE transactions
  ADD COLUMN split_version integer NOT NULL DEFAULT 0
  CHECK (split_version >= 0);

UPDATE transactions parent
SET split_version = 1
WHERE EXISTS (
  SELECT 1
  FROM transaction_splits split
  WHERE split.workspace_id = parent.workspace_id
    AND split.transaction_id = parent.id
);

CREATE OR REPLACE FUNCTION bump_split_version_before_invalidation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD.amount_minor IS DISTINCT FROM NEW.amount_minor
    OR OLD.currency_code IS DISTINCT FROM NEW.currency_code
    OR OLD.pending IS DISTINCT FROM NEW.pending
  ) THEN
    NEW.split_version := OLD.split_version + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER a_bump_split_version_before_invalidation
BEFORE UPDATE OF amount_minor, currency_code, pending
ON transactions
FOR EACH ROW
EXECUTE FUNCTION bump_split_version_before_invalidation();

COMMIT;
