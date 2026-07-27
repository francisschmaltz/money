BEGIN;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS balance_group_override text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'accounts_balance_group_override_check'
      AND conrelid = 'accounts'::regclass
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_balance_group_override_check
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
      );
  END IF;
END
$$;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS original_transaction_id text
    REFERENCES transactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS transactions_original_idx
  ON transactions (original_transaction_id)
  WHERE original_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS manual_assets (
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

CREATE INDEX IF NOT EXISTS manual_assets_workspace_active_idx
  ON manual_assets (workspace_id, active, name);

ALTER TABLE manual_assets
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE TABLE IF NOT EXISTS manual_asset_valuations (
  asset_id text NOT NULL REFERENCES manual_assets(id) ON DELETE CASCADE,
  valued_on date NOT NULL,
  value_minor bigint NOT NULL CHECK (value_minor >= 0),
  currency_code char(3) NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, valued_on)
);

CREATE INDEX IF NOT EXISTS manual_asset_valuations_asset_date_idx
  ON manual_asset_valuations (asset_id, valued_on DESC);

COMMIT;
