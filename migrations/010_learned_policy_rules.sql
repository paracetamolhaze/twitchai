-- What the operator's verdicts add up to, once a Teacher has read a batch of them together.
--
-- Separate from message_verdicts on purpose: a verdict is evidence about one message, and a rule is
-- a conclusion drawn across several. Keeping them apart is what lets a rule outlive the exact
-- wording that produced it, which is the whole point — suppressing a near-duplicate string never
-- transfers to a sentence nobody has written yet.
CREATE TABLE IF NOT EXISTS learned_policy_rules (
  id UUID PRIMARY KEY,
  -- 'global' applies to every account; 'persona' only to scope_key's account; 'topic' only when the
  -- moment matches scope_key. Empty scope_key for global.
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '',
  rule TEXT NOT NULL,
  rationale TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  -- How many distinct feedback cases back this rule. A global rule needs several; one dislike is an
  -- opinion about one message, not a pattern.
  support_count INTEGER NOT NULL DEFAULT 0,
  positive_evidence INTEGER NOT NULL DEFAULT 0,
  negative_evidence INTEGER NOT NULL DEFAULT 0,
  -- 'active' | 'disabled' (operator switched it off) | 'superseded' (a Teacher run replaced it).
  -- The two inactive states are kept apart because only one of them may ever be reversed by the
  -- Teacher: an operator's disable is a decision, not a hypothesis to re-test.
  status TEXT NOT NULL DEFAULT 'active',
  teacher_model TEXT NOT NULL,
  evidence_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS learned_policy_rules_scope_idx ON learned_policy_rules (status, scope_type, scope_key);

-- Which verdicts a Teacher run has already counted as new evidence. Without this a second run
-- re-derives the same rule from the same dislikes and inflates its own support count.
ALTER TABLE message_verdicts ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS message_verdicts_unprocessed_idx ON message_verdicts (processed_at) WHERE processed_at IS NULL;
