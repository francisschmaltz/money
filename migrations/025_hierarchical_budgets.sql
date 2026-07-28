BEGIN;

ALTER TABLE budget_lines
  ADD COLUMN tracking_mode text NOT NULL DEFAULT 'tracked'
    CHECK (tracking_mode IN ('tracked', 'informational'));

ALTER TABLE budget_default_revisions
  ADD COLUMN tracking_mode text NOT NULL DEFAULT 'tracked'
    CHECK (tracking_mode IN ('tracked', 'informational')),
  ADD COLUMN is_removed boolean NOT NULL DEFAULT false;

ALTER TABLE budget_lines DROP CONSTRAINT budget_lines_pkey;
ALTER TABLE budget_lines
  ADD PRIMARY KEY (workspace_id, month_on, category_id);

ALTER TABLE budget_default_revisions
  DROP CONSTRAINT budget_default_revisions_pkey;
ALTER TABLE budget_default_revisions
  ADD PRIMARY KEY (workspace_id, category_id, effective_month_on);

ALTER TABLE budget_category_versions
  DROP CONSTRAINT budget_category_versions_pkey;
ALTER TABLE budget_category_versions
  ADD PRIMARY KEY (workspace_id, category_id);

DROP INDEX IF EXISTS budget_default_revisions_resolve_idx;
CREATE INDEX budget_default_revisions_resolve_idx
  ON budget_default_revisions (
    workspace_id,
    category_id,
    effective_month_on DESC
  );

CREATE TABLE budget_settings (
  workspace_id text PRIMARY KEY
    REFERENCES workspaces(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE budget_income_categories (
  workspace_id text NOT NULL
    REFERENCES workspaces(id) ON DELETE CASCADE,
  category_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, category_id),
  FOREIGN KEY (workspace_id, category_id)
    REFERENCES spending_categories (workspace_id, id)
    ON DELETE RESTRICT
);

INSERT INTO budget_settings (workspace_id)
SELECT id FROM workspaces
ON CONFLICT (workspace_id) DO NOTHING;

-- Existing flat budgets can contain child allocations without an ancestor
-- envelope. Repeatedly add or raise parent revisions until every level can
-- contain its immediate child allocations. Twenty levels is deliberately
-- beyond the supported UI depth and keeps corrupt cycles bounded.
DO $$
DECLARE
  pass integer;
BEGIN
  FOR pass IN 1..20 LOOP
    WITH event_months AS (
      SELECT DISTINCT workspace_id, effective_month_on
      FROM budget_default_revisions
    ),
    required_parent_amounts AS (
      SELECT
        event.workspace_id,
        parent.id AS category_id,
        event.effective_month_on,
        SUM(child_budget.amount_minor)::bigint AS amount_minor
      FROM event_months event
      JOIN spending_categories parent
        ON parent.workspace_id = event.workspace_id
       AND parent.merged_into_category_id IS NULL
      JOIN spending_categories child
        ON child.workspace_id = parent.workspace_id
       AND child.parent_category_id = parent.id
       AND child.merged_into_category_id IS NULL
      JOIN LATERAL (
        SELECT revision.amount_minor
        FROM budget_default_revisions revision
        WHERE revision.workspace_id = event.workspace_id
          AND revision.category_id = child.id
          AND revision.effective_month_on <= event.effective_month_on
        ORDER BY revision.effective_month_on DESC
        LIMIT 1
      ) child_budget ON true
      WHERE NOT EXISTS (
        SELECT 1
        FROM budget_default_revisions removed
        WHERE removed.workspace_id = event.workspace_id
          AND removed.category_id = child.id
          AND removed.effective_month_on <= event.effective_month_on
          AND removed.is_removed = true
          AND NOT EXISTS (
            SELECT 1
            FROM budget_default_revisions newer
            WHERE newer.workspace_id = removed.workspace_id
              AND newer.category_id = removed.category_id
              AND newer.effective_month_on <= event.effective_month_on
              AND newer.effective_month_on > removed.effective_month_on
          )
      )
      GROUP BY event.workspace_id, parent.id, event.effective_month_on
    )
    INSERT INTO budget_default_revisions (
      workspace_id,
      category,
      category_id,
      effective_month_on,
      amount_minor,
      currency_code,
      tracking_mode,
      is_removed,
      updated_at
    )
    SELECT
      required.workspace_id,
      spending_category_name_for_id(
        required.workspace_id,
        required.category_id
      ),
      required.category_id,
      required.effective_month_on,
      required.amount_minor,
      'USD',
      'tracked',
      false,
      now()
    FROM required_parent_amounts required
    ON CONFLICT (workspace_id, category_id, effective_month_on)
    DO UPDATE SET
      amount_minor = GREATEST(
        budget_default_revisions.amount_minor,
        EXCLUDED.amount_minor
      ),
      is_removed = false,
      updated_at = now();
  END LOOP;
END
$$;

-- Exact historical months resolve against their standing defaults. Materialize
-- only the ancestor amounts needed to keep those resolved trees valid.
DO $$
DECLARE
  pass integer;
BEGIN
  FOR pass IN 1..20 LOOP
    WITH required_parent_amounts AS (
      SELECT
        month.workspace_id,
        month.month_on,
        parent.id AS category_id,
        GREATEST(
          SUM(
            COALESCE(child_exact.amount_minor, child_default.amount_minor)
          )::bigint,
          COALESCE(
            parent_exact.amount_minor,
            CASE
              WHEN parent_default.is_removed THEN 0
              ELSE parent_default.amount_minor
            END,
            0
          )
        ) AS amount_minor,
        COALESCE(
          parent_exact.tracking_mode,
          parent_default.tracking_mode,
          'tracked'
        ) AS tracking_mode
      FROM budget_months month
      JOIN spending_categories parent
        ON parent.workspace_id = month.workspace_id
       AND parent.merged_into_category_id IS NULL
      JOIN spending_categories child
        ON child.workspace_id = parent.workspace_id
       AND child.parent_category_id = parent.id
       AND child.merged_into_category_id IS NULL
      LEFT JOIN budget_lines child_exact
        ON child_exact.workspace_id = month.workspace_id
       AND child_exact.month_on = month.month_on
       AND child_exact.category_id = child.id
      LEFT JOIN LATERAL (
        SELECT
          revision.amount_minor,
          revision.is_removed
        FROM budget_default_revisions revision
        WHERE revision.workspace_id = month.workspace_id
          AND revision.category_id = child.id
          AND revision.effective_month_on <= month.month_on
        ORDER BY revision.effective_month_on DESC
        LIMIT 1
      ) child_default ON true
      LEFT JOIN budget_lines parent_exact
        ON parent_exact.workspace_id = month.workspace_id
       AND parent_exact.month_on = month.month_on
       AND parent_exact.category_id = parent.id
      LEFT JOIN LATERAL (
        SELECT
          revision.amount_minor,
          revision.tracking_mode,
          revision.is_removed
        FROM budget_default_revisions revision
        WHERE revision.workspace_id = month.workspace_id
          AND revision.category_id = parent.id
          AND revision.effective_month_on <= month.month_on
        ORDER BY revision.effective_month_on DESC
        LIMIT 1
      ) parent_default ON true
      WHERE child_exact.category_id IS NOT NULL
         OR (
           child_default.amount_minor IS NOT NULL
           AND NOT child_default.is_removed
         )
      GROUP BY
        month.workspace_id,
        month.month_on,
        parent.id,
        parent_exact.amount_minor,
        parent_exact.tracking_mode,
        parent_default.amount_minor,
        parent_default.tracking_mode,
        parent_default.is_removed
    )
    INSERT INTO budget_lines (
      workspace_id,
      month_on,
      category,
      category_id,
      amount_minor,
      currency_code,
      tracking_mode,
      updated_at
    )
    SELECT
      required.workspace_id,
      required.month_on,
      spending_category_name_for_id(
        required.workspace_id,
        required.category_id
      ),
      required.category_id,
      required.amount_minor,
      'USD',
      required.tracking_mode,
      now()
    FROM required_parent_amounts required
    ON CONFLICT (workspace_id, month_on, category_id)
    DO UPDATE SET
      amount_minor = GREATEST(
        budget_lines.amount_minor,
        EXCLUDED.amount_minor
      ),
      updated_at = now();
  END LOOP;
END
$$;

CREATE FUNCTION budget_hierarchy_is_valid(
  target_workspace_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  WITH current_month AS (
    SELECT date_trunc(
      'month',
      now() AT TIME ZONE workspace.timezone
    )::date AS month_on
    FROM workspaces workspace
    WHERE workspace.id = target_workspace_id
  ),
  moment_candidates AS (
    SELECT
      effective_month_on AS month_on,
      false AS include_exact
    FROM budget_default_revisions
    WHERE workspace_id = target_workspace_id
    UNION
    SELECT month_on, true
    FROM budget_months
    WHERE workspace_id = target_workspace_id
    UNION
    SELECT
      current_month.month_on,
      EXISTS (
        SELECT 1
        FROM budget_months exact_month
        WHERE exact_month.workspace_id = target_workspace_id
          AND exact_month.month_on = current_month.month_on
      )
    FROM current_month
  ),
  moments AS (
    SELECT month_on, bool_or(include_exact) AS include_exact
    FROM moment_candidates
    GROUP BY month_on
  ),
  resolved AS (
    SELECT
      moment.month_on,
      category.id AS category_id,
      category.parent_category_id,
      COALESCE(exact.amount_minor, standing.amount_minor) AS amount_minor
    FROM moments moment
    JOIN spending_categories category
      ON category.workspace_id = target_workspace_id
     AND category.merged_into_category_id IS NULL
    LEFT JOIN LATERAL (
      SELECT line.amount_minor
      FROM budget_lines line
      WHERE moment.include_exact
        AND line.workspace_id = target_workspace_id
        AND line.month_on = moment.month_on
        AND line.category_id = category.id
      LIMIT 1
    ) exact ON true
    LEFT JOIN LATERAL (
      SELECT revision.amount_minor, revision.is_removed
      FROM budget_default_revisions revision
      WHERE revision.workspace_id = target_workspace_id
        AND revision.category_id = category.id
        AND revision.effective_month_on <= moment.month_on
      ORDER BY revision.effective_month_on DESC
      LIMIT 1
    ) standing ON true
    WHERE exact.amount_minor IS NOT NULL
       OR (
         standing.amount_minor IS NOT NULL
         AND NOT standing.is_removed
       )
  ),
  invalid_missing_parent AS (
    SELECT 1
    FROM resolved child
    WHERE child.parent_category_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM resolved parent
        WHERE parent.month_on = child.month_on
          AND parent.category_id = child.parent_category_id
      )
  ),
  invalid_child_total AS (
    SELECT 1
    FROM resolved parent
    JOIN resolved child
      ON child.month_on = parent.month_on
     AND child.parent_category_id = parent.category_id
    GROUP BY
      parent.month_on,
      parent.category_id,
      parent.amount_minor
    HAVING SUM(child.amount_minor) > parent.amount_minor
  ),
  invalid_income_overlap AS (
    SELECT 1
    FROM resolved plan
    JOIN current_month
      ON current_month.month_on = plan.month_on
    JOIN budget_income_categories income
      ON income.workspace_id = target_workspace_id
    WHERE EXISTS (
      SELECT 1
      FROM spending_category_descendant_ids(
        target_workspace_id,
        income.category_id
      ) income_descendant
      WHERE income_descendant.category_id = plan.category_id
    )
    OR EXISTS (
      SELECT 1
      FROM spending_category_descendant_ids(
        target_workspace_id,
        plan.category_id
      ) budget_descendant
      WHERE budget_descendant.category_id =
        active_spending_category_id(
          target_workspace_id,
          income.category_id
        )
    )
  )
  SELECT NOT EXISTS (
    SELECT 1 FROM invalid_missing_parent
    UNION ALL
    SELECT 1 FROM invalid_child_total
    UNION ALL
    SELECT 1 FROM invalid_income_overlap
  )
$$;

COMMIT;
