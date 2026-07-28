BEGIN;

ALTER TABLE transaction_metadata
  ADD COLUMN note text,
  ADD COLUMN note_version integer NOT NULL DEFAULT 0,
  ADD COLUMN note_updated_by text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN note_updated_at timestamptz;

ALTER TABLE transaction_metadata
  ADD CONSTRAINT transaction_metadata_note_check
    CHECK (
      note IS NULL
      OR (
        note = btrim(note)
        AND char_length(note) BETWEEN 1 AND 2000
      )
    ),
  ADD CONSTRAINT transaction_metadata_note_version_check
    CHECK (note_version >= 0),
  ADD CONSTRAINT transaction_metadata_note_audit_check
    CHECK (
      note IS NULL
      OR note_updated_at IS NOT NULL
    );

CREATE INDEX transaction_metadata_note_trgm_idx
  ON transaction_metadata USING gin (lower(note) gin_trgm_ops)
  WHERE note IS NOT NULL;

COMMENT ON COLUMN transaction_metadata.note IS
  'Shared workspace note for a transaction. Provider facts remain unchanged.';
COMMENT ON COLUMN transaction_metadata.note_version IS
  'Optimistic concurrency version for the shared transaction note.';

COMMIT;
