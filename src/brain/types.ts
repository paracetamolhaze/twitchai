import { StreamerMemoryType } from '../global-memory/types';
import { ReactionExample } from '../learning/types';
import { PersonaMemoryType } from '../personas/types';
import { ChatMessage, StreamEvent } from '../stream-brain/types';

export type BrainThinkingLevel = 'low' | 'medium' | 'high';

/**
 * The permanent "who this character is" record, sent once per session in the bootstrap and then
 * carried by the previous_interaction_id chain — event and drive payloads never resend it.
 *
 * It deliberately carries the character's negative space (flaws, weakTopics, unknownTopics,
 * avoidedExpressions) alongside the positive one: a profile listing only what someone is good at
 * produces a voice that answers everything competently, which is the main way these read as
 * machine-written rather than as a specific person.
 */
export interface BrainPersonaSnapshot {
  username: string;
  preferredName: string;
  shortIdentity: string;
  character: string;
  /** Character's own weaknesses and rough edges — the model should let these show, not smooth them over. */
  flaws: string[];
  /**
   * eventSelectivity is deliberately not here. It remains canon and remains in the audit tooling,
   * but a bare 0.82 in the payload reads as a standing instruction to stay quiet, and it used to
   * arrive here and again on every event. chatFrequency carries the same trait qualitatively.
   */
  activityPattern: {
    chatFrequency: 'very-low' | 'low' | 'medium' | 'high';
    directReplyLikelihood: number;
    preferredEventTypes?: string[];
    ignoredEventTypes?: string[];
  };
  speechFingerprint: string;
  expertise: string[];
  /** Topics this character knows only shallowly — hedge or defer instead of sounding authoritative. */
  weakTopics: string[];
  /** Topics this character simply does not know — say so plainly or stay silent, never improvise expertise. */
  unknownTopics: string[];
  /** Phrases this specific character would never use, even when they would fit the moment. */
  avoidedExpressions: string[];
  /** Stances the character actually holds, as "topic: stance" — the raw material of an opinionated message. */
  opinions: string[];
  /** Subjects that reliably provoke a reaction from this character. */
  emotionalTriggers: string[];
  interests: string[];
  relationshipToStreamer: string;
  disclosureBoundaries: string;
}

export interface BrainBootstrap {
  channel: string;
  category: string;
  streamContext: string;
  startedAt: number;
  availableBots: string[];
  personas: BrainPersonaSnapshot[];
  globalMemories: Array<{
    type: StreamerMemoryType;
    summary: string;
    importance: number;
    confidence: number;
    entities: string[];
  }>;
  recentMeaningfulEvents: Array<Pick<StreamEvent, 'id' | 'timestamp' | 'type' | 'summary' | 'importance'>>;
  /**
   * What the stream has been about so far, written by the session being replaced.
   *
   * A rollover exists to stop one conversation's per-call cost from growing without limit, and it
   * used to do that by forgetting: everything said and decided since the stream began went away
   * with the chain. This carries it across in a few hundred tokens instead, so a shorter rollover
   * threshold costs recall of detail rather than recall of the stream.
   */
  previousSessionSummary?: string;
  recentChat: Array<Pick<ChatMessage, 'timestamp' | 'username' | 'message' | 'kind'>>;
}

export interface BrainTargetedPersonaContext {
  username: string;
  relevantCanon: Array<{ kind: string; value: string }>;
  relevantMemories: Array<{ type: string; summary: string; importance: number }>;
  recentConversation: Array<{ role: 'viewer' | 'persona'; message: string }>;
  recentMessages: string[];
  personalResponseGuidance: string;
}

export interface BrainDynamicDelta {
  type: 'BOT_STATUS_UPDATE' | 'PERSONA_UPDATED' | 'CATEGORY_CHANGED' | 'MEMORY_ADDED' | 'CONTEXT_UPDATED';
  summary: string;
  payload?: Record<string, unknown>;
}

export interface BrainEventInput {
  triggerKind: 'external_stream_event';
  event: StreamEvent;
  availableBots: string[];
  /**
   * The last few messages each available account actually sent, so a draft can be checked against
   * what that account already said. Previously this reached the model only for direct mentions,
   * which left the anti-repetition rule with nothing to compare against on an ordinary event.
   */
  recentAccountMessages?: Array<{ username: string; messages: string[] }>;
  /**
   * What was actually said, transcribed, rather than perception's retelling of it. The event
   * summary is one model describing a moment in its own words — "proposes some sort of plan" where
   * the words were "we are trying to drag him along for drinks". These are the words.
   */
  recentSpeech?: Array<{ timestamp: number; text: string }>;
  recentChatDelta: Array<Pick<ChatMessage, 'timestamp' | 'username' | 'message' | 'kind'>>;
  /**
   * A couple of things each available account personally remembers.
   *
   * Their full profile arrives once at bootstrap, but memory is where a character's opinions
   * actually live, and it used to reach the model only when the stream said that account's name.
   * On every ordinary moment the accounts were writing with no history of their own in front of
   * them, which is most of why the messages read as commentary rather than as somebody talking.
   */
  recalledMemories?: Array<{ username: string; memories: Array<{ type: string; summary: string }> }>;
  /**
   * The same description of a candidate the spontaneous layer has always received: mood, how
   * engaged they are, how much they have already said this session. That layer picks whoever has
   * the most to work with and its messages read better for it; reactions were handed whoever
   * happened to be off cooldown, with no way to tell one from another.
   */
  candidateStates?: Array<{
    username: string;
    mood: string;
    engagement: number;
    sessionMessageCount: number;
    /**
     * Whether this particular moment is one they would pay attention to, taken from their own
     * profile rather than from how long they have been quiet. Fit is a reason to speak; a turn in
     * a rotation is not, and the instruction that replaced this used to say the opposite.
     *
     * Only ever a reason to speak. There is no numeric selectivity beside it any more: the two
     * together meant a candidate arrived carrying both "this is not your kind of moment" and "you
     * skip most moments anyway", on top of a cooldown the backend had already applied.
     */
    attention: 'notices' | 'passes over' | 'no strong pattern';
  }>;
  /**
   * What is known about this streamer that bears on this particular moment, looked up by the words
   * that were just said. Session start loads a handful of memories and nothing re-reads them
   * against the topic at hand.
   */
  streamerMemories?: Array<{ type: string; summary: string }>;
  targetedPersonaContext: BrainTargetedPersonaContext[];
  reactionExamples: ReactionExample[];
  deltas: BrainDynamicDelta[];
  constraints: {
    maxReactions: number;
    maxMessageBytes: number;
    globalSlotsAvailable: number;
    expiresAt: number;
  };
  mergedEventIds?: string[];
  /**
   * When a burst was merged, the individual observations that went into it.
   *
   * The merged event concatenates their summaries into one string, which reads as a single moment
   * and is not one: several things noticed across a stretch of stream arrive as one run-on
   * sentence. These are kept separate so the decision can weigh them as what they are, rather than
   * answering an event that never existed in that form.
   */
  mergedObservations?: Array<{
    timestamp: number;
    type: string;
    summary: string;
    importance: number;
    confidence: number;
    speech?: string;
    visualContext?: string;
  }>;
}

/**
 * One candidate's compact context for a Persona Drive opportunity: purely the state that changed
 * since the session began — mood, engagement, what this persona recalled, what it recently said.
 *
 * It carries no persona profile. The full BrainPersonaSnapshot for every available username was
 * already established in this same previous_interaction_id chain by the bootstrap, so resending it
 * per candidate per call was duplicated context; the external event path (prepareBrainEvent) has
 * always relied on that same chain memory and sends only usernames.
 */
export interface BrainDriveCandidate {
  username: string;
  mood: string;
  engagement: number;
  sessionMessageCount: number;
  recalledMemories: Array<{ type: string; summary: string; importance: number }>;
  recentOwnMessages: string[];
}

/**
 * Internal spontaneous-initiation opportunity — never an observed StreamEvent. Gemini 3.1 Live
 * never sees or creates this; it only ever reaches Gemini 3.7 Brain via GeminiBrainService.
 * evaluateDriveOpportunity.
 */
export interface BrainDriveOpportunityInput {
  triggerKind: 'persona_drive';
  channel: string;
  category: string;
  streamContext: string;
  candidates: BrainDriveCandidate[];
  recentChat: Array<Pick<ChatMessage, 'timestamp' | 'username' | 'message' | 'kind'>>;
  /**
   * How long ago perception last reported anything at all. A spontaneous message written while
   * this is minutes old is being written against a scene that has since moved on, so the decision
   * layer is told the age rather than being handed a stale observation as if it were current.
   */
  secondsSinceLastObservation?: number;
  deltas: BrainDynamicDelta[];
}

export interface BrainReaction {
  username: string;
  message: string;
}

export type BrainMemoryUpdate =
  | {
      scope: 'global';
      type: StreamerMemoryType;
      summary: string;
      importance: number;
      confidence: number;
      entities?: string[];
      tags?: string[];
    }
  | {
      scope: 'persona';
      username: string;
      type: PersonaMemoryType;
      summary: string;
      importance: number;
      confidence: number;
      tags?: string[];
      viewerUsername?: string;
    };

export interface BrainDecision {
  reactions: BrainReaction[];
  memoryUpdates: BrainMemoryUpdate[];
}

export interface BrainInteractionUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  /** What the call actually cost, when the transport reports it. Beats any local price table. */
  costUsd?: number;
}

export interface GeminiBrainStatus {
  state: 'OFFLINE' | 'STARTING' | 'READY' | 'THINKING' | 'ERROR';
  model: string;
  thinkingLevel: BrainThinkingLevel;
  sessionStartedAt?: number;
  interactionStartedAt?: number;
  previousInteractionId?: string;
  interactions: number;
  decisions: number;
  silentDecisions: number;
  generatedReactions: number;
  averageLatencyMs: number;
  lastLatencyMs?: number;
  lastError?: string;
  rebuiltSessions: number;
  rollovers: number;
  contextTokens: number;
  bootstrapChars: number;
  bootstrapInputTokens: number;
}
