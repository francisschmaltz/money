BEGIN;

ALTER TABLE spending_categories
  ADD COLUMN is_system boolean NOT NULL DEFAULT false;

ALTER TABLE spending_category_events
  DROP CONSTRAINT spending_category_events_event_type_check;
ALTER TABLE spending_category_events
  ADD CONSTRAINT spending_category_events_event_type_check
    CHECK (
      event_type IN (
        'create',
        'rename',
        'reclassify',
        'merge',
        'split',
        'delete'
      )
    );

INSERT INTO spending_categories (
  id,
  workspace_id,
  name,
  normalized_name,
  classification,
  is_system
)
SELECT
  'category_' || substr(md5(workspace.id || ':other'), 1, 24),
  workspace.id,
  'Other',
  'other',
  'flexible',
  true
FROM workspaces workspace
WHERE NOT EXISTS (
  SELECT 1
  FROM spending_categories category
  WHERE category.workspace_id = workspace.id
    AND category.merged_into_category_id IS NULL
    AND category.normalized_name = 'other'
)
ON CONFLICT DO NOTHING;

INSERT INTO spending_category_aliases (
  workspace_id,
  normalized_alias,
  alias,
  category_id,
  alias_type
)
SELECT
  category.workspace_id,
  normalize_spending_category_name(
    spending_category_name_for_id(category.workspace_id, category.id)
  ),
  spending_category_name_for_id(category.workspace_id, category.id),
  category.id,
  'former_name'
FROM spending_categories category
WHERE category.merged_into_category_id IS NULL
  AND (
    category.normalized_name = 'other'
    OR category.parent_category_id IN (
      SELECT other.id
      FROM spending_categories other
      WHERE other.workspace_id = category.workspace_id
        AND other.merged_into_category_id IS NULL
        AND other.normalized_name = 'other'
    )
  )
ON CONFLICT (workspace_id, normalized_alias) DO UPDATE SET
  alias_type = 'former_name'
WHERE spending_category_aliases.category_id = EXCLUDED.category_id;

UPDATE spending_categories child
SET parent_category_id = NULL,
    version = version + 1,
    updated_at = now()
WHERE child.merged_into_category_id IS NULL
  AND child.parent_category_id IN (
    SELECT other.id
    FROM spending_categories other
    WHERE other.workspace_id = child.workspace_id
      AND other.merged_into_category_id IS NULL
      AND other.normalized_name = 'other'
  );

UPDATE spending_categories category
SET name = 'Other',
    normalized_name = 'other',
    classification = 'flexible',
    parent_category_id = NULL,
    is_system = true,
    version = version + 1,
    updated_at = now()
WHERE category.merged_into_category_id IS NULL
  AND category.normalized_name = 'other';

INSERT INTO spending_category_aliases (
  workspace_id,
  normalized_alias,
  alias,
  category_id,
  alias_type
)
SELECT
  category.workspace_id,
  'other',
  'Other',
  category.id,
  'name'
FROM spending_categories category
WHERE category.is_system = true
ON CONFLICT (workspace_id, normalized_alias) DO UPDATE SET
  alias = 'Other',
  category_id = EXCLUDED.category_id,
  alias_type = 'name';

INSERT INTO spending_category_aliases (
  workspace_id,
  normalized_alias,
  alias,
  category_id,
  alias_type
)
SELECT
  category.workspace_id,
  normalize_spending_category_name(
    spending_category_name_for_id(category.workspace_id, category.id)
  ),
  spending_category_name_for_id(category.workspace_id, category.id),
  category.id,
  'name'
FROM spending_categories category
WHERE category.merged_into_category_id IS NULL
ON CONFLICT (workspace_id, normalized_alias) DO UPDATE SET
  alias = EXCLUDED.alias,
  category_id = EXCLUDED.category_id,
  alias_type = 'name'
WHERE spending_category_aliases.category_id = EXCLUDED.category_id;

UPDATE categorization_overrides entry
SET category_primary = spending_category_name_for_id(
      entry.workspace_id,
      entry.category_id
    ),
    updated_at = now()
WHERE entry.category_id IS NOT NULL;

UPDATE transaction_cleanup_rules entry
SET category_primary = spending_category_name_for_id(
      entry.workspace_id,
      entry.category_id
    ),
    updated_at = now()
WHERE entry.category_id IS NOT NULL;

UPDATE transaction_splits entry
SET category = spending_category_name_for_id(
      entry.workspace_id,
      entry.category_id
    ),
    updated_at = now()
WHERE entry.category_id IS NOT NULL;

UPDATE budget_lines entry
SET category = spending_category_name_for_id(
      entry.workspace_id,
      entry.category_id
    ),
    updated_at = now()
WHERE entry.category_id IS NOT NULL;

UPDATE budget_default_revisions entry
SET category = spending_category_name_for_id(
      entry.workspace_id,
      entry.category_id
    ),
    updated_at = now()
WHERE entry.category_id IS NOT NULL;

UPDATE budget_category_versions entry
SET category = spending_category_name_for_id(
      entry.workspace_id,
      entry.category_id
    ),
    updated_at = now()
WHERE entry.category_id IS NOT NULL;

CREATE UNIQUE INDEX spending_categories_system_unique
  ON spending_categories (workspace_id)
  WHERE is_system = true;

ALTER TABLE spending_categories
  ADD CONSTRAINT spending_categories_system_shape_check
    CHECK (
      NOT is_system
      OR (
        name = 'Other'
        AND normalized_name = 'other'
        AND classification = 'flexible'
        AND parent_category_id IS NULL
        AND merged_into_category_id IS NULL
      )
    );

CREATE OR REPLACE FUNCTION protect_system_spending_category()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.parent_category_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM spending_categories parent
    WHERE parent.workspace_id = NEW.workspace_id
      AND parent.id = NEW.parent_category_id
      AND parent.is_system = true
  ) THEN
    RAISE EXCEPTION 'Other cannot contain child categories'
      USING ERRCODE = '23514',
            CONSTRAINT =
              'spending_categories_system_parent_forbidden';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER spending_categories_protect_system_parent
BEFORE INSERT OR UPDATE OF parent_category_id
ON spending_categories
FOR EACH ROW
EXECUTE FUNCTION protect_system_spending_category();

COMMIT;
