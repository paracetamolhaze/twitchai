-- Channel-scoped continuity. This is intentionally separate from raw
-- stream_events and from persona-scoped memory.
CREATE TABLE IF NOT EXISTS stream_sessions (
  id UUID PRIMARY KEY,
  channel TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  initial_category TEXT,
  initial_stream_context TEXT,
  status TEXT NOT NULL CHECK (status IN ('live', 'ended', 'interrupted')),
  summary TEXT
);

-- At most one active session per channel. The repository also takes an
-- advisory lock so concurrent Railway instances reuse rather than race.
CREATE UNIQUE INDEX IF NOT EXISTS stream_sessions_one_live_channel_idx
  ON stream_sessions (channel) WHERE status = 'live';
CREATE INDEX IF NOT EXISTS stream_sessions_channel_started_idx
  ON stream_sessions (channel, started_at DESC);
CREATE INDEX IF NOT EXISTS stream_sessions_channel_live_seen_idx
  ON stream_sessions (channel, last_seen_at DESC) WHERE status = 'live';
CREATE INDEX IF NOT EXISTS stream_sessions_status_idx ON stream_sessions (status);

CREATE TABLE IF NOT EXISTS streamer_memories (
  id UUID PRIMARY KEY,
  channel TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'fact', 'preference', 'person', 'relationship', 'plan', 'promise', 'result',
    'place', 'trip', 'running_joke', 'important_event', 'recurring_context', 'other'
  )),
  summary TEXT NOT NULL,
  details JSONB,
  entities TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  importance DOUBLE PRECISION NOT NULL CHECK (importance >= 0 AND importance <= 1),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  occurred_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  confirmation_count INTEGER NOT NULL DEFAULT 1 CHECK (confirmation_count >= 1),
  source_session_id UUID REFERENCES stream_sessions(id) ON DELETE SET NULL,
  source_event_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'resolved', 'superseded', 'expired')),
  expires_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  superseded_by UUID REFERENCES streamer_memories(id) ON DELETE SET NULL,
  dedupe_key TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS streamer_memories_channel_idx ON streamer_memories (channel);
CREATE INDEX IF NOT EXISTS streamer_memories_channel_type_idx ON streamer_memories (channel, type);
CREATE INDEX IF NOT EXISTS streamer_memories_channel_status_idx ON streamer_memories (channel, status);
CREATE INDEX IF NOT EXISTS streamer_memories_importance_idx ON streamer_memories (channel, importance DESC);
CREATE INDEX IF NOT EXISTS streamer_memories_occurred_idx ON streamer_memories (channel, occurred_at DESC);
CREATE INDEX IF NOT EXISTS streamer_memories_created_idx ON streamer_memories (channel, created_at DESC);
CREATE INDEX IF NOT EXISTS streamer_memories_source_session_idx ON streamer_memories (source_session_id);
CREATE INDEX IF NOT EXISTS streamer_memories_entities_idx ON streamer_memories USING GIN (entities);
CREATE INDEX IF NOT EXISTS streamer_memories_tags_idx ON streamer_memories USING GIN (tags);
CREATE INDEX IF NOT EXISTS streamer_memories_details_idx ON streamer_memories USING GIN (details);
CREATE UNIQUE INDEX IF NOT EXISTS streamer_memories_active_dedupe_idx
  ON streamer_memories (channel, dedupe_key) WHERE status = 'active';
