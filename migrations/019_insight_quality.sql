BEGIN;

ALTER TABLE recurring_streams
  DROP CONSTRAINT IF EXISTS recurring_streams_stream_type_check;

ALTER TABLE recurring_streams
  ADD CONSTRAINT recurring_streams_stream_type_check
  CHECK (
    stream_type IN ('subscription', 'bill', 'frequent_spending')
  );

ALTER TABLE recurring_streams
  ADD COLUMN IF NOT EXISTS stream_type_override text,
  ADD COLUMN IF NOT EXISTS classification_signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS override_source_finding_id text,
  ADD COLUMN IF NOT EXISTS override_updated_by text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS override_updated_at timestamptz;

ALTER TABLE recurring_streams
  DROP CONSTRAINT IF EXISTS recurring_streams_stream_type_override_check;

ALTER TABLE recurring_streams
  ADD CONSTRAINT recurring_streams_stream_type_override_check
  CHECK (
    stream_type_override IS NULL
    OR stream_type_override IN (
      'subscription',
      'bill',
      'frequent_spending'
    )
  );

ALTER TABLE insight_finding_preferences
  ADD COLUMN IF NOT EXISTS reason_code text;

ALTER TABLE insight_finding_events
  ADD COLUMN IF NOT EXISTS reason_code text;

ALTER TABLE insight_finding_events
  DROP CONSTRAINT IF EXISTS insight_finding_events_action_check;

ALTER TABLE insight_finding_events
  ADD CONSTRAINT insight_finding_events_action_check
  CHECK (
    action IN (
      'archive',
      'mark_bad',
      'report_incorrect',
      'restore',
      'delete',
      'dismiss',
      'ignore',
      'mark_expected',
      'confirm'
    )
  );

ALTER TABLE insight_finding_preferences
  DROP CONSTRAINT IF EXISTS insight_finding_preferences_reason_code_check;

ALTER TABLE insight_finding_preferences
  ADD CONSTRAINT insight_finding_preferences_reason_code_check
  CHECK (
    reason_code IS NULL
    OR reason_code IN (
      'not_subscription',
      'wrong_data',
      'wrong_interpretation',
      'other_false_positive'
    )
  );

ALTER TABLE insight_finding_events
  DROP CONSTRAINT IF EXISTS insight_finding_events_reason_code_check;

ALTER TABLE insight_finding_events
  ADD CONSTRAINT insight_finding_events_reason_code_check
  CHECK (
    reason_code IS NULL
    OR reason_code IN (
      'not_subscription',
      'wrong_data',
      'wrong_interpretation',
      'other_false_positive'
    )
  );

COMMIT;
