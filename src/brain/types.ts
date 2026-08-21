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
   * Neither eventSelectivity nor chatFrequency is here. Both remain canon and both are already
   * applied deterministically by the backend — one as the policy guard's per-account interval, the
   * other as the weight Persona Drive uses when choosing whom to offer the floor to. Repeating them
   * to the model is the same restraint counted twice by a reader who cannot see the first count.
   * How talkative a character is now travels inside speechFingerprint as a habit.
   */
  activityPattern: {
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
  /**
   * What this session has already observed. Evidence: it happened, on this stream, tonight.
   *
   * Empty at the start of a stream and populated only on a rollover or recovery bootstrap, which is
   * the whole point of separating it from the field below.
   */
  currentSessionEvents: Array<Pick<StreamEvent, 'id' | 'timestamp' | 'type' | 'summary' | 'importance'>>;
  /**
   * What happened on earlier streams. Background, never evidence.
   *
   * This used to be one field called recentMeaningfulEvents, read from the last 50 rows of
   * stream_events with no filter on session, channel or age. At 20:35:38 a stream started, the
   * bootstrap carried 25 events from a previous evening under that name, the first observation of
   * the new session was a Dota draft screen, and nine seconds later an account wrote "доехали до
   * компов наконец-то" — a journey nobody had seen, invented to bridge two states the payload
   * presented as adjacent. Same data, honest label, and the instruction can now say what each one
   * is worth.
   */
  earlierStreamEvents: Array<Pick<StreamEvent, 'id' | 'timestamp' | 'type' | 'summary' | 'importance'>>;
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
  /** FIRST_MESSAGE_GATE, present only until this session's first message actually reaches Twitch. */
  firstMessageGate?: string;
  /**
   * What the operator's own verdicts have been generalized into, narrowed to what bears on this
   * moment and these candidates.
   *
   * Dynamic, like firstMessageGate above and for the same reason: BRAIN_SYSTEM_INSTRUCTION is the
   * cached prefix of standing principles and is already at its size budget, while this is absent on
   * most decisions and different on the rest. Scopes are kept apart structurally — one call decides
   * for several shortlisted accounts, so a rule learned about one of them must never arrive looking
   * like a rule about all of them.
   */
  learnedPolicy?: {
    guidance: string;
    global: string[];
    topic: string[];
    byPersona: Record<string, string[]>;
  };
  /**
   * The slice of each candidate's own life that bears on this moment — knowledge and gaps,
   * curiosities, this week's concerns, remembered stream facts, tonight's mood. Only candidates
   * with something relevant appear; the absence of an entry is itself the signal that this moment
   * is not for that person. Built deterministically by PersonaMindStore — no model call.
   */
  mindContext?: {
    guidance: string;
    byPersona: Record<string, string[]>;
  };
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
   * What this session has just heard and just seen — the only place a reason to speak could come
   * from, and until now the one thing this payload did not contain.
   *
   * The drive was asked whether anybody had something to add while being shown the chat (nearly
   * empty on an IRL stream), each account's own last few messages, and memories from other
   * evenings. Twelve seconds after the stream said "вебку вот так делать, чтобы IRL был" a drive
   * call went out and came back silent, while the event path — handed the same words — produced "с
   * камерой норм задумка, живее будет". The instruction asked for a thought about what is
   * happening; what is happening was not in the request.
   */
  recentSpeech?: Array<{ timestamp: number; text: string }>;
  recentEvents?: Array<Pick<StreamEvent, 'timestamp' | 'type' | 'summary'>>;
  /**
   * How long ago perception last reported anything at all. A spontaneous message written while
   * this is minutes old is being written against a scene that has since moved on, so the decision
   * layer is told the age rather than being handed a stale observation as if it were current.
   */
  secondsSinceLastObservation?: number;
  /** FIRST_MESSAGE_GATE, present only until this session's first message actually reaches Twitch. */
  firstMessageGate?: string;
  /**
   * The operator's learned rules, exactly as the external-event path carries them. Their absence
   * here was a production bug: a drive decision went out with learnedRulesSupplied: 0 while every
   * stream-event decision carried three rules, so spontaneous messages bypassed everything the
   * operator had taught.
   */
  learnedPolicy?: {
    guidance: string;
    global: string[];
    topic: string[];
    byPersona: Record<string, string[]>;
  };
  /**
   * What each drive candidate is already carrying — open curiosities, callbacks, a live concern.
   * This is what a spontaneous message is FOR: the timer is only the opportunity, one of these is
   * the reason. A tick where no candidate carries anything is skipped before the model is called.
   */
  mindContext?: {
    guidance: string;
    byPersona: Record<string, string[]>;
  };
  deltas: BrainDynamicDelta[];
}

/**
 * Sent only while no account has managed to say anything this session, and removed for good once
 * one has.
 *
 * It lives here rather than in the system instruction on purpose. The instruction is the cached
 * prefix and is a set of standing principles; this is a condition that is true for the first few
 * minutes of an evening and false for the rest of it, and putting a paragraph about cold starts in
 * the permanent text would have every later decision reading a rule that no longer applies. It is
 * also cheap: a few hundred characters on the handful of turns before the first message lands.
 */
export const FIRST_MESSAGE_GATE = 'Nothing has been sent this session yet. A first message that '
  + 'could have preceded any stream — a safe preference, an agreement with whatever was just said, '
  + 'a name for the scene, a general opinion — is worse than none, because it is what these '
  + 'accounts will sound like before they have sounded like anything. Send now only if this moment '
  + 'plainly asks for it: the chat was addressed, an account was named, or something just happened '
  + 'that a person would answer without having to think of a reason. It may be one word, a laugh, '
  + 'or a correction. It must not be built out of an earlier evening. Otherwise stay silent; there '
  + 'will be a better one.';

/**
 * Why a message exists, in inspectable structured form rather than hidden reasoning. `motive` is
 * the social act (ask, tease, correct, joke…); `sourceType` is where it personally came from — a
 * knowledge gap, a belief, a memory, a relationship, this week's life, or plain emotion. 'none'
 * means the model found no personal origin, which the backend counts rather than blocks: the goal
 * is that it becomes rare, and visible when it is not.
 */
export const REACTION_MOTIVES = [
  'ask', 'tease', 'disagree', 'agree', 'correct', 'recall', 'share_experience', 'react',
  'joke', 'answer', 'support', 'warn', 'advise', 'continue_thread', 'other',
] as const;

export const REACTION_SOURCE_TYPES = [
  'knowledge_gap', 'curiosity', 'belief', 'memory', 'relationship', 'current_life',
  'expertise', 'event_emotion', 'chat', 'none',
] as const;

/** Source types that mean the message came from somewhere inside this particular person. */
export const PERSONAL_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'knowledge_gap', 'curiosity', 'belief', 'memory', 'relationship', 'current_life', 'expertise', 'chat',
]);

export interface BrainReaction {
  username: string;
  message: string;
  motive?: string;
  sourceType?: string;
  /** Free-form pointer at the specific source — a topic, a person, a remembered line. */
  sourceRef?: string;
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
  /** Every call to the model, decisions plus bootstraps and session handovers. */
  interactions: number;
  /**
   * Calls that decided something: every observed moment plus every Persona Drive opportunity,
   * whether or not a message came out. `decisions - silentDecisions` is the number that produced
   * one, and must never be negative — it was, when a silent drive call counted below but not here.
   */
  decisions: number;
  /** Decisions that returned no message at all. A subset of `decisions`, never larger than it. */
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
