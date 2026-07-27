BEGIN;

CREATE TABLE finance_connections (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL
    CHECK (provider IN ('plaid', 'apple_card')),
  ingestion_method text NOT NULL
    CHECK (ingestion_method IN ('plaid', 'csv', 'financekit')),
  freshness_mode text NOT NULL
    CHECK (freshness_mode IN ('automatic', 'manual')),
  institution_name text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'syncing', 'reauth_required', 'error', 'removed')),
  error_code text,
  last_synced_at timestamptz,
  imported_through_on date,
  balance_as_of date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO finance_connections (
  id,
  workspace_id,
  provider,
  ingestion_method,
  freshness_mode,
  institution_name,
  status,
  error_code,
  last_synced_at,
  created_at,
  updated_at
)
SELECT
  id,
  workspace_id,
  'plaid',
  'plaid',
  'automatic',
  institution_name,
  status,
  error_code,
  last_synced_at,
  created_at,
  updated_at
FROM plaid_items;

CREATE INDEX finance_connections_workspace_idx
  ON finance_connections (workspace_id, status);
CREATE UNIQUE INDEX finance_connections_one_active_apple_card_idx
  ON finance_connections (workspace_id, provider)
  WHERE provider = 'apple_card' AND status <> 'removed';

ALTER TABLE accounts
  DROP CONSTRAINT accounts_item_id_fkey;
ALTER TABLE sync_runs
  DROP CONSTRAINT sync_runs_item_id_fkey;
ALTER TABLE plaid_item_secrets
  DROP CONSTRAINT plaid_item_secrets_item_id_fkey;

DROP INDEX plaid_items_workspace_idx;
ALTER TABLE plaid_items RENAME TO plaid_connection_details;
ALTER TABLE plaid_connection_details RENAME COLUMN id TO connection_id;
ALTER TABLE accounts RENAME COLUMN item_id TO connection_id;
ALTER TABLE sync_runs RENAME COLUMN item_id TO connection_id;
ALTER TABLE plaid_item_secrets RENAME COLUMN item_id TO connection_id;
ALTER INDEX accounts_item_idx RENAME TO accounts_connection_idx;

ALTER TABLE plaid_connection_details
  DROP COLUMN workspace_id,
  DROP COLUMN institution_name,
  DROP COLUMN status,
  DROP COLUMN error_code,
  DROP COLUMN last_synced_at,
  DROP COLUMN created_at,
  DROP COLUMN updated_at,
  ADD CONSTRAINT plaid_connection_details_connection_fkey
    FOREIGN KEY (connection_id)
    REFERENCES finance_connections(id)
    ON DELETE CASCADE;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_connection_id_fkey
    FOREIGN KEY (connection_id)
    REFERENCES finance_connections(id)
    ON DELETE CASCADE;
ALTER TABLE sync_runs
  ADD CONSTRAINT sync_runs_connection_id_fkey
    FOREIGN KEY (connection_id)
    REFERENCES finance_connections(id)
    ON DELETE SET NULL;
ALTER TABLE plaid_item_secrets
  ADD CONSTRAINT plaid_item_secrets_connection_id_fkey
    FOREIGN KEY (connection_id)
    REFERENCES plaid_connection_details(connection_id)
    ON DELETE CASCADE;

ALTER TABLE transactions
  ADD COLUMN authorized_on date,
  ADD COLUMN cardholder_name text,
  ADD COLUMN source_transaction_type text;

CREATE TABLE apple_card_imports (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES finance_connections(id) ON DELETE CASCADE,
  file_digest char(64) NOT NULL,
  posted_start_on date,
  posted_end_on date,
  total_row_count integer NOT NULL,
  accepted_row_count integer NOT NULL,
  new_row_count integer NOT NULL,
  existing_row_count integer NOT NULL,
  rejected_row_count integer NOT NULL,
  warning_count integer NOT NULL,
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT apple_card_imports_counts_check CHECK (
    total_row_count >= 0
    AND accepted_row_count >= 0
    AND new_row_count >= 0
    AND existing_row_count >= 0
    AND rejected_row_count >= 0
    AND warning_count >= 0
  )
);
CREATE INDEX apple_card_imports_connection_time_idx
  ON apple_card_imports (connection_id, imported_at DESC);
CREATE INDEX apple_card_imports_connection_digest_idx
  ON apple_card_imports (connection_id, file_digest);

COMMENT ON TABLE apple_card_imports IS
  'Audit metadata for Apple Card CSV imports. Raw files and row contents are never stored here.';
COMMENT ON COLUMN transactions.authorized_on IS
  'Provider transaction date preserved as a date-only value.';
COMMENT ON COLUMN finance_connections.imported_through_on IS
  'Latest posted date covered by a manual import.';

COMMIT;
