BEGIN;

CREATE OR REPLACE FUNCTION normalize_spending_category_name(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT NULLIF(
    lower(regexp_replace(btrim(value), '[[:space:]]+', ' ', 'g')),
    ''
  )
$$;

CREATE OR REPLACE FUNCTION default_spending_category_name(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT CASE upper(btrim(value))
    WHEN 'BANK_FEES' THEN 'Fees & Interest'
    WHEN 'ENTERTAINMENT' THEN 'Entertainment'
    WHEN 'FOOD_AND_DRINK' THEN 'Food & Drink'
    WHEN 'GENERAL_MERCHANDISE' THEN 'Shopping'
    WHEN 'GENERAL_SERVICES' THEN 'Services'
    WHEN 'GOVERNMENT_AND_NON_PROFIT' THEN 'Government & Nonprofit'
    WHEN 'HOME_IMPROVEMENT' THEN 'Home'
    WHEN 'INCOME' THEN 'Income'
    WHEN 'LOAN_PAYMENTS' THEN 'Loan Payments'
    WHEN 'MEDICAL' THEN 'Medical'
    WHEN 'PERSONAL_CARE' THEN 'Personal Care'
    WHEN 'RENT_AND_UTILITIES' THEN 'Housing & Utilities'
    WHEN 'TRANSFER_IN' THEN 'Transfers'
    WHEN 'TRANSFER_OUT' THEN 'Transfers'
    WHEN 'TRANSPORTATION' THEN 'Transportation'
    WHEN 'TRAVEL' THEN 'Travel'
    ELSE CASE
      WHEN btrim(value) = upper(btrim(value))
        AND position('_' IN btrim(value)) > 0
        THEN initcap(replace(lower(btrim(value)), '_', ' '))
      ELSE btrim(value)
    END
  END
$$;

CREATE TABLE spending_categories (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  normalized_name text NOT NULL,
  classification text NOT NULL DEFAULT 'flexible'
    CHECK (classification IN ('fixed', 'flexible')),
  parent_category_id text,
  merged_into_category_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  CONSTRAINT spending_categories_name_check
    CHECK (
      name = btrim(name)
      AND length(name) BETWEEN 1 AND 100
      AND normalized_name = normalize_spending_category_name(name)
    ),
  CONSTRAINT spending_categories_merge_target_fk
    FOREIGN KEY (workspace_id, merged_into_category_id)
    REFERENCES spending_categories (workspace_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT spending_categories_parent_fk
    FOREIGN KEY (workspace_id, parent_category_id)
    REFERENCES spending_categories (workspace_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT spending_categories_not_self_merged
    CHECK (merged_into_category_id IS NULL OR merged_into_category_id <> id),
  CONSTRAINT spending_categories_not_self_parent
    CHECK (parent_category_id IS NULL OR parent_category_id <> id)
);
CREATE UNIQUE INDEX spending_categories_active_name_unique
  ON spending_categories (workspace_id, normalized_name)
  WHERE merged_into_category_id IS NULL;
CREATE INDEX spending_categories_merge_target_idx
  ON spending_categories (workspace_id, merged_into_category_id)
  WHERE merged_into_category_id IS NOT NULL;
CREATE INDEX spending_categories_parent_idx
  ON spending_categories (workspace_id, parent_category_id)
  WHERE parent_category_id IS NOT NULL;

CREATE TABLE spending_category_aliases (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  normalized_alias text NOT NULL,
  alias text NOT NULL,
  category_id text NOT NULL,
  alias_type text NOT NULL DEFAULT 'observed'
    CHECK (alias_type IN ('observed', 'name', 'former_name')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, normalized_alias),
  CONSTRAINT spending_category_aliases_category_fk
    FOREIGN KEY (workspace_id, category_id)
    REFERENCES spending_categories (workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT spending_category_aliases_value_check
    CHECK (
      alias = btrim(alias)
      AND length(alias) BETWEEN 1 AND 500
      AND normalized_alias = normalize_spending_category_name(alias)
    )
);
CREATE INDEX spending_category_aliases_category_idx
  ON spending_category_aliases (workspace_id, category_id);

CREATE TABLE spending_category_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category_id text,
  event_type text NOT NULL
    CHECK (event_type IN ('create', 'rename', 'reclassify', 'merge')),
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spending_category_events_workspace_time_idx
  ON spending_category_events (workspace_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION active_spending_category_id(
  target_workspace_id text,
  target_category_id text
)
RETURNS text
LANGUAGE sql
STABLE
RETURNS NULL ON NULL INPUT
AS $$
  WITH RECURSIVE category_path AS (
    SELECT
      category.id,
      category.merged_into_category_id,
      ARRAY[category.id]::text[] AS visited
    FROM spending_categories category
    WHERE category.workspace_id = target_workspace_id
      AND category.id = target_category_id
    UNION ALL
    SELECT
      destination.id,
      destination.merged_into_category_id,
      category_path.visited || destination.id
    FROM category_path
    JOIN spending_categories destination
      ON destination.workspace_id = target_workspace_id
     AND destination.id = category_path.merged_into_category_id
    WHERE NOT destination.id = ANY(category_path.visited)
  )
  SELECT id
  FROM category_path
  WHERE merged_into_category_id IS NULL
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION spending_category_id_for_label(
  target_workspace_id text,
  target_label text
)
RETURNS text
LANGUAGE sql
STABLE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT active_spending_category_id(
    target_workspace_id,
    alias.category_id
  )
  FROM spending_category_aliases alias
  WHERE alias.workspace_id = target_workspace_id
    AND alias.normalized_alias =
      normalize_spending_category_name(target_label)
$$;

CREATE OR REPLACE FUNCTION spending_category_name_for_id(
  target_workspace_id text,
  target_category_id text
)
RETURNS text
LANGUAGE sql
STABLE
RETURNS NULL ON NULL INPUT
AS $$
  WITH RECURSIVE category_path AS (
    SELECT
      category.id,
      category.parent_category_id,
      category.name,
      0 AS depth,
      ARRAY[category.id]::text[] AS visited
    FROM spending_categories category
    WHERE category.workspace_id = target_workspace_id
      AND category.id =
        active_spending_category_id(
          target_workspace_id,
          target_category_id
        )
    UNION ALL
    SELECT
      parent.id,
      parent.parent_category_id,
      parent.name,
      category_path.depth + 1,
      category_path.visited || parent.id
    FROM category_path
    JOIN spending_categories parent
      ON parent.workspace_id = target_workspace_id
     AND parent.id = category_path.parent_category_id
    WHERE NOT parent.id = ANY(category_path.visited)
  )
  SELECT string_agg(name, ' / ' ORDER BY depth DESC)
  FROM category_path
$$;

CREATE OR REPLACE FUNCTION spending_category_name_for_label(
  target_workspace_id text,
  target_label text
)
RETURNS text
LANGUAGE sql
STABLE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT spending_category_name_for_id(
    target_workspace_id,
    spending_category_id_for_label(target_workspace_id, target_label)
  )
$$;

CREATE OR REPLACE FUNCTION spending_category_descendant_ids(
  target_workspace_id text,
  target_category_id text
)
RETURNS TABLE(category_id text)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE descendants AS (
    SELECT
      category.id,
      ARRAY[category.id]::text[] AS visited
    FROM spending_categories category
    WHERE category.workspace_id = target_workspace_id
      AND category.id =
        active_spending_category_id(
          target_workspace_id,
          target_category_id
        )
    UNION ALL
    SELECT
      child.id,
      descendants.visited || child.id
    FROM descendants
    JOIN spending_categories child
      ON child.workspace_id = target_workspace_id
     AND child.parent_category_id = descendants.id
     AND child.merged_into_category_id IS NULL
    WHERE NOT child.id = ANY(descendants.visited)
  )
  SELECT id
  FROM descendants
$$;

CREATE OR REPLACE FUNCTION ensure_spending_category(
  target_workspace_id text,
  target_label text
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_label text;
  display_name text;
  resolved_id text;
  generated_id text;
BEGIN
  normalized_label := normalize_spending_category_name(target_label);
  IF normalized_label IS NULL THEN
    RETURN NULL;
  END IF;

  resolved_id := spending_category_id_for_label(
    target_workspace_id,
    target_label
  );
  IF resolved_id IS NOT NULL THEN
    RETURN resolved_id;
  END IF;

  display_name := default_spending_category_name(target_label);
  generated_id :=
    'category_' ||
    substr(md5(target_workspace_id || ':' || normalized_label), 1, 24);

  INSERT INTO spending_categories (
    id,
    workspace_id,
    name,
    normalized_name
  )
  VALUES (
    generated_id,
    target_workspace_id,
    display_name,
    normalize_spending_category_name(display_name)
  )
  ON CONFLICT DO NOTHING;

  SELECT category.id
  INTO resolved_id
  FROM spending_categories category
  WHERE category.workspace_id = target_workspace_id
    AND category.merged_into_category_id IS NULL
    AND category.normalized_name =
      normalize_spending_category_name(display_name)
  LIMIT 1;

  IF resolved_id IS NULL THEN
    resolved_id := generated_id;
  END IF;

  INSERT INTO spending_category_aliases (
    workspace_id,
    normalized_alias,
    alias,
    category_id,
    alias_type
  )
  VALUES (
    target_workspace_id,
    normalized_label,
    btrim(target_label),
    resolved_id,
    'observed'
  )
  ON CONFLICT (workspace_id, normalized_alias) DO NOTHING;

  INSERT INTO spending_category_aliases (
    workspace_id,
    normalized_alias,
    alias,
    category_id,
    alias_type
  )
  VALUES (
    target_workspace_id,
    normalize_spending_category_name(display_name),
    display_name,
    resolved_id,
    'name'
  )
  ON CONFLICT (workspace_id, normalized_alias) DO NOTHING;

  RETURN spending_category_id_for_label(
    target_workspace_id,
    target_label
  );
END
$$;

WITH category_labels AS (
  SELECT workspace_id, category_primary AS label
  FROM transactions
  WHERE category_primary IS NOT NULL
  UNION
  SELECT workspace_id, category_primary
  FROM categorization_overrides
  WHERE category_primary IS NOT NULL
  UNION
  SELECT workspace_id, category_primary
  FROM transaction_cleanup_rules
  WHERE category_primary IS NOT NULL
  UNION
  SELECT workspace_id, category
  FROM transaction_splits
  UNION
  SELECT workspace_id, category
  FROM budget_lines
  UNION
  SELECT workspace_id, category
  FROM budget_default_revisions
  UNION
  SELECT workspace_id, category
  FROM budget_category_versions
  UNION
  SELECT
    rule.workspace_id,
    fixed_category.value
  FROM insight_rules rule
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(rule.settings -> 'categories') = 'array'
        THEN rule.settings -> 'categories'
      ELSE '[]'::jsonb
    END
  ) fixed_category(value)
  WHERE rule.family = 'weekly'
    AND rule.rule_key = 'fixed_categories'
)
SELECT ensure_spending_category(workspace_id, label)
FROM category_labels
WHERE normalize_spending_category_name(label) IS NOT NULL
ORDER BY workspace_id, normalize_spending_category_name(label), label;

UPDATE spending_categories category
SET classification = 'fixed',
    updated_at = now()
WHERE EXISTS (
  SELECT 1
  FROM insight_rules rule
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(rule.settings -> 'categories') = 'array'
        THEN rule.settings -> 'categories'
      ELSE '[]'::jsonb
    END
  ) fixed_category(value)
  WHERE rule.workspace_id = category.workspace_id
    AND rule.family = 'weekly'
    AND rule.rule_key = 'fixed_categories'
    AND spending_category_id_for_label(
      rule.workspace_id,
      fixed_category.value
    ) = category.id
);

ALTER TABLE categorization_overrides
  ADD COLUMN category_id text;
ALTER TABLE transaction_cleanup_rules
  ADD COLUMN category_id text;
ALTER TABLE transaction_splits
  ADD COLUMN category_id text;
ALTER TABLE budget_lines
  ADD COLUMN category_id text;
ALTER TABLE budget_default_revisions
  ADD COLUMN category_id text;
ALTER TABLE budget_category_versions
  ADD COLUMN category_id text;

UPDATE categorization_overrides
SET category_id = spending_category_id_for_label(
  workspace_id,
  category_primary
)
WHERE category_primary IS NOT NULL;
UPDATE transaction_cleanup_rules
SET category_id = spending_category_id_for_label(
  workspace_id,
  category_primary
)
WHERE category_primary IS NOT NULL;
UPDATE transaction_splits
SET category_id = spending_category_id_for_label(workspace_id, category);
UPDATE budget_lines
SET category_id = spending_category_id_for_label(workspace_id, category);
UPDATE budget_default_revisions
SET category_id = spending_category_id_for_label(workspace_id, category);
UPDATE budget_category_versions
SET category_id = spending_category_id_for_label(workspace_id, category);

CREATE TEMP TABLE migrated_budget_lines
ON COMMIT DROP
AS
SELECT
  line.workspace_id,
  line.month_on,
  spending_category_name_for_id(
    line.workspace_id,
    line.category_id
  ) AS category,
  line.category_id,
  SUM(line.amount_minor)::bigint AS amount_minor,
  line.currency_code,
  MAX(line.updated_by) AS updated_by,
  MAX(line.updated_at) AS updated_at
FROM budget_lines line
GROUP BY
  line.workspace_id,
  line.month_on,
  line.category_id,
  line.currency_code;

DELETE FROM budget_lines;
INSERT INTO budget_lines (
  workspace_id,
  month_on,
  category,
  category_id,
  amount_minor,
  currency_code,
  updated_by,
  updated_at
)
SELECT
  workspace_id,
  month_on,
  category,
  category_id,
  amount_minor,
  currency_code,
  updated_by,
  updated_at
FROM migrated_budget_lines;

CREATE TEMP TABLE migrated_budget_default_revisions
ON COMMIT DROP
AS
WITH sources AS (
  SELECT DISTINCT
    revision.workspace_id,
    revision.category_id,
    revision.category AS source_category
  FROM budget_default_revisions revision
),
event_months AS (
  SELECT DISTINCT
    revision.workspace_id,
    revision.category_id,
    revision.effective_month_on
  FROM budget_default_revisions revision
),
totals AS (
  SELECT
    event.workspace_id,
    event.category_id,
    event.effective_month_on,
    SUM(COALESCE(latest.amount_minor, 0))::bigint AS amount_minor,
    COALESCE(MAX(latest.currency_code), 'USD')::char(3)
      AS currency_code,
    MAX(latest.updated_by) AS updated_by,
    MAX(latest.updated_at) AS updated_at
  FROM event_months event
  JOIN sources source
    ON source.workspace_id = event.workspace_id
   AND source.category_id = event.category_id
  LEFT JOIN LATERAL (
    SELECT
      revision.amount_minor,
      revision.currency_code,
      revision.updated_by,
      revision.updated_at
    FROM budget_default_revisions revision
    WHERE revision.workspace_id = event.workspace_id
      AND revision.category = source.source_category
      AND revision.effective_month_on <= event.effective_month_on
    ORDER BY revision.effective_month_on DESC
    LIMIT 1
  ) latest ON true
  GROUP BY
    event.workspace_id,
    event.category_id,
    event.effective_month_on
),
changes AS (
  SELECT
    total.*,
    LAG(total.amount_minor) OVER (
      PARTITION BY total.workspace_id, total.category_id
      ORDER BY total.effective_month_on
    ) AS previous_amount_minor
  FROM totals total
)
SELECT
  change.workspace_id,
  spending_category_name_for_id(
    change.workspace_id,
    change.category_id
  ) AS category,
  change.category_id,
  change.effective_month_on,
  change.amount_minor,
  change.currency_code,
  change.updated_by,
  change.updated_at
FROM changes change
WHERE change.previous_amount_minor IS DISTINCT FROM change.amount_minor;

DELETE FROM budget_default_revisions;
INSERT INTO budget_default_revisions (
  workspace_id,
  category,
  category_id,
  effective_month_on,
  amount_minor,
  currency_code,
  updated_by,
  updated_at
)
SELECT
  workspace_id,
  category,
  category_id,
  effective_month_on,
  amount_minor,
  currency_code,
  updated_by,
  updated_at
FROM migrated_budget_default_revisions;

CREATE TEMP TABLE migrated_budget_category_versions
ON COMMIT DROP
AS
SELECT
  version.workspace_id,
  spending_category_name_for_id(
    version.workspace_id,
    version.category_id
  ) AS category,
  version.category_id,
  MAX(version.version) + 1 AS version,
  MAX(version.updated_at) AS updated_at
FROM budget_category_versions version
GROUP BY version.workspace_id, version.category_id;

DELETE FROM budget_category_versions;
INSERT INTO budget_category_versions (
  workspace_id,
  category,
  category_id,
  version,
  updated_at
)
SELECT
  workspace_id,
  category,
  category_id,
  version,
  updated_at
FROM migrated_budget_category_versions;

ALTER TABLE categorization_overrides
  ADD CONSTRAINT categorization_overrides_category_fk
  FOREIGN KEY (workspace_id, category_id)
  REFERENCES spending_categories (workspace_id, id)
  ON DELETE RESTRICT;
ALTER TABLE transaction_cleanup_rules
  ADD CONSTRAINT transaction_cleanup_rules_category_fk
  FOREIGN KEY (workspace_id, category_id)
  REFERENCES spending_categories (workspace_id, id)
  ON DELETE RESTRICT;
ALTER TABLE transaction_splits
  ALTER COLUMN category_id SET NOT NULL,
  ADD CONSTRAINT transaction_splits_category_fk
  FOREIGN KEY (workspace_id, category_id)
  REFERENCES spending_categories (workspace_id, id)
  ON DELETE RESTRICT;
ALTER TABLE budget_lines
  ALTER COLUMN category_id SET NOT NULL,
  ADD CONSTRAINT budget_lines_category_fk
  FOREIGN KEY (workspace_id, category_id)
  REFERENCES spending_categories (workspace_id, id)
  ON DELETE RESTRICT;
ALTER TABLE budget_default_revisions
  ALTER COLUMN category_id SET NOT NULL,
  ADD CONSTRAINT budget_default_revisions_category_fk
  FOREIGN KEY (workspace_id, category_id)
  REFERENCES spending_categories (workspace_id, id)
  ON DELETE RESTRICT;
ALTER TABLE budget_category_versions
  ALTER COLUMN category_id SET NOT NULL,
  ADD CONSTRAINT budget_category_versions_category_fk
  FOREIGN KEY (workspace_id, category_id)
  REFERENCES spending_categories (workspace_id, id)
  ON DELETE RESTRICT;

CREATE INDEX categorization_overrides_category_idx
  ON categorization_overrides (workspace_id, category_id)
  WHERE category_id IS NOT NULL;
CREATE INDEX transaction_cleanup_rules_category_idx
  ON transaction_cleanup_rules (workspace_id, category_id)
  WHERE category_id IS NOT NULL;
CREATE INDEX transaction_splits_category_idx
  ON transaction_splits (workspace_id, category_id, transaction_id);
CREATE INDEX budget_lines_category_idx
  ON budget_lines (workspace_id, category_id, month_on);
CREATE INDEX budget_default_revisions_category_idx
  ON budget_default_revisions (
    workspace_id,
    category_id,
    effective_month_on
  );

CREATE OR REPLACE FUNCTION assign_spending_category_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.category IS NOT NULL THEN
    NEW.category_id := ensure_spending_category(
      NEW.workspace_id,
      NEW.category
    );
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION assign_primary_spending_category_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.category_primary IS NOT NULL THEN
    NEW.category_id := ensure_spending_category(
      NEW.workspace_id,
      NEW.category_primary
    );
  ELSE
    NEW.category_id := NULL;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION observe_transaction_spending_category()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM ensure_spending_category(
    NEW.workspace_id,
    NEW.category_primary
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER transactions_observe_spending_category
AFTER INSERT OR UPDATE OF category_primary
ON transactions
FOR EACH ROW
EXECUTE FUNCTION observe_transaction_spending_category();

CREATE TRIGGER categorization_overrides_assign_category
BEFORE INSERT OR UPDATE OF category_primary
ON categorization_overrides
FOR EACH ROW
EXECUTE FUNCTION assign_primary_spending_category_id();

CREATE TRIGGER transaction_cleanup_rules_assign_category
BEFORE INSERT OR UPDATE OF category_primary
ON transaction_cleanup_rules
FOR EACH ROW
EXECUTE FUNCTION assign_primary_spending_category_id();

CREATE TRIGGER transaction_splits_assign_category
BEFORE INSERT OR UPDATE OF category
ON transaction_splits
FOR EACH ROW
EXECUTE FUNCTION assign_spending_category_id();

CREATE TRIGGER budget_lines_assign_category
BEFORE INSERT OR UPDATE OF category
ON budget_lines
FOR EACH ROW
EXECUTE FUNCTION assign_spending_category_id();

CREATE TRIGGER budget_default_revisions_assign_category
BEFORE INSERT OR UPDATE OF category
ON budget_default_revisions
FOR EACH ROW
EXECUTE FUNCTION assign_spending_category_id();

CREATE TRIGGER budget_category_versions_assign_category
BEFORE INSERT OR UPDATE OF category
ON budget_category_versions
FOR EACH ROW
EXECUTE FUNCTION assign_spending_category_id();

CREATE VIEW transaction_effective_spending_categories AS
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
    AND (
      (
        rule.match_field = 'normalized_merchant'
        AND rule.normalized_match_value = t.normalized_merchant
      )
      OR (
        rule.match_field = 'normalized_name'
        AND rule.normalized_match_value = t.normalized_name
      )
    )
  ORDER BY
    (rule.match_field = 'normalized_merchant') DESC,
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
    AND (
      (
        rule.match_field = 'normalized_merchant'
        AND rule.normalized_match_value =
          original_transaction.normalized_merchant
      )
      OR (
        rule.match_field = 'normalized_name'
        AND rule.normalized_match_value =
          original_transaction.normalized_name
      )
    )
  ORDER BY
    (rule.match_field = 'normalized_merchant') DESC,
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
