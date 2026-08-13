CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  config JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_accounts (
  username TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  connection_state TEXT NOT NULL DEFAULT 'DISCONNECTED',
  chat_connected BOOLEAN NOT NULL DEFAULT FALSE,
  messages_sent BIGINT NOT NULL DEFAULT 0,
  last_message TEXT,
  last_reaction_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stream_events (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  importance DOUBLE PRECISION NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS stream_events_occurred_at_idx ON stream_events (occurred_at DESC);

CREATE TABLE IF NOT EXISTS reaction_examples (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  game TEXT NOT NULL DEFAULT '',
  stream_context TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  event_summary TEXT NOT NULL,
  transcript TEXT,
  chat_messages JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS reaction_examples_occurred_at_idx ON reaction_examples (occurred_at DESC);

CREATE TABLE IF NOT EXISTS bot_message_history (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL,
  message TEXT NOT NULL,
  event_id UUID,
  sent_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_message_history_username_sent_idx ON bot_message_history (username, sent_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metrics JSONB NOT NULL
);
