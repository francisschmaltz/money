BEGIN;

ALTER TABLE insight_findings
  ADD COLUMN IF NOT EXISTS finding_key text,
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS state_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS state_changed_by text REFERENCES users(id) ON DELETE SET NULL;

UPDATE insight_findings
SET finding_key = id
WHERE finding_key IS NULL;

ALTER TABLE insight_findings
  ALTER COLUMN finding_key SET NOT NULL;

ALTER TABLE insight_findings
  DROP CONSTRAINT IF EXISTS insight_findings_state_check;

ALTER TABLE insight_findings
  ADD CONSTRAINT insight_findings_state_check
  CHECK (
    state IN (
      'active',
      'archived',
      'bad',
      'dismissed',
      'resolved'
    )
  );

CREATE INDEX IF NOT EXISTS insight_findings_workspace_current_idx
  ON insight_findings (workspace_id, family, generated_at DESC)
  WHERE is_current = true AND state = 'active';

CREATE INDEX IF NOT EXISTS insight_findings_workspace_archive_idx
  ON insight_findings (workspace_id, generated_at DESC, id)
  WHERE is_current = false OR state <> 'active';

CREATE INDEX IF NOT EXISTS insight_findings_workspace_key_idx
  ON insight_findings (workspace_id, finding_key, generated_at DESC);

CREATE TABLE IF NOT EXISTS insight_finding_preferences (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  finding_key text NOT NULL,
  disposition text NOT NULL
    CHECK (disposition IN ('bad', 'dismissed', 'resolved')),
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, finding_key)
);

CREATE INDEX IF NOT EXISTS insight_finding_preferences_recent_idx
  ON insight_finding_preferences (workspace_id, updated_at DESC);

-- Deliberately no foreign key to insight_findings. Delete is a hard delete, but
-- this small audit record must retain the finding fingerprint and action.
CREATE TABLE IF NOT EXISTS insight_finding_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  finding_id text NOT NULL,
  finding_key text NOT NULL,
  family text NOT NULL
    CHECK (family IN ('weekly', 'investments', 'subscriptions')),
  finding_type text NOT NULL,
  action text NOT NULL
    CHECK (
      action IN (
        'archive',
        'mark_bad',
        'restore',
        'delete',
        'dismiss',
        'mark_expected',
        'confirm'
      )
    ),
  from_state text NOT NULL,
  to_state text,
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS insight_finding_events_workspace_recent_idx
  ON insight_finding_events (workspace_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS insight_finding_events_workspace_key_idx
  ON insight_finding_events (workspace_id, finding_key, created_at DESC);

INSERT INTO insight_finding_preferences (
  workspace_id,
  finding_key,
  disposition,
  updated_at
)
SELECT DISTINCT ON (workspace_id, finding_key)
  workspace_id,
  finding_key,
  state,
  COALESCE(state_changed_at, generated_at)
FROM insight_findings
WHERE state IN ('dismissed', 'resolved')
ORDER BY
  workspace_id,
  finding_key,
  COALESCE(state_changed_at, generated_at) DESC
ON CONFLICT (workspace_id, finding_key) DO NOTHING;

COMMIT;
