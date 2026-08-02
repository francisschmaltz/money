BEGIN;

ALTER TABLE users
  ADD COLUMN appearance_preference text NOT NULL DEFAULT 'system',
  ADD CONSTRAINT users_appearance_preference_valid
    CHECK (appearance_preference IN ('system', 'light', 'dark'));

COMMENT ON COLUMN users.appearance_preference IS
  'User-selected appearance: follow the operating system, light, or dark.';

COMMIT;
