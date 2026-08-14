-- Deep Persona Generation v3 keeps schemaVersion=2 and versions the
-- deterministic generation logic independently. Previous canon is retained
-- before any automatic or operator-approved regeneration.
CREATE TABLE IF NOT EXISTS persona_canon_backups (
  id BIGSERIAL PRIMARY KEY,
  persona_id TEXT NOT NULL,
  username TEXT,
  reason TEXT NOT NULL,
  generation_version INTEGER NOT NULL DEFAULT 0,
  canon JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS persona_canon_backups_persona_created_idx
  ON persona_canon_backups (persona_id, created_at DESC);

CREATE INDEX IF NOT EXISTS persona_canon_backups_username_created_idx
  ON persona_canon_backups (username, created_at DESC)
  WHERE username IS NOT NULL;
