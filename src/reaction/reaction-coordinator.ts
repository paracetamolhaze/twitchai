import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { Logger } from '../logger';
import { ReactionMemory } from '../learning/reaction-memory';
import { BotHistory } from '../personas/bot-history';
import { ContextStore } from '../stream-brain/context-store';
import { StreamEvent } from '../stream-brain/types';
import { UsageTracker } from '../usage/usage-tracker';
import { ReactionPolicyGuard } from './reaction-policy-guard';
import {
  PlannedReaction,
  PreparedReactionContext,
  ReactionBatch,
  ReactionBatchResult,
  ReactionBotCandidate,
  ReactionDecisionRecord,
  ReactionRejection,
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
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const batchEnvelopeSchema = z.object({
  eventId: z.string().trim().min(1).max(100),
  reactions: z.array(z.unknown()).max(REACTION_BATCH_PROTOCOL_MAX_ITEMS),
}).strict();
const reactionItemSchema = z.object({
  username: z.string().trim().min(1).max(50),
  message: z.string().max(REACTION_MESSAGE_PROTOCOL_MAX_CHARACTERS),
}).strict();

export class ReactionCoordinator extends EventEmitter {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly contextTtlMs: number;
  private readonly timers = new Map<NodeJS.Timeout, PlannedReaction>();
  private readonly pendingContexts = new Map<string, PendingContext>();
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
    const candidates = this.options.candidates()
      .filter((candidate) => candidate.enabled && candidate.connectionState === 'CONNECTED' && candidate.chatConnected);
    const [histories, reactionExamples] = await Promise.all([
      Promise.all(candidates.map((candidate) => this.options.history.recent(candidate.username))),
      this.options.memory.retrieve(event, snapshot, this.options.retrievalLimit),
    ]);
    const expiresAt = this.now() + this.contextTtlMs;
    this.removePending(event.id);
    const timer = setTimeout(() => this.removePending(event.id), this.contextTtlMs);
    this.pendingContexts.set(event.id, {
      event,
      expiresAt,
      timer,
      permittedUsernames: new Set(candidates.map((candidate) => candidate.username.toLowerCase())),
      candidateCount: candidates.length,
    });
    this.options.usage.recordReactionContextPrepared();
    return {
      eventId: event.id,
      event,
      recentChat: snapshot.recentChat.slice(-40),
      candidates: candidates.map((candidate, index) => ({
        username: candidate.username,
        persona: candidate.persona,
        recentMessages: (histories[index] ?? []).slice(-20).map((record) => record.message),
        directMention: event.directMentions.includes(candidate.username.toLowerCase()),
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
          'Use only candidate usernames, never copy recent chat or memory examples verbatim, and keep reactions semantically distinct.',
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
    if (!pending || pending.expiresAt <= this.now()) {
      this.removePending(parsed.eventId);
      this.options.usage.recordGuardRejection();
      return { eventId: parsed.eventId, accepted: [], rejected: itemRejections, stale: true };
    }
    this.removePending(parsed.eventId);
    this.options.usage.recordGenerated(parsed.reactions.length);
    itemRejections.forEach(() => this.options.usage.recordGuardRejection());
    if (parsed.reactions.length === 0) {
      this.options.usage.recordEmptyReactionBatch();
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
    for (const plan of result.accepted) this.schedule(plan);
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
    for (const pending of this.pendingContexts.values()) clearTimeout(pending.timer);
    this.pendingContexts.clear();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearPendingContexts();
    for (const [timer, plan] of this.timers) {
      clearTimeout(timer);
      this.options.policy.releaseReservation(plan.reservationId);
    }
    this.timers.clear();
  }

  private schedule(plan: PlannedReaction): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.execute(plan);
    }, plan.delayMs);
    this.timers.set(timer, plan);
    this.logger.info('Bot reaction queued', { bot: plan.bot.username, eventId: plan.event.id, delayMs: plan.delayMs });
  }

  private async execute(plan: PlannedReaction): Promise<void> {
    try {
      const current = this.options.candidates().find((candidate) => candidate.username === plan.bot.username);
      if (!current?.enabled || current.connectionState !== 'CONNECTED' || !current.chatConnected) {
        this.options.usage.recordSkipped();
        return;
      }
      if (await this.options.history.isDuplicate(current.username, plan.message)) {
        this.options.usage.recordSkipped();
        this.options.usage.recordGuardRejection();
        return;
      }
      const sent = await this.options.sender.send(current.username, plan.message);
      if (!sent) {
        this.options.usage.recordSkipped();
        return;
      }
      await this.options.history.add(current.username, plan.message, plan.event.id);
      this.options.policy.recordSent(Date.now(), plan.reservationId);
      this.options.usage.recordSentResponse();
      this.logger.info('Bot reaction sent', { bot: current.username, eventId: plan.event.id, message: plan.message });
    } catch (cause) {
      this.options.usage.recordSkipped();
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

  private emitDecision(decision: ReactionDecisionRecord): void { this.emit('decision', decision); }
}

function rawUsername(value: unknown, index: number): string {
  if (value && typeof value === 'object' && 'username' in value && typeof value.username === 'string') {
    return value.username.trim().toLowerCase() || `item-${index + 1}`;
  }
  return `item-${index + 1}`;
}
