BEGIN;

-- Deployments may set `money.runtime_role` for a stricter grant boundary:
--   SET money.runtime_role = 'money_app';
-- The schema owner always retains access for migrations. Reporting roles should
-- receive explicit grants on finance tables and no grant on this table.
COMMENT ON TABLE plaid_item_secrets IS
  'Service-only Plaid access tokens. Never join from analytics, search, MCP, or admin repositories.';
COMMENT ON COLUMN plaid_item_secrets.access_token IS
  'Plaintext v1 runtime credential supplied by Plaid; redact from all logs and responses.';

REVOKE ALL ON TABLE plaid_item_secrets FROM PUBLIC;

COMMIT;
