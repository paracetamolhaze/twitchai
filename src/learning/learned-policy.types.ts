/**
 * Where a learned rule applies. Scope is not decoration: one Brain call decides for several
 * shortlisted accounts at once, so a rule that belongs to one of them must never arrive looking
 * like a rule about all of them.
 */
export type LearnedRuleScope = 'global' | 'persona' | 'topic';

export type LearnedRuleStatus = 'active' | 'disabled' | 'superseded';

export interface LearnedPolicyRule {
  id: string;
  scopeType: LearnedRuleScope;
  /** Account username for 'persona', a topic phrase for 'topic', empty for 'global'. */
  scopeKey: string;
  /** The rule itself, as a short functional imperative. Never a forbidden phrase. */
  rule: string;
  /** Why it exists, for the dashboard and for a later Teacher run deciding whether it still holds. */
  rationale: string;
  confidence: number;
  /** Distinct feedback cases behind it. A global rule earns this over several runs. */
  supportCount: number;
  positiveEvidence: number;
  negativeEvidence: number;
  status: LearnedRuleStatus;
  teacherModel: string;
  /** message_verdicts ids the Teacher cited. Validated against the batch before anything is stored. */
  evidenceIds: string[];
  createdAt: number;
  updatedAt: number;
  version: number;
}

/**
 * One self-contained thing the Teacher is asked to reason about: a message, the operator's verdict
 * on it, and enough of the moment it answered to say *why* it was wrong rather than just *that* it
 * was. Assembled at run time from message_verdicts + stream_events + the persona catalog, not
 * denormalized into a table — the event payload is already stored whole, and a second copy would
 * only drift.
 */
export interface FeedbackCase {
  id: string;
  createdAt: number;
  username: string;
  message: string;
  verdict: 'good' | 'bad';
  note?: string;
  triggerKind: 'external_stream_event' | 'persona_drive';
  event?: {
    id: string;
    type: string;
    summary: string;
    speech?: string;
    visualContext?: string;
    audience?: string;
    /** What the account could have been grounded in at all: speech, scene, both, or nothing. */
    grounding: 'speech' | 'scene' | 'speech+scene' | 'none';
    importance: number;
  };
  /** Only the three fields a decision mistake is usually judged against, not the whole profile. */
  persona?: {
    interests: string[];
    expertise: string[];
    weakTopics: string[];
  };
  /** What chat looked like around the message, so "it repeated what was already said" is checkable. */
  recentChat: Array<{ username: string; message: string; kind: string }>;
}

/** One structured thing a Teacher run wants done. Never SQL, never free-form. */
export interface TeacherAction {
  action: 'CREATE_RULE' | 'UPDATE_RULE' | 'DISABLE_RULE' | 'NO_CHANGE';
  /** Required for UPDATE_RULE and DISABLE_RULE; empty otherwise. */
  ruleId: string;
  scopeType: LearnedRuleScope;
  scopeKey: string;
  rule: string;
  rationale: string;
  confidence: number;
  /** Feedback case ids this action rests on. Must all be in the batch that was sent. */
  evidenceIds: string[];
}

export interface TeacherRunOutcome {
  created: number;
  updated: number;
  disabled: number;
  unchanged: number;
  rejected: number;
  model: string;
  latencyMs: number;
  casesConsidered: number;
}

/** What retrieval hands one Brain decision, already split so scope cannot be misread. */
export interface LearnedPolicyForDecision {
  guidance: string;
  global: string[];
  topic: string[];
  byPersona: Record<string, string[]>;
  /** Ids and scopes of exactly what was attached, for the decision log. Never sent to the model. */
  supplied: Array<{ id: string; scope: LearnedRuleScope; scopeKey: string }>;
}
