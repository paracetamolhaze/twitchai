-- The operator's verdict names ONE specific sending, not "a message with this text". reaction_id is
-- the canonical id minted when the Brain's reaction entered the backend — the same value as
-- bot_messages.id and sent_message_motives.id for that message — and it is what motive analytics
-- and the Teacher join on from now on.
--
-- Nullable and unbackfilled on purpose: rows written before the id existed cannot be tied to a
-- sending with certainty, and pretending otherwise would fake the analytics this exists to make
-- honest. link_kind says which rows those are: every pre-existing row becomes 'legacy' (recoverable
-- only by a bounded text+time fallback, or not at all); the application writes 'exact' when the id
-- is present and 'lost' when a new bot line somehow reached the dashboard without one — a logged
-- bug, never silently text-matched.
ALTER TABLE message_verdicts ADD COLUMN IF NOT EXISTS reaction_id TEXT;
ALTER TABLE message_verdicts ADD COLUMN IF NOT EXISTS link_kind TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX IF NOT EXISTS idx_message_verdicts_reaction_id ON message_verdicts (reaction_id) WHERE reaction_id IS NOT NULL;
