BEGIN;

CREATE TABLE recurring_pattern_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  stream_id text NOT NULL UNIQUE,
  source_transaction_id text REFERENCES transactions(id) ON DELETE SET NULL,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  match_field text NOT NULL,
  normalized_match_value text NOT NULL,
  anchor_amount_minor bigint NOT NULL CHECK (anchor_amount_minor > 0),
  currency_code char(3) NOT NULL,
  stream_type text NOT NULL,
  cadence text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurring_pattern_rules_match_field_check
    CHECK (match_field IN ('normalized_merchant', 'normalized_name')),
  CONSTRAINT recurring_pattern_rules_match_value_check
    CHECK (
      normalized_match_value = btrim(normalized_match_value)
      AND normalized_match_value = lower(normalized_match_value)
      AND length(normalized_match_value) BETWEEN 1 AND 160
    ),
  CONSTRAINT recurring_pattern_rules_stream_type_check
    CHECK (stream_type IN ('subscription', 'bill')),
  CONSTRAINT recurring_pattern_rules_cadence_check
    CHECK (
      cadence IN (
        'weekly',
        'biweekly',
        'monthly',
        'quarterly',
        'annual'
      )
    )
);

CREATE INDEX recurring_pattern_rules_workspace_active_idx
  ON recurring_pattern_rules (
    workspace_id,
    active,
    account_id,
    match_field,
    normalized_match_value
  );

COMMENT ON TABLE recurring_pattern_rules IS
  'Admin-declared recurring patterns matched against immutable provider merchant or name fields, account, currency, and the detector amount tolerance.';

COMMIT;
