BEGIN;

ALTER TABLE transactions
  ADD COLUMN provider_location jsonb;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_provider_location_object_check
  CHECK (
    provider_location IS NULL
    OR jsonb_typeof(provider_location) = 'object'
  );

UPDATE plaid_connection_details AS details
SET transactions_cursor = NULL
FROM finance_connections AS connection
WHERE connection.id = details.connection_id
  AND connection.provider = 'plaid'
  AND connection.ingestion_method = 'plaid'
  AND connection.status = 'active'
  AND details.transactions_cursor IS NOT NULL;

COMMIT;
