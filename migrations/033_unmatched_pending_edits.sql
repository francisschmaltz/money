BEGIN;

CREATE TABLE unmatched_pending_transaction_edits (
  id text PRIMARY KEY,
  workspace_id text NOT NULL
    REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id text NOT NULL
    REFERENCES accounts(id) ON DELETE CASCADE,
  pending_transaction_id text NOT NULL,
  provider_pending_transaction_id text NOT NULL,
  user_state jsonb NOT NULL,
  provider_facts jsonb NOT NULL,
  pending_created_at timestamptz NOT NULL,
  pending_updated_at timestamptz NOT NULL,
  recovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  attached_transaction_id text,
  attached_at timestamptz,
  attached_by text REFERENCES users(id) ON DELETE SET NULL,
  dismissed_at timestamptz,
  dismissed_by text REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT unmatched_pending_edits_pending_id_check
    CHECK (
      pending_transaction_id = btrim(pending_transaction_id)
      AND length(pending_transaction_id) BETWEEN 1 AND 512
    ),
  CONSTRAINT unmatched_pending_edits_provider_id_check
    CHECK (
      provider_pending_transaction_id =
        btrim(provider_pending_transaction_id)
      AND length(provider_pending_transaction_id) BETWEEN 1 AND 512
    ),
  CONSTRAINT unmatched_pending_edits_user_state_check
    CHECK (
      jsonb_typeof(user_state) = 'object'
      AND user_state <> '{}'::jsonb
    ),
  CONSTRAINT unmatched_pending_edits_provider_facts_check
    CHECK (
      jsonb_typeof(provider_facts) = 'object'
      AND provider_facts <> '{}'::jsonb
    ),
  CONSTRAINT unmatched_pending_edits_source_time_check
    CHECK (pending_updated_at >= pending_created_at),
  CONSTRAINT unmatched_pending_edits_recovery_time_check
    CHECK (
      recovered_at >= pending_created_at
      AND updated_at >= recovered_at
    ),
  CONSTRAINT unmatched_pending_edits_attached_id_check
    CHECK (
      attached_transaction_id IS NULL
      OR (
        attached_transaction_id = btrim(attached_transaction_id)
        AND length(attached_transaction_id) BETWEEN 1 AND 512
      )
    ),
  CONSTRAINT unmatched_pending_edits_resolution_check
    CHECK (
      (
        attached_transaction_id IS NULL
        AND attached_at IS NULL
        AND dismissed_at IS NULL
      )
      OR (
        attached_transaction_id IS NOT NULL
        AND attached_at IS NOT NULL
        AND dismissed_at IS NULL
      )
      OR (
        attached_transaction_id IS NULL
        AND attached_at IS NULL
        AND dismissed_at IS NOT NULL
      )
    ),
  CONSTRAINT unmatched_pending_edits_resolution_actor_check
    CHECK (
      (attached_by IS NULL OR attached_at IS NOT NULL)
      AND (dismissed_by IS NULL OR dismissed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX unmatched_pending_edits_provider_unique
  ON unmatched_pending_transaction_edits (
    workspace_id,
    provider_pending_transaction_id
  );

CREATE UNIQUE INDEX unmatched_pending_edits_source_unique
  ON unmatched_pending_transaction_edits (
    workspace_id,
    pending_transaction_id
  );

CREATE INDEX unmatched_pending_edits_workspace_open_idx
  ON unmatched_pending_transaction_edits (
    workspace_id,
    recovered_at DESC,
    id
  )
  WHERE attached_at IS NULL
    AND dismissed_at IS NULL;

CREATE INDEX unmatched_pending_edits_attached_idx
  ON unmatched_pending_transaction_edits (
    workspace_id,
    attached_transaction_id
  )
  WHERE attached_transaction_id IS NOT NULL;

COMMENT ON TABLE unmatched_pending_transaction_edits IS
  'User edits retained when a provider removes a pending transaction without an authoritative posted replacement link.';
COMMENT ON COLUMN unmatched_pending_transaction_edits.pending_transaction_id IS
  'Durable local identity of the deleted pending row; intentionally not a foreign key.';
COMMENT ON COLUMN unmatched_pending_transaction_edits.provider_pending_transaction_id IS
  'Provider transaction ID that identified the pending charge.';
COMMENT ON COLUMN unmatched_pending_transaction_edits.user_state IS
  'Complete user-authored state needed to attach the edits without guessing.';
COMMENT ON COLUMN unmatched_pending_transaction_edits.provider_facts IS
  'Immutable provider facts captured before the pending transaction is removed.';
COMMENT ON COLUMN unmatched_pending_transaction_edits.attached_transaction_id IS
  'Durable identity of the selected posted transaction; intentionally survives later provider removal.';

COMMIT;
