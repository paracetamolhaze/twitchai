-- Why each sent message existed, durable enough to survive a restart and be joined against the
-- operator's verdicts. In-memory motive logs answered "what did we just send"; this table answers
-- the question the whole Living Persona layer is accountable to: do messages grounded in a real
-- personal source get approved more often than generic event commentary?
CREATE TABLE IF NOT EXISTS sent_message_motives (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  username TEXT NOT NULL,
  message TEXT NOT NULL,
  event_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  motive TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT,
  source_validated BOOLEAN NOT NULL,
  validated_source_type TEXT,
  -- Which learned rules were in the payload when this message was generated. An array, not a join
  -- table: it is read only as a whole, per message, by the Teacher and the analytics endpoint.
  learned_rule_ids JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- The analytics join is verdict → motive by (username, message); recency queries go by created_at.
CREATE INDEX IF NOT EXISTS idx_sent_message_motives_created_at ON sent_message_motives (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sent_message_motives_username ON sent_message_motives (username, created_at DESC);
