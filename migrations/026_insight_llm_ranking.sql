BEGIN;

CREATE TABLE insight_llm_settings (
  workspace_id text PRIMARY KEY
    REFERENCES workspaces(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1
    CHECK (revision >= 1),
  base_guidance text NOT NULL
    CHECK (length(base_guidance) <= 4000),
  family_guidance jsonb NOT NULL DEFAULT '{
    "weekly": "",
    "investments": "",
    "subscriptions": ""
  }'::jsonb,
  candidate_limit integer NOT NULL DEFAULT 5
    CHECK (candidate_limit BETWEEN 1 AND 5),
  result_limit integer NOT NULL DEFAULT 3
    CHECK (result_limit BETWEEN 1 AND 3),
  feedback_mode text NOT NULL DEFAULT 'bad_and_archived'
    CHECK (
      feedback_mode IN ('none', 'bad', 'bad_and_archived')
    ),
  feedback_limit integer NOT NULL DEFAULT 12
    CHECK (feedback_limit BETWEEN 0 AND 12),
  context_length integer CHECK (
    context_length IS NULL
    OR context_length BETWEEN 256 AND 1048576
  ),
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT insight_llm_settings_family_guidance_check CHECK (
    jsonb_typeof(family_guidance) = 'object'
    AND family_guidance - ARRAY[
      'weekly',
      'investments',
      'subscriptions'
    ] = '{}'::jsonb
    AND jsonb_typeof(
      COALESCE(family_guidance -> 'weekly', '""'::jsonb)
    ) = 'string'
    AND jsonb_typeof(
      COALESCE(family_guidance -> 'investments', '""'::jsonb)
    ) = 'string'
    AND jsonb_typeof(
      COALESCE(family_guidance -> 'subscriptions', '""'::jsonb)
    ) = 'string'
    AND length(COALESCE(family_guidance ->> 'weekly', '')) <= 2000
    AND length(
      COALESCE(family_guidance ->> 'investments', '')
    ) <= 2000
    AND length(
      COALESCE(family_guidance ->> 'subscriptions', '')
    ) <= 2000
  )
);

CREATE TABLE insight_llm_call_status (
  workspace_id text NOT NULL
    REFERENCES workspaces(id) ON DELETE CASCADE,
  family text NOT NULL
    CHECK (family IN ('weekly', 'investments', 'subscriptions')),
  run_id text NOT NULL,
  guidance_revision bigint NOT NULL
    CHECK (guidance_revision >= 0),
  model text NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'succeeded',
      'not_configured',
      'no_candidates',
      'provider_error',
      'timeout',
      'invalid_response',
      'context_error',
      'length'
    )
  ),
  estimated_input_tokens integer NOT NULL
    CHECK (estimated_input_tokens >= 0),
  prompt_tokens integer CHECK (
    prompt_tokens IS NULL OR prompt_tokens >= 0
  ),
  completion_tokens integer CHECK (
    completion_tokens IS NULL OR completion_tokens >= 0
  ),
  total_tokens integer CHECK (
    total_tokens IS NULL OR total_tokens >= 0
  ),
  context_length integer CHECK (
    context_length IS NULL OR context_length > 0
  ),
  finish_reason text,
  latency_ms integer CHECK (
    latency_ms IS NULL OR latency_ms >= 0
  ),
  called_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, family)
);

ALTER TABLE insight_narratives
  ADD COLUMN guidance_revision bigint NOT NULL DEFAULT 0
    CHECK (guidance_revision >= 0),
  ADD COLUMN prompt_hash text NOT NULL DEFAULT 'legacy',
  ADD COLUMN model text NOT NULL DEFAULT 'legacy';

ALTER TABLE insight_narratives
  DROP CONSTRAINT insight_narratives_workspace_id_family_findings_hash_key;

ALTER TABLE insight_narratives
  ADD CONSTRAINT insight_narratives_cache_identity_key UNIQUE (
    workspace_id,
    family,
    findings_hash,
    guidance_revision,
    prompt_hash,
    model
  );

COMMIT;
