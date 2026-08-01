BEGIN;

CREATE TABLE insight_settings (
  workspace_id text PRIMARY KEY
    REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE insight_settings IS
  'Workspace-level manual control for scheduled and on-demand insight generation.';

COMMIT;
