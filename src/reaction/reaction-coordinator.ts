import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { Logger } from '../logger';
import { ReactionMemory } from '../learning/reaction-memory';
import { GlobalStreamerMemory } from '../global-memory/global-streamer-memory';
import { BotHistory } from '../personas/bot-history';
import { PersonaContextBuilder } from '../personas/persona-context-builder';
import { PersonaMemory } from '../personas/persona-memory';
import { PersonaRuntimeStore } from '../personas/persona-runtime-store';
import { ContextStore } from '../stream-brain/context-store';
import { StreamEvent } from '../stream-brain/types';
import { BrainEventInput } from '../brain/types';
import { UsageTracker } from '../usage/usage-tracker';
import { ReactionPolicyGuard } from './reaction-policy-guard';
import {
  PlannedReaction,
  ReactionBatch,
  ReactionBatchResult,
  ReactionBotCandidate,
  ReactionDecisionRecord,
  ReactionRejection,
  ReactionSendResult,
  ReactionTraceRecord,
  REACTION_BATCH_PROTOCOL_MAX_ITEMS,
  REACTION_MESSAGE_PROTOCOL_MAX_CHARACTERS,
  SubmittedReaction,
} from './types';

export interface ReactionSender {
  send(username: string, message: string): Promise<ReactionSendResult>;
}

export interface ReactionCoordinatorOptions {
  policy: ReactionPolicyGuard;
  sender: ReactionSender;
  history: BotHistory;
  memory: ReactionMemory;
  globalMemory: GlobalStreamerMemory;
  personaContext: PersonaContextBuilder;
  personaMemory: PersonaMemory;
  personaRuntime: PersonaRuntimeStore;
  contextStore: ContextStore;
  usage: UsageTracker;
  logger: Logger;
  retrievalLimit: number;
  candidates: () => ReactionBotCandidate[];
  contextTtlMs?: number;
  now?: () => number;
}

interface PendingContext {
  event: StreamEvent;
  permittedUsernames: Set<string>;
  candidateCount: number;
  viewerByUsername: Map<string, string>;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const batchEnvelopeSchema = z.object({
  eventId: z.string().trim().min(1).max(100),
  reactions: z.array(z.unknown()).max(REACTION_BATCH_PROTOCOL_MAX_ITEMS),
}).strict();
const reactionItemSchema = z.object({
  username: z.string().min(1).max(50).refine((value) => value.trim().length > 0),
  message: z.string().max(REACTION_MESSAGE_PROTOCOL_MAX_CHARACTERS),
}).strict();

export class ReactionCoordinator extends EventEmitter {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly contextTtlMs: number;
  private readonly timers = new Map<NodeJS.Timeout, PlannedReaction>();
  private readonly pendingContexts = new Map<string, PendingContext>();
  private readonly traces = new Map<string, ReactionTraceRecord>();
  private stopped = false;

  constructor(private readonly options: ReactionCoordinatorOptions) {
    super();
    this.logger = options.logger.child('DECISION');
    this.now = options.now ?? Date.now;
    this.contextTtlMs = options.contextTtlMs ?? 45_000;
  }

  async submitBatch(input: unknown): Promise<ReactionBatchResult> {
    const envelope = batchEnvelopeSchema.parse(input);
    const itemRejections: ReactionRejection[] = [];
    const reactions: SubmittedReaction[] = [];
    for (const [index, raw] of envelope.reactions.entries()) {
      const parsedItem = reactionItemSchema.safeParse(raw);
      if (parsedItem.success) reactions.push(parsedItem.data);
      else itemRejections.push({ username: rawUsername(raw, index), reason: 'invalid_item' });
    }
    const parsed: ReactionBatch = { eventId: envelope.eventId, reactions };
    this.options.usage.recordReactionBatch();
    const pending = this.pendingContexts.get(parsed.eventId);
    if (!pending) {
      this.options.usage.recordGuardRejection();
      return { eventId: parsed.eventId, accepted: [], rejected: itemRejections, stale: true };
    }
    const decisionAt = this.now();
    if (pending.expiresAt <= decisionAt) {
      this.removePending(parsed.eventId);
      this.options.usage.recordGuardRejection();
      const staleTrace = this.traces.get(parsed.eventId);
      this.updateTrace(parsed.eventId, {
        stage: 'STOPPED',
        outcome: 'STALE',
        terminalReason: 'reaction_context_stale',
        ...(staleTrace ? { timing: { ...staleTrace.timing, completedAt: decisionAt } } : {}),
      });
      return { eventId: parsed.eventId, accepted: [], rejected: itemRejections, stale: true };
    }
    const selectedTrace = this.traces.get(parsed.eventId);
    this.updateTrace(parsed.eventId, {
      stage: 'GEMINI_SELECTED',
      geminiSelected: envelope.reactions.map((reaction, index) => rawUsername(reaction, index)),
      ...(selectedTrace ? { timing: { ...selectedTrace.timing, decisionAt } } : {}),
    });
    this.removePending(parsed.eventId);
    this.options.usage.recordGenerated(parsed.reactions.length);
    itemRejections.forEach(() => this.options.usage.recordGuardRejection());
    if (parsed.reactions.length === 0) {
      this.options.usage.recordEmptyReactionBatch();
      this.updateTrace(parsed.eventId, {
        stage: 'POLICY_VALIDATED',
        outcome: 'SILENT',
        policyRejected: itemRejections,
        terminalReason: 'gemini_selected_silence',
        ...(selectedTrace ? { timing: { ...selectedTrace.timing, decisionAt, completedAt: decisionAt } } : {}),
      });
      this.emitDecision({
        eventId: parsed.eventId, timestamp: decisionAt, selected: [], rejected: itemRejections,
        candidateCount: pending.candidateCount, silentCandidateCount: pending.candidateCount,
      });
      return { eventId: parsed.eventId, accepted: [], rejected: itemRejections };
    }

    const result = await this.options.policy.validateBatch({
      event: pending.event,
      reactions: parsed.reactions,
      permittedUsernames: pending.permittedUsernames,
      currentCandidates: this.options.candidates(),
      isDuplicate: (username, message) => this.options.history.isDuplicate(username, message),
    });
    const allRejections = [...itemRejections, ...result.rejected];
    for (const rejection of result.rejected) {
      this.options.usage.recordGuardRejection();
      this.logger.warn('Gemini reaction rejected by policy', { eventId: parsed.eventId, bot: rejection.username, reason: rejection.reason });
    }
    const policyCompletedAt = result.accepted.length === 0 ? this.now() : undefined;
    this.updateTrace(parsed.eventId, {
      stage: 'POLICY_VALIDATED',
      outcome: result.accepted.length > 0 ? 'PENDING' : 'FAILED',
      policyRejected: allRejections,
      reactions: result.accepted.map((plan) => ({
        username: plan.bot.username,
        message: plan.message,
        artificialDelayMs: plan.delayMs,
        status: 'ACCEPTED' as const,
        selectedAt: decisionAt,
      })),
      ...(selectedTrace ? {
        timing: {
          ...selectedTrace.timing,
          decisionAt,
          ...(policyCompletedAt !== undefined ? { completedAt: policyCompletedAt } : {}),
        },
      } : {}),
      ...(result.accepted.length === 0 ? { terminalReason: 'all_selected_reactions_rejected' } : {}),
    });
    for (const plan of result.accepted) {
      const viewerUsername = pending.viewerByUsername.get(plan.bot.username.toLowerCase());
      if (viewerUsername) plan.viewerUsername = viewerUsername;
      this.schedule(plan);
    }
    if (result.accepted.length === 0) this.options.usage.recordSkipped();
    const decision: ReactionDecisionRecord = {
      eventId: parsed.eventId,
      timestamp: decisionAt,
      selected: result.accepted.map((plan) => ({ username: plan.bot.username, message: plan.message, delayMs: plan.delayMs })),
      rejected: allRejections,
      candidateCount: pending.candidateCount,
      silentCandidateCount: Math.max(0, pending.candidateCount - parsed.reactions.length),
    };
    this.emitDecision(decision);
    this.logger.info('Gemini reaction batch validated', {
      eventId: parsed.eventId,
      selected: decision.selected.map((item) => item.username),
      rejected: decision.rejected.length,
    });
    return {
      eventId: parsed.eventId,
      accepted: result.accepted.map((plan) => ({ username: plan.bot.username, delayMs: plan.delayMs })),
      rejected: allRejections,
    };
  }

  clearPendingContexts(): void {
    for (const [eventId, pending] of this.pendingContexts) {
      clearTimeout(pending.timer);
      const trace = this.traces.get(eventId);
      this.updateTrace(eventId, {
        stage: 'STOPPED', outcome: 'FAILED', terminalReason: 'gemini_disconnected_before_reaction_batch',
        ...(trace ? { timing: { ...trace.timing, completedAt: this.now() } } : {}),
      });
    }
    this.pendingContexts.clear();
  }

  recordBrainDecision(
    eventId: string,
    metadata: { interactionId: string; previousInteractionId?: string; latencyMs: number },
  ): void {
    const trace = this.traces.get(eventId);
    if (!trace) return;
    const brainReadyAt = this.now();
    this.updateTrace(eventId, {
      brainInteractionId: metadata.interactionId,
      ...(metadata.previousInteractionId ? { brainPreviousInteractionId: metadata.previousInteractionId } : {}),
      brainPreviousInteractionUsed: Boolean(metadata.previousInteractionId),
      timing: {
        ...trace.timing,
        brainStartedAt: brainReadyAt - Math.max(0, metadata.latencyMs),
        brainReadyAt,
        brainLatencyMs: Math.max(0, metadata.latencyMs),
      },
    });
  }

  /** Builds the small delta sent to the stateful Brain. Full persona profiles live in bootstrap. */
  async prepareBrainEvent(event: StreamEvent, chatAfter: number, emittedAt = this.now()): Promise<BrainEventInput> {
    if (this.stopped) throw new Error('reaction_coordinator_stopped');
    const snapshot = this.options.contextStore.snapshot();
    this.options.memory.recordEvent(event, snapshot);
    const allCandidates = this.options.candidates();
    const eligibleCandidates = allCandidates
      .filter((candidate) => candidate.enabled && candidate.connectionState === 'CONNECTED' && candidate.chatConnected);
    const directTargets = new Set(event.directMentions.map((username) => username.toLowerCase()));
    const candidates = directTargets.size > 0
      ? eligibleCandidates.filter((candidate) => directTargets.has(candidate.username.toLowerCase()))
      : eligibleCandidates;
    const directTargetUnavailable = [...directTargets]
      .filter((username) => !candidates.some((candidate) => candidate.username.toLowerCase() === username))
      .map((username) => ({ username, reason: directTargetUnavailableReason(username, allCandidates) }));
    const trace: ReactionTraceRecord = {
      eventId: event.id,
      timestamp: event.timestamp,
      updatedAt: emittedAt,
      eventType: event.type,
      summary: event.summary,
      stage: 'EVENT_DETECTED',
      outcome: 'PENDING',
      eligibleBots: eligibleCandidates.length,
      eligibleUsernames: eligibleCandidates.map((candidate) => candidate.username),
      candidateCount: candidates.length,
      directMentions: [...event.directMentions],
      directTargetUnavailable,
      geminiSelected: [],
      policyAccepted: [],
      policyRejected: [],
      scheduled: [],
      sent: [],
      sendFailed: [],
      timing: { detectedAt: emittedAt },
      reactions: [],
    };
    this.traces.set(event.id, trace);
    this.emitTrace(trace);

    const targetedCandidates = directTargets.size > 0 ? candidates : [];
    const [histories, reactionExamples] = await Promise.all([
      Promise.all(targetedCandidates.map((candidate) => this.options.history.recent(candidate.username))),
      this.options.memory.retrieve(event, snapshot, Math.min(3, this.options.retrievalLimit)),
    ]);
    const viewerByUsername = new Map<string, string>();
    const targetedPersonaContext = await Promise.all(targetedCandidates.map(async (candidate, index) => {
      const viewerUsername = event.viewerUsername?.toLowerCase()
        ?? (event.source === 'chat' ? directViewerFor(snapshot.recentChat, candidate.username, event.timestamp) : undefined);
      if (viewerUsername) viewerByUsername.set(candidate.username.toLowerCase(), viewerUsername);
      const context = await this.options.personaContext.build({
        username: candidate.username,
        persona: candidate.persona,
        event,
        recentMessages: (histories[index] ?? []).slice(-20).map((record) => record.message),
        directMention: true,
        ...(viewerUsername ? { viewerUsername } : {}),
        recentChat: snapshot.recentChat,
      });
      return {
        username: context.username,
        relevantCanon: context.relevantCanon,
        relevantMemories: context.relevantMemories,
        recentConversation: context.recentConversation,
        recentMessages: context.recentMessages,
        personalResponseGuidance: context.personalResponseGuidance,
      };
    }));
    const contextReadyAt = this.now();
    const expiresAt = contextReadyAt + this.contextTtlMs;
    this.removePending(event.id);
    const timer = setTimeout(() => this.expirePending(event.id), this.contextTtlMs);
    this.pendingContexts.set(event.id, {
      event,
      expiresAt,
      timer,
      permittedUsernames: new Set(candidates.map((candidate) => candidate.username.toLowerCase())),
      candidateCount: candidates.length,
      viewerByUsername,
    });
    this.options.usage.recordReactionContextPrepared();
    this.updateTrace(event.id, {
      stage: 'CANDIDATES_PREPARED',
      timing: { ...trace.timing, contextReadyAt },
    });
    return {
      event,
      availableBots: candidates.map((candidate) => candidate.username),
      recentChatDelta: snapshot.recentChat
        .filter((message) => message.timestamp > chatAfter)
        .slice(-40)
        .map(({ timestamp, username, message, kind }) => ({ timestamp, username, message, kind })),
      targetedPersonaContext,
      reactionExamples: reactionExamples.slice(0, 3),
      deltas: [],
      constraints: {
        maxReactions: this.options.policy.maxReactions(),
        maxMessageBytes: this.options.policy.maxMessageBytes(),
        globalSlotsAvailable: this.options.policy.globalSlotsAvailable(),
        expiresAt,
      },
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearPendingContexts();
    for (const [timer, plan] of this.timers) {
      clearTimeout(timer);
      this.options.policy.releaseReservation(plan.reservationId);
      this.recordSendFailure(plan.event.id, plan.bot.username, 'coordinator_stopped');
    }
    this.timers.clear();
  }

  private schedule(plan: PlannedReaction): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.execute(plan);
    }, plan.delayMs);
    this.timers.set(timer, plan);
    const scheduledAt = this.now();
    const trace = this.traces.get(plan.event.id);
    this.updateTrace(plan.event.id, {
      stage: 'SCHEDULED',
      outcome: 'SCHEDULED',
      reactions: (trace?.reactions ?? []).map((reaction) => reaction.username === plan.bot.username
        ? { ...reaction, status: 'SCHEDULED' as const, scheduledAt }
        : reaction),
    });
    this.logger.info('Bot reaction queued', { bot: plan.bot.username, eventId: plan.event.id, delayMs: plan.delayMs });
  }

  private async execute(plan: PlannedReaction): Promise<void> {
    this.logger.info('Reaction scheduler fired', { bot: plan.bot.username, eventId: plan.event.id });
    try {
      const current = this.options.candidates().find((candidate) => candidate.username === plan.bot.username);
      if (!current?.enabled || current.connectionState !== 'CONNECTED' || !current.chatConnected) {
        this.options.usage.recordSkipped();
        this.recordSendFailure(plan.event.id, plan.bot.username, 'account_unavailable_at_send');
        return;
      }
      if (current.persona.id !== plan.bot.persona.id) {
        this.options.usage.recordSkipped();
        this.options.usage.recordGuardRejection();
        this.recordSendFailure(plan.event.id, plan.bot.username, 'persona_reassigned');
        this.logger.warn('Queued reaction cancelled after persona reassignment', {
          bot: current.username,
          eventId: plan.event.id,
          plannedPersonaId: plan.bot.persona.id,
          currentPersonaId: current.persona.id,
        });
        return;
      }
      if (await this.options.history.isDuplicate(current.username, plan.message)) {
        this.options.usage.recordSkipped();
        this.options.usage.recordGuardRejection();
        this.recordSendFailure(plan.event.id, plan.bot.username, 'recent_duplicate_at_send');
        return;
      }
      const sendResult = await this.options.sender.send(current.username, plan.message);
      if (!sendResult.submitted) {
        this.options.usage.recordSkipped();
        this.recordSendFailure(plan.event.id, plan.bot.username, sendResult.reason);
        return;
      }
      const sentAt = sendResult.submittedAt;
      this.recordSendSuccess(plan.event.id, current.username, sentAt);
      this.logger.info('Bot reaction submitted to Twitch', { bot: current.username, eventId: plan.event.id, message: plan.message });
      try {
        this.options.policy.recordSent(sentAt, plan.reservationId);
        this.options.usage.recordSentResponse();
        this.options.personaRuntime.recordSent(current.persona.id);
        await this.options.history.add(current.username, plan.message, plan.event.id);
        if (plan.viewerUsername) {
          await this.options.personaMemory.addConversation({
            personaId: current.persona.id,
            viewerUsername: plan.viewerUsername,
            role: 'persona',
            message: plan.message,
          });
        }
      } catch (cause) {
        this.logger.warn('Post-send reaction bookkeeping failed', {
          bot: current.username,
          eventId: plan.event.id,
          cause,
        });
      }
    } catch (cause) {
      this.options.usage.recordSkipped();
      this.recordSendFailure(plan.event.id, plan.bot.username, safeErrorReason(cause));
      this.logger.warn('Queued bot reaction failed', { bot: plan.bot.username, eventId: plan.event.id, cause });
    } finally {
      this.options.policy.releaseReservation(plan.reservationId);
    }
  }

  private removePending(eventId: string): void {
    const pending = this.pendingContexts.get(eventId);
    if (pending) clearTimeout(pending.timer);
    this.pendingContexts.delete(eventId);
  }

  private expirePending(eventId: string): void {
    this.removePending(eventId);
    const trace = this.traces.get(eventId);
    this.updateTrace(eventId, {
      stage: 'STOPPED', outcome: 'FAILED', terminalReason: 'reaction_context_expired_before_gemini_batch',
      ...(trace ? { timing: { ...trace.timing, completedAt: this.now() } } : {}),
    });
  }

  private recordSendSuccess(eventId: string, username: string, sentAt = this.now()): void {
    const trace = this.traces.get(eventId);
    if (!trace) return;
    const reactions = trace.reactions.map((reaction) => reaction.username === username
      ? { ...reaction, status: 'SENT' as const, sentAt }
      : reaction);
    const completed = reactions.every((reaction) => reaction.status === 'SENT' || reaction.status === 'FAILED');
    const anyFailure = reactions.some((reaction) => reaction.status === 'FAILED');
    this.updateTrace(eventId, {
      stage: 'SEND_SUCCEEDED',
      outcome: completed ? (anyFailure ? 'PARTIAL' : 'SENT') : 'SCHEDULED',
      reactions,
      timing: completed ? { ...trace.timing, completedAt: sentAt } : trace.timing,
      ...(completed ? {
        terminalReason: anyFailure ? 'some_reactions_failed' : undefined,
      } : {}),
    });
  }

  private recordSendFailure(eventId: string, username: string, reason: string): void {
    const trace = this.traces.get(eventId);
    if (!trace) return;
    const failedAt = this.now();
    const reactions = trace.reactions.map((reaction) => reaction.username === username
      ? { ...reaction, status: 'FAILED' as const, failedAt, failureReason: reason }
      : reaction);
    const completed = reactions.every((reaction) => reaction.status === 'SENT' || reaction.status === 'FAILED');
    const anySent = reactions.some((reaction) => reaction.status === 'SENT');
    this.updateTrace(eventId, {
      stage: 'SEND_FAILED',
      outcome: completed ? (anySent ? 'PARTIAL' : 'FAILED') : 'SCHEDULED',
      reactions,
      timing: completed ? { ...trace.timing, completedAt: failedAt } : trace.timing,
      terminalReason: completed && anySent ? 'some_reactions_failed' : reason,
    });
  }

  private updateTrace(eventId: string, patch: Partial<ReactionTraceRecord>): void {
    const current = this.traces.get(eventId);
    if (!current) return;
    const updated = withLegacyReactionState({ ...current, ...patch, updatedAt: this.now() });
    this.traces.set(eventId, updated);
    this.emitTrace(updated);
    this.logger.info('Reaction trace advanced', {
      eventId,
      stage: updated.stage,
      outcome: updated.outcome,
      eligibleBots: updated.eligibleBots,
      candidateCount: updated.candidateCount,
      geminiSelected: updated.geminiSelected.length,
      policyAccepted: updated.policyAccepted.length,
      policyRejected: updated.policyRejected.length,
      scheduled: updated.scheduled.length,
      sent: updated.sent.length,
      sendFailed: updated.sendFailed.length,
      terminalReason: updated.terminalReason,
    });
  }

  private emitDecision(decision: ReactionDecisionRecord): void { this.emit('decision', decision); }
  private emitTrace(trace: ReactionTraceRecord): void {
    this.emit('trace', {
      ...trace,
      eligibleUsernames: [...trace.eligibleUsernames],
      directMentions: [...trace.directMentions],
      directTargetUnavailable: trace.directTargetUnavailable.map((item) => ({ ...item })),
      geminiSelected: [...trace.geminiSelected],
      policyAccepted: [...trace.policyAccepted],
      policyRejected: trace.policyRejected.map((item) => ({ ...item })),
      scheduled: [...trace.scheduled],
      sent: [...trace.sent],
      sendFailed: trace.sendFailed.map((item) => ({ ...item })),
      timing: { ...trace.timing },
      reactions: trace.reactions.map((reaction) => ({ ...reaction })),
    } satisfies ReactionTraceRecord);
  }
}

function rawUsername(value: unknown, index: number): string {
  if (value && typeof value === 'object' && 'username' in value && typeof value.username === 'string') {
    return value.username.trim().toLowerCase() || `item-${index + 1}`;
  }
  return `item-${index + 1}`;
}

function directViewerFor(chat: Array<{ timestamp: number; username: string; message: string; kind: string }>, botUsername: string, eventTimestamp: number): string | undefined {
  const mention = new RegExp(`@${escapeRegex(botUsername)}\\b`, 'i');
  return [...chat].reverse().find((message) =>
    message.kind === 'viewer'
    && Math.abs(eventTimestamp - message.timestamp) <= 2 * 60_000
    && mention.test(message.message))?.username.toLowerCase();
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function withLegacyReactionState(trace: ReactionTraceRecord): ReactionTraceRecord {
  return {
    ...trace,
    policyAccepted: trace.reactions.map((reaction) => reaction.username),
    scheduled: trace.reactions
      .filter((reaction) => reaction.status !== 'ACCEPTED')
      .map((reaction) => reaction.username),
    sent: trace.reactions
      .filter((reaction) => reaction.status === 'SENT')
      .map((reaction) => reaction.username),
    sendFailed: trace.reactions
      .filter((reaction) => reaction.status === 'FAILED')
      .map((reaction) => ({
        username: reaction.username,
        reason: reaction.failureReason ?? 'unknown_send_error',
      })),
  };
}

function directTargetUnavailableReason(
  username: string,
  candidates: ReactionBotCandidate[],
): 'unknown_bot' | 'disabled' | 'not_connected' | 'chat_disconnected' {
  const candidate = candidates.find((item) => item.username.toLowerCase() === username);
  if (!candidate) return 'unknown_bot';
  if (!candidate.enabled) return 'disabled';
  if (candidate.connectionState !== 'CONNECTED') return 'not_connected';
  return 'chat_disconnected';
}

function safeErrorReason(cause: unknown): string {
  if (cause instanceof Error) return cause.message.slice(0, 160) || cause.name;
  return 'unknown_send_error';
}
