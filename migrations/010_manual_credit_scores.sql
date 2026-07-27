BEGIN;

CREATE TABLE credit_score_sources (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  label text NOT NULL,
  bureau text,
  scoring_model text,
  archived_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_score_sources_member_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_members(workspace_id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT credit_score_sources_label_length
    CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
  CONSTRAINT credit_score_sources_bureau_length
    CHECK (bureau IS NULL OR char_length(btrim(bureau)) BETWEEN 1 AND 80),
  CONSTRAINT credit_score_sources_model_length
    CHECK (
      scoring_model IS NULL
      OR char_length(btrim(scoring_model)) BETWEEN 1 AND 80
    )
);

CREATE INDEX credit_score_sources_workspace_user_idx
  ON credit_score_sources (workspace_id, user_id, archived_on, created_at);

CREATE TABLE credit_score_observations (
  id text PRIMARY KEY,
  source_id text NOT NULL
    REFERENCES credit_score_sources(id)
    ON DELETE CASCADE,
  observed_on date NOT NULL,
  score smallint NOT NULL CHECK (score BETWEEN 300 AND 850),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_score_observations_source_date_unique
    UNIQUE (source_id, observed_on)
);

CREATE INDEX credit_score_observations_source_date_idx
  ON credit_score_observations (source_id, observed_on DESC);

COMMIT;
