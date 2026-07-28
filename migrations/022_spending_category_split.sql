BEGIN;

ALTER TABLE spending_category_events
  DROP CONSTRAINT spending_category_events_event_type_check;

ALTER TABLE spending_category_events
  ADD CONSTRAINT spending_category_events_event_type_check
  CHECK (
    event_type IN (
      'create',
      'rename',
      'reclassify',
      'merge',
      'split'
    )
  );

COMMIT;
