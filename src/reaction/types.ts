import { BotPersona } from '../personas/types';
import { BotConnectionState } from '../persistence/repository';
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

/**
 * What caused a reaction opportunity to exist. `stream_event` is a real observation from Gemini
 * Live perception, chat, or spoken transcription. `persona_drive` is an internal spontaneous
 * initiation opportunity with no external observation behind it — it is never a StreamEvent and
 * is never persisted, deduplicated, or fed into a future Brain bootstrap as one.
 */
export type ReactionTrigger =
  | { kind: 'stream_event'; event: StreamEvent }
  | { kind: 'persona_drive'; id: string };

export function triggerId(trigger: ReactionTrigger): string {
  return trigger.kind === 'stream_event' ? trigger.event.id : trigger.id;
}

export function triggerDirectMentions(trigger: ReactionTrigger): string[] {
  return trigger.kind === 'stream_event' ? trigger.event.directMentions : [];
}

export interface PlannedReaction {
  reservationId: string;
  trigger: ReactionTrigger;
  bot: ReactionBotCandidate;
  delayMs: number;
  directMention: boolean;
  viewerUsername?: string;
  message: string;
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
  | 'typographic_dash'
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

export type ReactionSendFailureReason = 'account_unavailable' | 'local_rate_limit' | 'twitch_send_failed';

export type ReactionSendResult =
  | { submitted: true; submittedAt: number }
  | { submitted: false; reason: ReactionSendFailureReason };

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

export interface ReactionTraceTiming {
  /** When the backend received Gemini's normalized event. */
  detectedAt: number;
  /** When candidate context was ready and returned to Gemini. */
  contextReadyAt?: number;
  /** When the stateful Brain interaction started and completed. */
  brainStartedAt?: number;
  brainReadyAt?: number;
  /** Wall time since the event was observed — includes waiting behind other events on the queue. */
  brainLatencyMs?: number;
  /** The model call on its own, so a backed-up queue is distinguishable from a slow model. */
  brainApiLatencyMs?: number;
  /** When Gemini returned the final batch. */
  decisionAt?: number;
  /** When the last accepted reaction reached a terminal IRC send state. */
  completedAt?: number;
}

export interface ReactionTraceReaction {
  username: string;
  message: string;
  artificialDelayMs: number;
  /**
   * UNDELIVERED means Twitch accepted the write but the message never came back through the reader
   * account, so the channel never showed it — distinct from FAILED, where the send itself errored.
   */
  status: 'ACCEPTED' | 'SCHEDULED' | 'SENT' | 'FAILED' | 'UNDELIVERED';
  selectedAt: number;
  scheduledAt?: number;
  /** When the IRC client submitted the message; Twitch does not expose display acknowledgement here. */
  sentAt?: number;
  failedAt?: number;
  failureReason?: string;
}

/** End-to-end explanation of why a detected event did or did not reach Twitch chat. */
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
  /** Compatibility projection derived from reactions. */
  policyAccepted: string[];
  policyRejected: ReactionRejection[];
  /** Compatibility projections derived from reactions. */
  scheduled: string[];
  sent: string[];
  sendFailed: Array<{ username: string; reason: string }>;
  timing: ReactionTraceTiming;
  reactions: ReactionTraceReaction[];
  brainInteractionId?: string;
  brainPreviousInteractionId?: string;
  brainPreviousInteractionUsed?: boolean;
  terminalReason?: string;
}
