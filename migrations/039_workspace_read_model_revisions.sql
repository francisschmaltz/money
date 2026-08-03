BEGIN;

CREATE TABLE workspace_read_model_revisions (
  workspace_id text PRIMARY KEY
    REFERENCES workspaces(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1
    CHECK (revision >= 1),
  clock_token text NOT NULL DEFAULT ''
    CHECK (char_length(clock_token) <= 128),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_read_model_active_syncs (
  workspace_id text NOT NULL
    REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id text NOT NULL
    REFERENCES finance_connections(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, connection_id)
);

INSERT INTO workspace_read_model_revisions (workspace_id)
SELECT id
FROM workspaces
ON CONFLICT (workspace_id) DO NOTHING;

COMMENT ON TABLE workspace_read_model_revisions IS
  'Durable workspace generation used to validate cached read models.';
COMMENT ON COLUMN workspace_read_model_revisions.revision IS
  'Monotonically increasing generation advanced after read-model inputs change.';
COMMENT ON COLUMN workspace_read_model_revisions.clock_token IS
  'Last UTC and workspace-local date token published for rollover-safe models.';
COMMENT ON TABLE workspace_read_model_active_syncs IS
  'Durable per-connection fences that make Redis ineligible during multi-commit syncs.';

COMMIT;
