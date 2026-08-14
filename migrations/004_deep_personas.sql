-- Persistent fictional-persona state. Canon remains in personas.config JSONB;
-- mutable memory and short-lived conversation state live in separate tables.

-- Repair any historical dangling persona references before adding constraints.
INSERT INTO personas (id, config)
SELECT b.persona_id,
       jsonb_build_object(
         'id', b.persona_id,
         'name', 'Импортированная личность ' || MIN(b.username),
         'description', 'Старая личность; глубокие поля ожидают заполнения.',
         'styleInstructions', 'Пиши естественно и не выдумывай биографию без контекста.',
         'verbosity', jsonb_build_object('minWords', 2, 'maxWords', 12),
         'reactionProbability', 0.4,
         'uppercaseProbability', 0.02,
         'questionProbability', 0.1,
         'emojiProbability', 0.02,
         'slangLevel', 0.3,
         'sarcasmLevel', 0.2,
         'toxicityLimit', 0.05,
         'interests', '[]'::jsonb,
         'temperature', 0.8,
         'minimumIntervalMs', 60000,
         '__templateUsername', MIN(b.username)
       )
FROM bot_accounts b
LEFT JOIN personas p ON p.id = b.persona_id
WHERE p.id IS NULL
GROUP BY b.persona_id
ON CONFLICT (id) DO NOTHING;

-- Existing deployments may have many accounts sharing one old archetype. Keep
-- the first assignment and clone canon for every additional account.
WITH ranked AS (
  SELECT username, persona_id,
         ROW_NUMBER() OVER (PARTITION BY persona_id ORDER BY username) AS position
  FROM bot_accounts
), clones AS (
  SELECT r.username,
         r.persona_id AS source_id,
         'account-' || regexp_replace(lower(r.username), '[^a-z0-9_-]+', '-', 'g') AS target_id
  FROM ranked r
  WHERE r.position > 1
)
INSERT INTO personas (id, config)
SELECT c.target_id,
       jsonb_set(
         jsonb_set(
           jsonb_set(p.config, '{id}', to_jsonb(c.target_id), true),
           '{name}',
           to_jsonb(COALESCE(p.config->>'name', 'Личность') || ' · ' || c.username),
           true
         ),
         '{__templateUsername}',
         to_jsonb(c.username),
         true
       )
FROM clones c
JOIN personas p ON p.id = c.source_id
ON CONFLICT (id) DO NOTHING;

WITH ranked AS (
  SELECT username, persona_id,
         ROW_NUMBER() OVER (PARTITION BY persona_id ORDER BY username) AS position
  FROM bot_accounts
)
UPDATE bot_accounts b
SET persona_id = 'account-' || regexp_replace(lower(r.username), '[^a-z0-9_-]+', '-', 'g'),
    updated_at = NOW()
FROM ranked r
WHERE b.username = r.username AND r.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS bot_accounts_persona_id_unique_idx
  ON bot_accounts (persona_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bot_accounts_persona_id_fkey'
  ) THEN
    ALTER TABLE bot_accounts
      ADD CONSTRAINT bot_accounts_persona_id_fkey
      FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS persona_memories (
  id UUID PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('stream_event', 'conversation', 'viewer', 'streamer', 'self', 'relationship')),
  summary TEXT NOT NULL,
  importance DOUBLE PRECISION NOT NULL CHECK (importance >= 0 AND importance <= 1),
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  viewer_username TEXT,
  event_id TEXT,
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS persona_memories_persona_created_idx
  ON persona_memories (persona_id, created_at DESC);
CREATE INDEX IF NOT EXISTS persona_memories_persona_importance_idx
  ON persona_memories (persona_id, importance DESC);
CREATE INDEX IF NOT EXISTS persona_memories_tags_idx
  ON persona_memories USING GIN (tags);

CREATE TABLE IF NOT EXISTS persona_conversation_messages (
  id UUID PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  viewer_username TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'persona')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS persona_conversation_thread_idx
  ON persona_conversation_messages (persona_id, viewer_username, created_at DESC);
CREATE INDEX IF NOT EXISTS persona_conversation_expiry_idx
  ON persona_conversation_messages (expires_at);

CREATE TABLE IF NOT EXISTS persona_relationships (
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  target_persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  familiarity DOUBLE PRECISION NOT NULL CHECK (familiarity >= 0 AND familiarity <= 1),
  sentiment DOUBLE PRECISION NOT NULL CHECK (sentiment >= -1 AND sentiment <= 1),
  notes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (persona_id, target_persona_id),
  CHECK (persona_id <> target_persona_id)
);
CREATE INDEX IF NOT EXISTS persona_relationships_target_idx
  ON persona_relationships (target_persona_id);
