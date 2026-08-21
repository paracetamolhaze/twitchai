-- The dynamic half of a persona: what this person currently knows and doesn't, what they are
-- curious about, what is going on in their life this week, what they remember noticing on stream,
-- and how they feel right now. The authored canon (bot_personas) stays the slow half — identity,
-- history, voice — and is not duplicated here. One JSONB row per persona rather than six normalized
-- tables: the whole mind is always read and written together, a mind is bounded by construction
-- (every array inside is capped), and the operator inspects it as one object.
CREATE TABLE IF NOT EXISTS persona_minds (
  persona_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  mind JSONB NOT NULL,
  seed_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
