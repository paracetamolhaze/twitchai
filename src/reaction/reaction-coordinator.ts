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
import { UsageTracker } from '../usage/usage-tracker';
import { REACTION_NATURALNESS_INSTRUCTIONS } from './natural-writing-policy';
import { ReactionPolicyGuard } from './reaction-policy-guard';
import {
  PlannedReaction,
  PreparedReactionContext,
  ReactionBatch,
  ReactionBatchResult,
  ReactionBotCandidate,
  ReactionDecisionRecord,
  ReactionRejection,
  ReactionTraceRecord,
  REACTION_BATCH_PROTOCOL_MAX_ITEMS,
  REACTION_MESSAGE_PROTOCOL_MAX_CHARACTERS,
  SubmittedReaction,
} from './types';

export interface ReactionSender {
  send(username: string, message: string): Promise<boolean>;
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

  async prepare(event: StreamEvent): Promise<PreparedReactionContext> {
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
      updatedAt: this.now(),
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
    };
    this.traces.set(event.id, trace);
    this.emitTrace(trace);
    this.logger.info('Reaction trace: event detected', {
      eventId: event.id,
      eligibleBots: eligibleCandidates.length,
      candidateCount: candidates.length,
      directTargetUnavailable,
    });
    const [histories, reactionExamples, globalStreamerMemories] = await Promise.all([
      Promise.all(candidates.map((candidate) => this.options.history.recent(candidate.username))),
      this.options.memory.retrieve(event, snapshot, this.options.retrievalLimit),
      this.options.globalMemory.retrieve({
        channel: snapshot.channel,
        query: globalMemoryQuery(event, snapshot.streamContext, snapshot.recentChat),
        entities: event.directMentions,
        tags: [event.type, event.category ?? snapshot.category].filter((value): value is string => Boolean(value?.trim())),
      }),
    ]);
    const viewerByUsername = new Map<string, string>();
    const personaContexts = await Promise.all(candidates.map((candidate, index) => {
      const directMention = directTargets.has(candidate.username.toLowerCase());
      const viewerUsername = directMention
        ? event.viewerUsername?.toLowerCase()
          ?? (event.source === 'chat' ? directViewerFor(snapshot.recentChat, candidate.username, event.timestamp) : undefined)
        : undefined;
      if (viewerUsername) viewerByUsername.set(candidate.username.toLowerCase(), viewerUsername);
      return this.options.personaContext.build({
        username: candidate.username,
        persona: candidate.persona,
        event,
        recentMessages: (histories[index] ?? []).slice(-20).map((record) => record.message),
        directMention,
        ...(viewerUsername ? { viewerUsername } : {}),
        recentChat: snapshot.recentChat,
      });
    }));
    const expiresAt = this.now() + this.contextTtlMs;
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
    this.updateTrace(event.id, { stage: 'CANDIDATES_PREPARED' });
    return {
      eventId: event.id,
      event,
      recentChat: snapshot.recentChat.slice(-40),
      globalStreamerMemories,
      candidates: candidates.map((candidate, index) => ({
        ...personaContexts[index]!,
        rateLimit: this.options.policy.candidateRateLimit(candidate),
      })),
      reactionExamples,
      constraints: {
        maxReactions: this.options.policy.maxReactions(),
        maxMessageBytes: this.options.policy.maxMessageBytes(),
        globalSlotsAvailable: this.options.policy.globalSlotsAvailable(),
        expiresAt,
        instructions: [
          'Return one emit_reaction_batch call for this event, including zero reactions when silence is more natural.',
          ...REACTION_NATURALNESS_INSTRUCTIONS,
          'Never copy recent chat or memory examples verbatim, and keep reactions semantically distinct.',
          'Trust order: safety rules > supplied behavioral context and targeted canonical facts > current stream event > relevant memory > own message history > Twitch chat > reaction examples.',
          'Background shapes behavior. Do not expose biographical facts without a direct or genuinely relevant conversational reason; concise factual replies are preferred.',
          'For account-classification questions, silence is preferred. A short non-factual character-consistent deflection is optional; never claim to be human or discuss hidden operation.',
        ],
      },
    };
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
    this.updateTrace(parsed.eventId, {
      stage: 'GEMINI_SELECTED',
      geminiSelected: envelope.reactions.map((reaction, index) => rawUsername(reaction, index)),
    });
    if (!pending || pending.expiresAt <= this.now()) {
      this.removePending(parsed.eventId);
      this.options.usage.recordGuardRejection();
      this.updateTrace(parsed.eventId, { stage: 'STOPPED', outcome: 'STALE', terminalReason: 'reaction_context_stale' });
      return { eventId: parsed.eventId, accepted: [], rejected: itemRejections, stale: true };
    }
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
      });
      this.emitDecision({
        eventId: parsed.eventId, timestamp: this.now(), selected: [], rejected: itemRejections,
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
    this.updateTrace(parsed.eventId, {
      stage: 'POLICY_VALIDATED',
      outcome: result.accepted.length > 0 ? 'PENDING' : 'FAILED',
      policyAccepted: result.accepted.map((plan) => plan.bot.username),
      policyRejected: allRejections,
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
      timestamp: this.now(),
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
      this.updateTrace(eventId, {
        stage: 'STOPPED', outcome: 'FAILED', terminalReason: 'gemini_disconnected_before_reaction_batch',
      });
    }
    this.pendingContexts.clear();
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
    const trace = this.traces.get(plan.event.id);
    this.updateTrace(plan.event.id, {
      stage: 'SCHEDULED',
      outcome: 'SCHEDULED',
      scheduled: appendUnique(trace?.scheduled ?? [], plan.bot.username),
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
      const sent = await this.options.sender.send(current.username, plan.message);
      if (!sent) {
        this.options.usage.recordSkipped();
        this.recordSendFailure(plan.event.id, plan.bot.username, 'twitch_sender_returned_false');
        return;
      }
      await this.options.history.add(current.username, plan.message, plan.event.id);
      this.options.personaRuntime.recordSent(current.persona.id);
      if (plan.viewerUsername) {
        await this.options.personaMemory.addConversation({
          personaId: current.persona.id,
          viewerUsername: plan.viewerUsername,
          role: 'persona',
          message: plan.message,
        });
      }
      if (plan.event.importance >= 0.7) {
        await this.options.personaMemory.remember({
          personaId: current.persona.id,
          type: 'stream_event',
          summary: `Персона отреагировала на событие: ${plan.event.summary}`,
          importance: plan.event.importance,
          tags: [plan.event.type, plan.event.gameContext ?? ''].filter(Boolean),
          eventId: plan.event.id,
        });
      }
      this.options.policy.recordSent(this.now(), plan.reservationId);
      this.options.usage.recordSentResponse();
      this.recordSendSuccess(plan.event.id, current.username);
      this.logger.info('Bot reaction sent', { bot: current.username, eventId: plan.event.id, message: plan.message });
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
    this.updateTrace(eventId, {
      stage: 'STOPPED', outcome: 'FAILED', terminalReason: 'reaction_context_expired_before_gemini_batch',
    });
  }

  private recordSendSuccess(eventId: string, username: string): void {
    const trace = this.traces.get(eventId);
    if (!trace) return;
    const sent = appendUnique(trace.sent, username);
    const completed = sent.length + trace.sendFailed.length >= trace.scheduled.length;
    this.updateTrace(eventId, {
      stage: 'SEND_SUCCEEDED',
      sent,
      outcome: completed ? (trace.sendFailed.length > 0 ? 'PARTIAL' : 'SENT') : 'SCHEDULED',
      ...(completed ? { terminalReason: undefined } : {}),
    });
  }

  private recordSendFailure(eventId: string, username: string, reason: string): void {
    const trace = this.traces.get(eventId);
    if (!trace) return;
    const sendFailed = trace.sendFailed.some((item) => item.username === username)
      ? trace.sendFailed
      : [...trace.sendFailed, { username, reason }];
    const completed = trace.sent.length + sendFailed.length >= trace.scheduled.length;
    this.updateTrace(eventId, {
      stage: 'SEND_FAILED',
      sendFailed,
      outcome: completed ? (trace.sent.length > 0 ? 'PARTIAL' : 'FAILED') : 'SCHEDULED',
      terminalReason: reason,
    });
  }

  private updateTrace(eventId: string, patch: Partial<ReactionTraceRecord>): void {
    const current = this.traces.get(eventId);
    if (!current) return;
    const updated = { ...current, ...patch, updatedAt: this.now() };
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
    } satisfies ReactionTraceRecord);
  }
}

function globalMemoryQuery(
  event: StreamEvent,
  streamContext: string,
  recentChat: Array<{ message: string }>,
): string {
  return [
    event.summary,
    event.speech,
    event.visualContext,
    event.gameContext,
    event.category,
    streamContext,
    ...recentChat.slice(-12).map((message) => message.message),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n');
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

function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
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
