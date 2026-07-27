BEGIN;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL
  DEFAULT 'America/Los_Angeles';

CREATE TABLE finance_goals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  target_amount_minor bigint NOT NULL
    CHECK (target_amount_minor > 0),
  currency_code char(3) NOT NULL DEFAULT 'USD'
    CHECK (currency_code = 'USD'),
  target_on date,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text,
  updated_by text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finance_goals_workspace_status_idx
  ON finance_goals (workspace_id, status, created_at);

CREATE TABLE goal_allocation_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  goal_id text NOT NULL REFERENCES finance_goals(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('cash', 'brokerage')),
  amount_delta_minor bigint NOT NULL CHECK (amount_delta_minor <> 0),
  idempotency_key text,
  actor_type text NOT NULL CHECK (actor_type IN ('member', 'openwebui', 'worker')),
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX goal_allocation_events_idempotency_idx
  ON goal_allocation_events (
    workspace_id,
    actor_type,
    actor_id,
    idempotency_key
  )
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX goal_allocation_events_goal_time_idx
  ON goal_allocation_events (goal_id, created_at, id);

CREATE TABLE goal_funding_schedules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  goal_id text NOT NULL REFERENCES finance_goals(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('cash', 'brokerage')),
  cadence text NOT NULL
    CHECK (cadence IN ('monthly', 'biweekly_friday')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  monthly_day smallint CHECK (monthly_day BETWEEN 1 AND 31),
  anchor_on date,
  next_run_on date NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goal_funding_schedule_shape CHECK (
    (
      cadence = 'monthly'
      AND monthly_day IS NOT NULL
      AND anchor_on IS NULL
    )
    OR (
      cadence = 'biweekly_friday'
      AND monthly_day IS NULL
      AND anchor_on IS NOT NULL
    )
  )
);
CREATE INDEX goal_funding_schedules_due_idx
  ON goal_funding_schedules (status, next_run_on, workspace_id);

CREATE TABLE goal_schedule_runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  schedule_id text NOT NULL
    REFERENCES goal_funding_schedules(id) ON DELETE CASCADE,
  due_on date NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'applied',
      'skipped_goal_complete',
      'skipped_brokerage_capacity',
      'skipped_inactive_goal'
    )
  ),
  allocation_event_id text
    REFERENCES goal_allocation_events(id) ON DELETE SET NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, due_on)
);
CREATE INDEX goal_schedule_runs_workspace_time_idx
  ON goal_schedule_runs (workspace_id, created_at DESC);

CREATE TABLE budget_months (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  month_on date NOT NULL CHECK (extract(day FROM month_on) = 1),
  copied_from_month_on date,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, month_on)
);

CREATE TABLE budget_lines (
  workspace_id text NOT NULL,
  month_on date NOT NULL,
  category text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency_code char(3) NOT NULL DEFAULT 'USD'
    CHECK (currency_code = 'USD'),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, month_on, category),
  FOREIGN KEY (workspace_id, month_on)
    REFERENCES budget_months(workspace_id, month_on)
    ON DELETE CASCADE
);

CREATE TABLE budget_default_revisions (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category text NOT NULL,
  effective_month_on date NOT NULL
    CHECK (extract(day FROM effective_month_on) = 1),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency_code char(3) NOT NULL DEFAULT 'USD'
    CHECK (currency_code = 'USD'),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, category, effective_month_on)
);
CREATE INDEX budget_default_revisions_resolve_idx
  ON budget_default_revisions (
    workspace_id,
    effective_month_on DESC,
    category
  );

CREATE TABLE transaction_splits (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transaction_id text NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  line_index smallint NOT NULL CHECK (line_index BETWEEN 0 AND 49),
  category text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, line_index)
);
CREATE INDEX transaction_splits_workspace_transaction_idx
  ON transaction_splits (workspace_id, transaction_id, line_index);

CREATE TABLE plan_audit_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('member', 'openwebui', 'worker')),
  actor_id text,
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plan_audit_events_workspace_time_idx
  ON plan_audit_events (workspace_id, created_at DESC, id DESC);

CREATE TABLE plan_idempotency_keys (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('member', 'openwebui', 'worker')),
  actor_id text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (
    workspace_id,
    actor_type,
    actor_id,
    operation,
    idempotency_key
  )
);
CREATE INDEX plan_idempotency_keys_created_idx
  ON plan_idempotency_keys (workspace_id, created_at);

COMMIT;
