BEGIN;

CREATE TABLE mobile_auth_handoffs (
  code_hash char(64) PRIMARY KEY,
  code_challenge char(43) NOT NULL,
  identity jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX mobile_auth_handoffs_expire_idx ON mobile_auth_handoffs (expires_at);

CREATE TABLE native_sessions (
  token_hash char(64) PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CONSTRAINT native_sessions_expiry_valid CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX native_sessions_user_idx ON native_sessions (user_id);
CREATE INDEX native_sessions_expire_idx ON native_sessions (expires_at)
  WHERE expires_at IS NOT NULL;

COMMIT;
