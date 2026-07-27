BEGIN;

ALTER TABLE finance_goals
  ADD COLUMN purpose text NOT NULL DEFAULT 'other',
  ADD COLUMN archive_outcome text;

ALTER TABLE finance_goals
  ADD CONSTRAINT finance_goals_purpose_check CHECK (
    purpose IN (
      'vacation',
      'home',
      'vehicle',
      'education',
      'emergency',
      'event',
      'purchase',
      'other'
    )
  ),
  ADD CONSTRAINT finance_goals_archive_outcome_check CHECK (
    archive_outcome IS NULL
    OR archive_outcome IN ('completed', 'cancelled')
  );

UPDATE finance_goals
SET
  archived_at = NULL,
  archive_outcome = NULL
WHERE status = 'active';

UPDATE finance_goals
SET
  archived_at = COALESCE(archived_at, updated_at, created_at, now()),
  archive_outcome = 'completed'
WHERE status = 'archived';

ALTER TABLE finance_goals
  ADD CONSTRAINT finance_goals_archive_lifecycle_check CHECK (
    (
      status = 'active'
      AND archived_at IS NULL
      AND archive_outcome IS NULL
    )
    OR (
      status = 'archived'
      AND archived_at IS NOT NULL
      AND archive_outcome IS NOT NULL
    )
  );

CREATE INDEX finance_goals_workspace_history_idx
  ON finance_goals (
    workspace_id,
    purpose,
    archived_at DESC,
    id
  )
  WHERE status = 'archived';

CREATE OR REPLACE FUNCTION normalize_finance_goal_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'active' THEN
    NEW.archived_at := NULL;
    NEW.archive_outcome := NULL;
  ELSE
    NEW.archived_at := COALESCE(
      NEW.archived_at,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.archived_at END,
      now()
    );
    NEW.archive_outcome := COALESCE(
      NEW.archive_outcome,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.archive_outcome END,
      'completed'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER normalize_finance_goal_lifecycle
BEFORE INSERT OR UPDATE ON finance_goals
FOR EACH ROW
EXECUTE FUNCTION normalize_finance_goal_lifecycle();

COMMIT;
