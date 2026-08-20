-- The verdict feature stored username/message/verdict/note but never linked back to the moment
-- the message answered, so a dislike could not become regression evidence and a like could not be
-- traced to its trigger. Resolved server-side from BotHistory at verdict time, not sent by the
-- frontend, which never has this data.
ALTER TABLE message_verdicts ADD COLUMN IF NOT EXISTS event_id TEXT;
