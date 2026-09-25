-- Unknown historical origins stay NULL; never attribute them to the current stream.
ALTER TABLE persona_memories ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE persona_conversation_messages ADD COLUMN IF NOT EXISTS channel TEXT;
CREATE INDEX IF NOT EXISTS persona_memories_channel_idx ON persona_memories (channel, persona_id, created_at DESC);
CREATE INDEX IF NOT EXISTS persona_conversation_channel_idx ON persona_conversation_messages (channel, viewer_username, created_at DESC);

-- Append-only rating history, with one current verdict per sending.
ALTER TABLE message_verdicts ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY lower(username), reaction_id ORDER BY created_at DESC, id DESC) AS rn
  FROM message_verdicts WHERE reaction_id IS NOT NULL
)
UPDATE message_verdicts SET superseded_at=NOW() WHERE id IN (SELECT id FROM ranked WHERE rn>1);
CREATE UNIQUE INDEX IF NOT EXISTS message_verdicts_current_reaction_idx
  ON message_verdicts (lower(username), reaction_id) WHERE reaction_id IS NOT NULL AND superseded_at IS NULL;

-- Reconcile historical counters and withdraw conclusions based on superseded ratings.
WITH evidence AS (
  SELECT r.id,
    COALESCE(jsonb_agg(DISTINCT to_jsonb(e.id)) FILTER (WHERE e.id IS NOT NULL AND v.superseded_at IS NULL), '[]'::jsonb) AS ids,
    COUNT(DISTINCT v.id) FILTER (WHERE v.superseded_at IS NULL AND v.verdict='good') AS positive,
    COUNT(DISTINCT v.id) FILTER (WHERE v.superseded_at IS NULL AND v.verdict='bad') AS negative,
    BOOL_OR(v.superseded_at IS NOT NULL) AS corrected
  FROM learned_policy_rules r
  LEFT JOIN LATERAL jsonb_array_elements_text(r.evidence_ids) e(id) ON TRUE
  LEFT JOIN message_verdicts v ON v.id::text=e.id
  GROUP BY r.id
)
UPDATE learned_policy_rules r SET evidence_ids=e.ids, support_count=jsonb_array_length(e.ids),
  positive_evidence=e.positive, negative_evidence=e.negative,
  confidence=CASE WHEN e.corrected THEN 0 ELSE r.confidence END
FROM evidence e WHERE r.id=e.id;
