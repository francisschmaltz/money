BEGIN;

ALTER TABLE transactions
  ADD COLUMN goal_spend_version integer NOT NULL DEFAULT 0
  CHECK (goal_spend_version >= 0);

CREATE TABLE goal_transaction_spends (
  id text PRIMARY KEY,
  workspace_id text NOT NULL
    REFERENCES workspaces(id) ON DELETE CASCADE,
  transaction_id text
    REFERENCES transactions(id) ON DELETE SET NULL,
  transaction_provider_id text NOT NULL,
  goal_id text NOT NULL
    REFERENCES finance_goals(id) ON DELETE CASCADE,
  source text NOT NULL
    CHECK (source IN ('cash', 'brokerage')),
  line_index smallint NOT NULL
    CHECK (line_index BETWEEN 0 AND 49),
  amount_minor bigint NOT NULL
    CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'reversed', 'invalidated')),
  ended_reason text,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CONSTRAINT goal_transaction_spend_status_shape CHECK (
    (
      status = 'active'
      AND transaction_id IS NOT NULL
      AND ended_at IS NULL
      AND ended_reason IS NULL
    )
    OR (
      status <> 'active'
      AND ended_at IS NOT NULL
      AND ended_reason IS NOT NULL
    )
  )
);

CREATE INDEX goal_transaction_spends_active_line_idx
  ON goal_transaction_spends (
    workspace_id,
    transaction_id,
    line_index
  )
  WHERE status = 'active';

CREATE UNIQUE INDEX goal_transaction_spends_active_goal_source_idx
  ON goal_transaction_spends (
    workspace_id,
    transaction_id,
    goal_id,
    source
  )
  WHERE status = 'active';

CREATE INDEX goal_transaction_spends_goal_status_idx
  ON goal_transaction_spends (
    workspace_id,
    goal_id,
    status,
    created_at,
    id
  );

CREATE INDEX goal_transaction_spends_transaction_history_idx
  ON goal_transaction_spends (
    workspace_id,
    transaction_provider_id,
    created_at,
    id
  );

CREATE OR REPLACE FUNCTION invalidate_goal_transaction_spends()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_goal_ids text[];
  spend_before jsonb;
  invalidation_reason text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NOT (
      OLD.amount_minor IS DISTINCT FROM NEW.amount_minor
      OR OLD.currency_code IS DISTINCT FROM NEW.currency_code
      OR OLD.pending IS DISTINCT FROM NEW.pending
      OR OLD.excluded_from_spending IS DISTINCT FROM NEW.excluded_from_spending
    ) THEN
      RETURN NEW;
    END IF;
    NEW.goal_spend_version := OLD.goal_spend_version + 1;
    invalidation_reason := 'provider_parent_changed';
  ELSE
    invalidation_reason := 'provider_transaction_deleted';
  END IF;

  SELECT
    array_agg(DISTINCT spend.goal_id ORDER BY spend.goal_id),
    jsonb_agg(
      jsonb_build_object(
        'id', spend.id,
        'goal_id', spend.goal_id,
        'source', spend.source,
        'line_index', spend.line_index,
        'amount_minor', spend.amount_minor
      )
      ORDER BY spend.line_index, spend.id
    )
  INTO affected_goal_ids, spend_before
  FROM goal_transaction_spends spend
  WHERE spend.workspace_id = OLD.workspace_id
    AND spend.transaction_id = OLD.id
    AND spend.status = 'active';

  IF affected_goal_ids IS NULL THEN
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
      'goal-spend-invalidated:'
      || OLD.id
      || clock_timestamp()::text
      || random()::text
    ),
    OLD.workspace_id,
    'transaction.goal_spends_invalidated',
    'transaction',
    OLD.id,
    'worker',
    'database_guard',
    jsonb_build_object(
      'parent',
      jsonb_build_object(
        'provider_transaction_id', OLD.provider_transaction_id,
        'amount_minor', OLD.amount_minor,
        'currency_code', OLD.currency_code,
        'pending', OLD.pending,
        'excluded_from_spending', OLD.excluded_from_spending,
        'goal_spend_version', OLD.goal_spend_version
      ),
      'goal_spends',
      spend_before
    ),
    CASE
      WHEN TG_OP = 'DELETE' THEN
        jsonb_build_object(
          'parent', NULL,
          'goal_spends', '[]'::jsonb,
          'reason', invalidation_reason
        )
      ELSE
        jsonb_build_object(
          'parent',
          jsonb_build_object(
            'provider_transaction_id', NEW.provider_transaction_id,
            'amount_minor', NEW.amount_minor,
            'currency_code', NEW.currency_code,
            'pending', NEW.pending,
            'excluded_from_spending', NEW.excluded_from_spending,
            'goal_spend_version', NEW.goal_spend_version
          ),
          'goal_spends', '[]'::jsonb,
          'reason', invalidation_reason
        )
    END
  );

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
      'goal-reactivated:'
      || goal.id
      || OLD.id
      || clock_timestamp()::text
      || random()::text
    ),
    goal.workspace_id,
    'goal.reactivated_after_spend_invalidation',
    'goal',
    goal.id,
    'worker',
    'database_guard',
    jsonb_build_object(
      'status', goal.status,
      'version', goal.version,
      'archived_at', goal.archived_at,
      'archive_outcome', to_jsonb(goal) -> 'archive_outcome'
    ),
    jsonb_build_object(
      'status', 'active',
      'version', goal.version + 1,
      'archived_at', NULL,
      'archive_outcome', NULL
    )
  FROM finance_goals goal
  WHERE goal.workspace_id = OLD.workspace_id
    AND goal.id = ANY(affected_goal_ids)
    AND goal.status = 'archived';

  UPDATE finance_goals goal
  SET
    status = 'active',
    archived_at = NULL,
    updated_by = 'database_guard',
    updated_at = now(),
    version = goal.version + 1
  WHERE goal.workspace_id = OLD.workspace_id
    AND goal.id = ANY(affected_goal_ids);

  UPDATE goal_transaction_spends spend
  SET
    status = 'invalidated',
    ended_reason = invalidation_reason,
    updated_by = 'database_guard',
    updated_at = now(),
    ended_at = now()
  WHERE spend.workspace_id = OLD.workspace_id
    AND spend.transaction_id = OLD.id
    AND spend.status = 'active';

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER b_guard_goal_transaction_spend_parent_change
BEFORE DELETE OR UPDATE OF
  amount_minor,
  currency_code,
  pending,
  excluded_from_spending
ON transactions
FOR EACH ROW
EXECUTE FUNCTION invalidate_goal_transaction_spends();

COMMIT;
