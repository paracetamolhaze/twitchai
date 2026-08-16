-- Autonomous messages are caused by no external event, so they carry a synthetic
-- `persona-drive:<uuid>` id instead of a StreamEvent id. Against a UUID column every one of them
-- failed to insert, which lost them from the history the anti-repetition context and the
-- AI-chain-depth limit are both read from.
ALTER TABLE bot_message_history ALTER COLUMN event_id TYPE TEXT USING event_id::text;
