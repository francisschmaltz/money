BEGIN;

WITH invalid_schedules AS MATERIALIZED (
  SELECT
    schedule.*,
    (
      5 - EXTRACT(ISODOW FROM schedule.anchor_on)::integer + 7
    ) % 7 AS friday_shift
  FROM goal_funding_schedules schedule
  WHERE schedule.cadence = 'biweekly_friday'
    AND EXTRACT(ISODOW FROM schedule.anchor_on) <> 5
),
audited AS (
  INSERT INTO plan_audit_events (
    id,
    workspace_id,
    event_type,
    subject_type,
    subject_id,
    actor_type,
    actor_id,
    before_value,
    after_value
  )
  SELECT
    'audit_' || md5(
      invalid.id || clock_timestamp()::text || random()::text
    ),
    invalid.workspace_id,
    'goal.schedule_anchor_repaired',
    'goal_schedule',
    invalid.id,
    'worker',
    'planning_integrity_migration',
    jsonb_build_object(
      'anchor_on', invalid.anchor_on,
      'next_run_on', invalid.next_run_on,
      'status', invalid.status,
      'version', invalid.version
    ),
    jsonb_build_object(
      'anchor_on', invalid.anchor_on + invalid.friday_shift,
      'next_run_on', invalid.next_run_on + invalid.friday_shift,
      'status', 'paused',
      'version', invalid.version + 1
    )
  FROM invalid_schedules invalid
  RETURNING subject_id
)
UPDATE goal_funding_schedules schedule
SET anchor_on = invalid.anchor_on + invalid.friday_shift,
    next_run_on = invalid.next_run_on + invalid.friday_shift,
    status = 'paused',
    version = invalid.version + 1,
    updated_at = now()
FROM invalid_schedules invalid
WHERE schedule.id = invalid.id
  AND (
    EXISTS (
      SELECT 1
      FROM audited
      WHERE audited.subject_id = invalid.id
    )
  );

ALTER TABLE goal_funding_schedules
  ADD CONSTRAINT goal_funding_schedules_friday_anchor
  CHECK (
    cadence <> 'biweekly_friday'
    OR EXTRACT(ISODOW FROM anchor_on) = 5
  )
  NOT VALID;

ALTER TABLE goal_funding_schedules
  VALIDATE CONSTRAINT goal_funding_schedules_friday_anchor;

CREATE INDEX transaction_splits_workspace_category_idx
  ON transaction_splits (workspace_id, category, transaction_id);

WITH invalid_parents AS MATERIALIZED (
  SELECT
    parent.workspace_id,
    parent.id AS transaction_id,
    parent.amount_minor,
    parent.currency_code,
    parent.pending,
    jsonb_agg(
      jsonb_build_object(
        'id', split.id,
        'line_index', split.line_index,
        'category', split.category,
        'amount_minor', split.amount_minor,
        'note', split.note
      )
      ORDER BY split.line_index
    ) AS splits
  FROM transactions parent
  JOIN transaction_splits split
    ON split.workspace_id = parent.workspace_id
   AND split.transaction_id = parent.id
  GROUP BY
    parent.workspace_id,
    parent.id,
    parent.amount_minor,
    parent.currency_code,
    parent.pending
  HAVING
    COUNT(*) < 2
    OR parent.amount_minor = 0
    OR SUM(split.amount_minor) <> parent.amount_minor
    OR BOOL_OR(
      SIGN(split.amount_minor) <> SIGN(parent.amount_minor)
    )
    OR parent.pending
    OR parent.currency_code <> 'USD'
),
audited AS (
  INSERT INTO plan_audit_events (
    id,
    workspace_id,
    event_type,
    subject_type,
    subject_id,
    actor_type,
    actor_id,
    before_value,
    after_value
  )
  SELECT
    'audit_' || md5(
      invalid.transaction_id
      || clock_timestamp()::text
      || random()::text
    ),
    invalid.workspace_id,
    'transaction.splits_invalidated',
    'transaction',
    invalid.transaction_id,
    'worker',
    'database_guard',
    jsonb_build_object(
      'parent',
      jsonb_build_object(
        'amount_minor', invalid.amount_minor,
        'currency_code', invalid.currency_code,
        'pending', invalid.pending
      ),
      'splits',
      invalid.splits
    ),
    jsonb_build_object('splits', '[]'::jsonb)
  FROM invalid_parents invalid
  RETURNING workspace_id, subject_id
)
DELETE FROM transaction_splits split
USING audited
WHERE split.workspace_id = audited.workspace_id
  AND split.transaction_id = audited.subject_id;

CREATE OR REPLACE FUNCTION guard_transaction_split_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  should_clear boolean;
  split_before jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    should_clear := true;
  ELSE
    should_clear :=
      OLD.amount_minor IS DISTINCT FROM NEW.amount_minor
      OR OLD.currency_code IS DISTINCT FROM NEW.currency_code
      OR OLD.pending IS DISTINCT FROM NEW.pending
      OR NEW.amount_minor = 0
      OR NEW.currency_code <> 'USD'
      OR NEW.pending;
  END IF;

  IF NOT should_clear THEN
    RETURN NEW;
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', split.id,
      'line_index', split.line_index,
      'category', split.category,
      'amount_minor', split.amount_minor,
      'note', split.note
    )
    ORDER BY split.line_index
  )
  INTO split_before
  FROM transaction_splits split
  WHERE split.workspace_id = OLD.workspace_id
    AND split.transaction_id = OLD.id;

  IF split_before IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO plan_audit_events (
    id,
    workspace_id,
    event_type,
    subject_type,
    subject_id,
    actor_type,
    actor_id,
    before_value,
    after_value
  )
  VALUES (
    'audit_' || md5(
      OLD.id || clock_timestamp()::text || random()::text
    ),
    OLD.workspace_id,
    'transaction.splits_invalidated',
    'transaction',
    OLD.id,
    'worker',
    'database_guard',
    jsonb_build_object(
      'parent',
      jsonb_build_object(
        'amount_minor', OLD.amount_minor,
        'currency_code', OLD.currency_code,
        'pending', OLD.pending
      ),
      'splits',
      split_before
    ),
    CASE
      WHEN TG_OP = 'DELETE' THEN NULL
      ELSE jsonb_build_object(
        'parent',
        jsonb_build_object(
          'amount_minor', NEW.amount_minor,
          'currency_code', NEW.currency_code,
          'pending', NEW.pending
        ),
        'splits',
        '[]'::jsonb
      )
    END
  );

  DELETE FROM transaction_splits
  WHERE workspace_id = OLD.workspace_id
    AND transaction_id = OLD.id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_transaction_split_parent_change
BEFORE DELETE OR UPDATE OF amount_minor, currency_code, pending
ON transactions
FOR EACH ROW
EXECUTE FUNCTION guard_transaction_split_parent();

COMMIT;
