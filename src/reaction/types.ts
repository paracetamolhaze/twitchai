import { BotPersona } from '../personas/types';
import { PersonaReactionContext } from '../personas/persona-context-builder';
import { BotConnectionState } from '../persistence/repository';
import { ReactionExample } from '../learning/types';
import { StreamerMemory } from '../global-memory/types';
import { ChatMessage } from '../stream-brain/types';
import { StreamEvent } from '../stream-brain/types';

export const REACTION_BATCH_PROTOCOL_MAX_ITEMS = 10;
export const REACTION_MESSAGE_PROTOCOL_MAX_CHARACTERS = 2_000;

export interface ReactionBotCandidate {
  username: string;
  persona: BotPersona;
  enabled: boolean;
  connectionState: BotConnectionState;
  chatConnected: boolean;
  lastReactionAt?: number;
}

export interface PlannedReaction {
  reservationId: string;
  event: StreamEvent;
  bot: ReactionBotCandidate;
  delayMs: number;
  directMention: boolean;
  viewerUsername?: string;
  message: string;
}

export interface ReactionContextCandidate extends PersonaReactionContext {
  rateLimit: { cooldownRemainingMs: number; busy: boolean };
}

export interface PreparedReactionContext {
  eventId: string;
  event: StreamEvent;
  recentChat: ChatMessage[];
  /** Supplied once per event, never repeated inside each persona candidate. */
  globalStreamerMemories: StreamerMemory[];
  candidates: ReactionContextCandidate[];
  reactionExamples: ReactionExample[];
  constraints: {
    maxReactions: number;
    maxMessageBytes: number;
    globalSlotsAvailable: number;
    expiresAt: number;
    instructions: string[];
  };
}

export interface SubmittedReaction {
  username: string;
  message: string;
}

export interface ReactionBatch {
  eventId: string;
  reactions: SubmittedReaction[];
}

export type ReactionRejectionReason =
  | 'duplicate_username'
  | 'unknown_candidate'
  | 'not_connected'
  | 'too_many_reactions'
  | 'empty_message'
  | 'control_value'
  | 'account_classification'
  | 'internal_metadata'
  | 'message_too_long'
  | 'account_cooldown'
  | 'account_busy'
  | 'global_rate_limit'
  | 'recent_duplicate'
  | 'invalid_item';

export interface ReactionRejection {
  username: string;
  reason: ReactionRejectionReason;
}

export interface ReactionBatchResult {
  eventId: string;
  accepted: Array<{ username: string; delayMs: number }>;
  rejected: ReactionRejection[];
  stale?: boolean;
}

export interface ReactionDecisionRecord {
  eventId: string;
  timestamp: number;
  selected: Array<{ username: string; message: string; delayMs: number }>;
  rejected: ReactionRejection[];
  candidateCount: number;
  silentCandidateCount: number;
}

export type DirectTargetUnavailableReason = 'unknown_bot' | 'disabled' | 'not_connected' | 'chat_disconnected';

export type ReactionTraceStage =
  | 'EVENT_DETECTED'
  | 'CANDIDATES_PREPARED'
  | 'GEMINI_SELECTED'
  | 'POLICY_VALIDATED'
  | 'SCHEDULED'
  | 'SEND_SUCCEEDED'
  | 'SEND_FAILED'
  | 'STOPPED';

export type ReactionTraceOutcome = 'PENDING' | 'SILENT' | 'SCHEDULED' | 'SENT' | 'PARTIAL' | 'FAILED' | 'STALE';

/** Metadata-only, end-to-end explanation of why a detected event did or did not reach Twitch chat. */
export interface ReactionTraceRecord {
  eventId: string;
  timestamp: number;
  updatedAt: number;
  eventType: StreamEvent['type'];
  summary: string;
  stage: ReactionTraceStage;
  outcome: ReactionTraceOutcome;
  eligibleBots: number;
  eligibleUsernames: string[];
  candidateCount: number;
  directMentions: string[];
  directTargetUnavailable: Array<{ username: string; reason: DirectTargetUnavailableReason }>;
  geminiSelected: string[];
  policyAccepted: string[];
  policyRejected: ReactionRejection[];
  scheduled: string[];
  sent: string[];
  sendFailed: Array<{ username: string; reason: string }>;
  terminalReason?: string;
}
