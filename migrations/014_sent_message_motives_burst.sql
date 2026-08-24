-- Same-person burst membership on the durable motive rows. A burst is one Brain call returning
-- the same username more than once — a person adding a second, distinct thought as its own
-- consecutive message. Every part stays independently rateable under its own reaction id; burst_id
-- is what lets analytics read the parts as one social act. Nullable: the ordinary single-message
-- case stays exactly as it was.
ALTER TABLE sent_message_motives ADD COLUMN IF NOT EXISTS burst_id TEXT;
ALTER TABLE sent_message_motives ADD COLUMN IF NOT EXISTS burst_index INTEGER;
ALTER TABLE sent_message_motives ADD COLUMN IF NOT EXISTS burst_size INTEGER;
