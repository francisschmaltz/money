BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  base_currency char(3) NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO workspaces (id, name)
VALUES ('shared', 'Shared finances')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL,
  display_name text,
  is_admin boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE workspace_members (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- Compatible with connect-pg-simple, while still usable by a small custom store.
CREATE TABLE user_sessions (
  sid varchar NOT NULL PRIMARY KEY,
  sess json NOT NULL,
  expire timestamptz NOT NULL
);
CREATE INDEX user_sessions_expire_idx ON user_sessions (expire);

CREATE TABLE plaid_items (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_item_id text NOT NULL UNIQUE,
  institution_id text,
  institution_name text,
  transactions_cursor text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'syncing', 'reauth_required', 'error', 'removed')),
  error_code text,
  coverage_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  consent_expires_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plaid_items_workspace_idx ON plaid_items (workspace_id);

-- Deliberately isolated. Finance/search/reporting repositories must never join it.
CREATE TABLE plaid_item_secrets (
  item_id text PRIMARY KEY REFERENCES plaid_items(id) ON DELETE CASCADE,
  access_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE plaid_item_secrets FROM PUBLIC;

CREATE TABLE accounts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
  provider_account_id text NOT NULL UNIQUE,
  institution_name text,
  name text NOT NULL,
  official_name text,
  mask text,
  type text NOT NULL,
  subtype text,
  currency_code char(3) NOT NULL DEFAULT 'USD',
  current_balance_minor bigint,
  available_balance_minor bigint,
  credit_limit_minor bigint,
  is_liability boolean NOT NULL DEFAULT false,
  balance_group_override text
    CHECK (
      balance_group_override IS NULL
      OR balance_group_override IN (
        'cash',
        'taxable_investment',
        'retirement',
        'credit_card',
        'loan',
        'other_asset',
        'other_liability',
        'excluded'
      )
    ),
  active boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounts_workspace_idx ON accounts (workspace_id, active);
CREATE INDEX accounts_item_idx ON accounts (item_id);

CREATE TABLE transactions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_transaction_id text NOT NULL UNIQUE,
  provider_pending_transaction_id text,
  merchant_name text,
  normalized_merchant text,
  name text NOT NULL,
  category_primary text,
  category_detailed text,
  amount_minor bigint NOT NULL,
  currency_code char(3) NOT NULL DEFAULT 'USD',
  authorized_at timestamptz,
  posted_on date NOT NULL,
  pending boolean NOT NULL DEFAULT false,
  excluded_from_spending boolean NOT NULL DEFAULT false,
  original_transaction_id text REFERENCES transactions(id) ON DELETE SET NULL,
  payment_channel text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transactions_workspace_date_idx
  ON transactions (workspace_id, posted_on DESC, id);
CREATE INDEX transactions_account_date_idx
  ON transactions (account_id, posted_on DESC);
CREATE INDEX transactions_category_date_idx
  ON transactions (workspace_id, category_primary, posted_on DESC);
CREATE INDEX transactions_merchant_date_idx
  ON transactions (workspace_id, normalized_merchant, posted_on DESC);
CREATE INDEX transactions_pending_provider_idx
  ON transactions (provider_pending_transaction_id)
  WHERE provider_pending_transaction_id IS NOT NULL;
CREATE INDEX transactions_original_idx
  ON transactions (original_transaction_id)
  WHERE original_transaction_id IS NOT NULL;

CREATE TABLE categorization_overrides (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transaction_id text REFERENCES transactions(id) ON DELETE CASCADE,
  normalized_merchant text,
  category_primary text,
  category_detailed text,
  excluded_from_spending boolean,
  is_fixed boolean,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categorization_override_target
    CHECK (transaction_id IS NOT NULL OR normalized_merchant IS NOT NULL)
);
CREATE INDEX categorization_overrides_workspace_idx
  ON categorization_overrides (workspace_id);

CREATE TABLE securities (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_security_id text NOT NULL UNIQUE,
  name text NOT NULL,
  ticker_symbol text,
  security_type text,
  close_price_minor bigint,
  close_price_as_of date,
  currency_code char(3) NOT NULL DEFAULT 'USD',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE holdings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id text NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  quantity numeric(28, 10) NOT NULL,
  institution_value_minor bigint NOT NULL,
  institution_price_minor bigint,
  cost_basis_minor bigint,
  currency_code char(3) NOT NULL DEFAULT 'USD',
  as_of timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, security_id)
);
CREATE INDEX holdings_workspace_idx ON holdings (workspace_id);

CREATE TABLE investment_transactions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id text REFERENCES securities(id) ON DELETE SET NULL,
  provider_investment_transaction_id text NOT NULL UNIQUE,
  transaction_type text NOT NULL,
  subtype text,
  amount_minor bigint NOT NULL,
  fees_minor bigint NOT NULL DEFAULT 0,
  quantity numeric(28, 10),
  price_minor bigint,
  currency_code char(3) NOT NULL DEFAULT 'USD',
  posted_on date NOT NULL,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX investment_transactions_workspace_date_idx
  ON investment_transactions (workspace_id, posted_on DESC);

CREATE TABLE liabilities (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id text NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  liability_type text NOT NULL,
  minimum_payment_minor bigint,
  last_payment_minor bigint,
  next_payment_due_on date,
  apr_basis_points integer,
  principal_minor bigint,
  currency_code char(3) NOT NULL DEFAULT 'USD',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  as_of timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE daily_account_snapshots (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  snapshot_on date NOT NULL,
  current_balance_minor bigint,
  available_balance_minor bigint,
  currency_code char(3) NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, snapshot_on)
);
CREATE INDEX daily_account_snapshots_workspace_date_idx
  ON daily_account_snapshots (workspace_id, snapshot_on);

CREATE TABLE daily_holding_snapshots (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id text NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  snapshot_on date NOT NULL,
  value_minor bigint NOT NULL,
  quantity numeric(28, 10),
  currency_code char(3) NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, security_id, snapshot_on)
);
CREATE INDEX daily_holding_snapshots_workspace_date_idx
  ON daily_holding_snapshots (workspace_id, snapshot_on);

CREATE TABLE manual_assets (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL
    CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  asset_type text NOT NULL
    CHECK (
      asset_type IN (
        'vehicle',
        'real_estate',
        'business',
        'collectible',
        'other'
      )
    ),
  description text CHECK (
    description IS NULL OR length(description) <= 500
  ),
  currency_code char(3) NOT NULL DEFAULT 'USD',
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX manual_assets_workspace_active_idx
  ON manual_assets (workspace_id, active, name);

CREATE TABLE manual_asset_valuations (
  asset_id text NOT NULL REFERENCES manual_assets(id) ON DELETE CASCADE,
  valued_on date NOT NULL,
  value_minor bigint NOT NULL CHECK (value_minor >= 0),
  currency_code char(3) NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, valued_on)
);
CREATE INDEX manual_asset_valuations_asset_date_idx
  ON manual_asset_valuations (asset_id, valued_on DESC);

CREATE TABLE recurring_streams (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  service_family text NOT NULL,
  display_name text NOT NULL,
  stream_type text NOT NULL CHECK (stream_type IN ('subscription', 'bill')),
  cadence text NOT NULL
    CHECK (cadence IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'annual', 'irregular')),
  account_id text REFERENCES accounts(id) ON DELETE SET NULL,
  expected_amount_minor bigint NOT NULL,
  min_amount_minor bigint NOT NULL,
  max_amount_minor bigint NOT NULL,
  monthly_equivalent_minor bigint NOT NULL,
  currency_code char(3) NOT NULL DEFAULT 'USD',
  first_seen_on date NOT NULL,
  last_seen_on date NOT NULL,
  next_expected_on date,
  confidence_basis_points integer NOT NULL
    CHECK (confidence_basis_points BETWEEN 0 AND 10000),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'canceled', 'resumed', 'irregular', 'dismissed')),
  duplicate_state text NOT NULL DEFAULT 'unknown'
    CHECK (duplicate_state IN ('unknown', 'confirmed', 'not_duplicate')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recurring_streams_workspace_idx
  ON recurring_streams (workspace_id, status);

CREATE TABLE recurring_stream_transactions (
  stream_id text NOT NULL REFERENCES recurring_streams(id) ON DELETE CASCADE,
  transaction_id text NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  PRIMARY KEY (stream_id, transaction_id)
);

CREATE TABLE insight_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  family text NOT NULL CHECK (family IN ('weekly', 'investments', 'subscriptions')),
  rule_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, family, rule_key)
);

CREATE TABLE insight_findings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  family text NOT NULL CHECK (family IN ('weekly', 'investments', 'subscriptions')),
  finding_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'attention', 'important')),
  title text NOT NULL,
  explanation text NOT NULL,
  period_start date,
  period_end date,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  rule jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence_basis_points integer NOT NULL
    CHECK (confidence_basis_points BETWEEN 0 AND 10000),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'dismissed', 'resolved')),
  generated_at timestamptz NOT NULL,
  data_as_of timestamptz NOT NULL,
  UNIQUE (workspace_id, family, id)
);
CREATE INDEX insight_findings_workspace_family_idx
  ON insight_findings (workspace_id, family, generated_at DESC);

CREATE TABLE insight_narratives (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  family text NOT NULL CHECK (family IN ('weekly', 'investments', 'subscriptions')),
  findings_hash text NOT NULL,
  headline text NOT NULL,
  bullets jsonb NOT NULL,
  finding_ids jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, family, findings_hash)
);

CREATE TABLE sync_runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_id text REFERENCES plaid_items(id) ON DELETE SET NULL,
  sync_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX sync_runs_workspace_started_idx
  ON sync_runs (workspace_id, started_at DESC);

CREATE TABLE jobs (
  id text PRIMARY KEY,
  job_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jobs_active_dedupe_idx
  ON jobs (job_type, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status = 'queued';
CREATE INDEX jobs_claim_idx ON jobs (status, run_at, created_at);

CREATE TABLE search_documents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  title text NOT NULL,
  subtitle text,
  search_text text NOT NULL,
  normalized_text text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(search_text, ''))
  ) STORED,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, entity_type, entity_id)
);
CREATE INDEX search_documents_fts_idx
  ON search_documents USING gin (search_vector);
CREATE INDEX search_documents_trgm_idx
  ON search_documents USING gin (normalized_text gin_trgm_ops);
CREATE INDEX search_documents_workspace_type_idx
  ON search_documents (workspace_id, entity_type);

INSERT INTO insight_rules (id, workspace_id, family, rule_key, settings)
VALUES
  ('shared-weekly-spend-less', 'shared', 'weekly', 'spend_less',
   '{"minimum_change_minor":2500,"minimum_change_basis_points":1500}'::jsonb),
  ('shared-weekly-fixed-categories', 'shared', 'weekly', 'fixed_categories',
   '{"categories":["RENT_AND_UTILITIES","LOAN_PAYMENTS","INSURANCE"]}'::jsonb),
  ('shared-investment-concentration', 'shared', 'investments', 'concentration',
   '{"threshold_basis_points":2500}'::jsonb),
  ('shared-subscription-expensive', 'shared', 'subscriptions', 'expensive',
   '{"monthly_threshold_minor":5000}'::jsonb)
ON CONFLICT (workspace_id, family, rule_key) DO NOTHING;

COMMIT;
