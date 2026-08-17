-- The operator's judgement on messages the accounts sent. Rules in the instruction carry taste
-- badly; examples carry it well, so these become examples the decision layer reads.
CREATE TABLE IF NOT EXISTS message_verdicts (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  username TEXT NOT NULL,
  message TEXT NOT NULL,
  verdict TEXT NOT NULL,
  note TEXT,
  event_summary TEXT
);
CREATE INDEX IF NOT EXISTS message_verdicts_created_idx ON message_verdicts (created_at DESC);
