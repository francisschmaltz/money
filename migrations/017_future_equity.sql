BEGIN;

ALTER TABLE holdings
  ADD COLUMN IF NOT EXISTS vested_quantity numeric(28, 10),
  ADD COLUMN IF NOT EXISTS vested_value_minor bigint;

ALTER TABLE daily_holding_snapshots
  ADD COLUMN IF NOT EXISTS institution_price_minor bigint,
  ADD COLUMN IF NOT EXISTS vested_quantity numeric(28, 10),
  ADD COLUMN IF NOT EXISTS vested_value_minor bigint;

COMMIT;
