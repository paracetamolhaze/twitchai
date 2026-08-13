CREATE TABLE IF NOT EXISTS twitch_bot_credentials (
  twitch_user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  previous_username TEXT,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  expires_at TIMESTAMPTZ NOT NULL,
  refresh_state TEXT NOT NULL DEFAULT 'HEALTHY'
    CHECK (refresh_state IN ('HEALTHY', 'ERROR', 'RECONNECT_REQUIRED')),
  last_refresh_at TIMESTAMPTZ,
  last_refresh_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS twitch_bot_credentials_expires_at_idx
  ON twitch_bot_credentials (expires_at);

CREATE TABLE IF NOT EXISTS twitch_oauth_nonces (
  nonce_hash TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('launch', 'state')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (nonce_hash, purpose)
);

CREATE INDEX IF NOT EXISTS twitch_oauth_nonces_expires_at_idx
  ON twitch_oauth_nonces (expires_at);
