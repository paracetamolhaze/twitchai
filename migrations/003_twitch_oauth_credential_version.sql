ALTER TABLE twitch_bot_credentials
  ADD COLUMN IF NOT EXISTS credential_version BIGINT NOT NULL DEFAULT 1;
