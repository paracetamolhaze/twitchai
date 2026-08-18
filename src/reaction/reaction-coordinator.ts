import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { Logger } from '../logger';
import { ReactionMemory } from '../learning/reaction-memory';
import { GlobalStreamerMemory } from '../global-memory/global-streamer-memory';
import { BotHistory } from '../personas/bot-history';
import { PersonaContextBuilder } from '../personas/persona-context-builder';
import { PersonaMemory, relevanceScore, semanticTokens } from '../personas/persona-memory';
import { PersonaRuntimeStore } from '../personas/persona-runtime-store';
import { ContextStore } from '../stream-brain/context-store';
import { StreamEvent } from '../stream-brain/types';
import { BrainEventInput, FIRST_MESSAGE_GATE } from '../brain/types';
import { UsageTracker } from '../usage/usage-tracker';
import { NaturalnessGuard, NaturalnessInput } from './naturalness-guard';
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
  ReactionTrigger,
  REACTION_BATCH_PROTOCOL_MAX_ITEMS,
  REACTION_MESSAGE_PROTOCOL_MAX_CHARACTERS,
  SubmittedReaction,
  triggerId,
} from './types';

export interface ReactionSender {
  send(username: string, message: string): Promise<ReactionSendResult>;
}

export interface ReactionCoordinatorOptions {
  policy: ReactionPolicyGuard;
  /**
   * Runs before the policy guard on purpose. A message with no reaction in it should not consume a
   * rate-limit reservation or an account's cooldown on its way to being dropped, and the policy
   * guard's job — length, duplicates, dashes, who may speak — is a different question from whether
   * this is a reaction at all. Optional so existing wiring keeps working without it.
   */
  naturalness?: NaturalnessGuard;
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
  /** Per-account record of what the channel actually shows, kept from real traffic. */
  onDelivery?: (outcome: { username: string; result: 'sent' | 'shown' | 'hidden'; reason?: string }) => void;
  /**
   * Whether this logical stream session has yet to put a message in chat. While true the decision
   * payload carries an extra condition, because the first thing these accounts say is the one line
   * with no established voice behind it and the one most likely to come out as a default.
   */
  isColdStart?: () => boolean;
  /** Called once a message has actually reached Twitch, which is what retires the gate. */
  onMessageSent?: () => void;
  /** How long to wait for a sent message to echo back from Twitch before calling it undelivered. */
  deliveryEchoTimeoutMs?: number;
  /**
   * Whether chat is currently being observed. Delivery can only be judged while some account is
   * reading the channel; without one nothing would ever confirm and every message would be
   * reported undelivered. Absent means never judge.
   */
  observesChat?: () => boolean;
  now?: () => number;
}

interface PendingDelivery {
  eventId: string;
  username: string;
  sentAt: number;
  timer: NodeJS.Timeout;
}

/** Normalized so an echo differing only in whitespace still counts as the same message. */
function deliveryKey(username: string, message: string): string {
  return `${username.toLowerCase()}::${message.replace(/\s+/g, ' ').trim()}`;
}

interface PendingContext {
  trigger: ReactionTrigger;
  /**
   * What the naturalness guard compares a generated message against. For an observed moment that is
   * the event; a drive opportunity has no event of its own, so it supplies the newest thing the
   * session heard — otherwise a spontaneous message would be the one path with no check on it.
   */
  naturalnessEvent?: NaturalnessInput['event'];
  permittedUsernames: Set<string>;
  candidateCount: number;
  viewerByUsername: Map<string, string>;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

/**
 * Running totals for one stream, so a finished session can be read as a few numbers instead of
 * four hundred log lines. Everything here is a count of something the decision path already does;
 * none of it changes behaviour.
 */
interface SessionDecisionStats {
  events: number;
  eventsWithoutCandidate: number;
  eligibleSum: number;
  candidateSum: number;
  excludedByCooldown: number;
  /**
   * Counted per mechanism, because the two are meant to be compared and a combined total made that
   * a subtraction. Reading the last run took working out that 24 of 30 decisions were stream events
   * and 17 of 23 silences belonged to them.
   */
  byTrigger: Record<'stream_event' | 'persona_drive', { decisions: number; silent: number; selected: number }>;
  rejectedReactions: number;
  attention: Record<'notices' | 'passes over' | 'no strong pattern', number>;
  /**
   * How much the naturalness guard saw and how much it dropped, by class. The number that matters
   * next run is the ratio: a guard rejecting a message here and there is doing its job, and one
   * rejecting a third of everything generated has a class that is too wide.
   */
  naturalnessChecked: number;
  naturalnessRejected: Record<'semantic_echo' | 'borrowed_opinion' | 'generic_evaluator', number>;
  naturalnessGuardMs: number;
}

function emptySessionStats(): SessionDecisionStats {
  return {
    events: 0, eventsWithoutCandidate: 0, eligibleSum: 0, candidateSum: 0, excludedByCooldown: 0,
    byTrigger: {
      stream_event: { decisions: 0, silent: 0, selected: 0 },
      persona_drive: { decisions: 0, silent: 0, selected: 0 },
    },
    rejectedReactions: 0,
    attention: { notices: 0, 'passes over': 0, 'no strong pattern': 0 },
    naturalnessChecked: 0,
    naturalnessRejected: { semantic_echo: 0, borrowed_opinion: 0, generic_evaluator: 0 },
    naturalnessGuardMs: 0,
  };
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
  private readonly pendingDeliveries = new Map<string, PendingDelivery>();
  private readonly deliveryEchoTimeoutMs: number;
  private readonly traces = new Map<string, ReactionTraceRecord>();
  private session = emptySessionStats();
  private stopped = false;

  constructor(private readonly options: ReactionCoordinatorOptions) {
    super();
    this.logger = options.logger.child('DECISION');
    this.now = options.now ?? Date.now;
    this.contextTtlMs = options.contextTtlMs ?? 45_000;
    this.deliveryEchoTimeoutMs = options.deliveryEchoTimeoutMs ?? 10_000;
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
      const silentDecision: ReactionDecisionRecord = {
        eventId: parsed.eventId, timestamp: decisionAt, selected: [], rejected: itemRejections,
        candidateCount: pending.candidateCount, silentCandidateCount: pending.candidateCount,
      };
      this.emitDecision(silentDecision);
      // Silence used to leave no line at all, so the only evidence a moment had been considered
      // and passed over was a trace stage; reading a quiet stream meant reconstructing it from
      // outcome codes. A deliberate silence is a decision and gets the same line as any other.
      this.logDecision(pending, silentDecision);
      return { eventId: parsed.eventId, accepted: [], rejected: itemRejections };
    }

    // Naturalness first: what survives here is what the policy guard is then asked to schedule.
    const naturalnessStartedAt = this.now();
    const naturalnessRejections: ReactionRejection[] = [];
    const natural = this.options.naturalness
      ? parsed.reactions.filter((reaction) => {
        const verdict = this.options.naturalness!.check({
          message: reaction.message,
          ...(pending.naturalnessEvent ? { event: pending.naturalnessEvent } : {}),
        });
        if (verdict.ok) return true;
        const username = reaction.username.trim().toLowerCase();
        naturalnessRejections.push({ username, reason: verdict.reason! });
        this.session.naturalnessRejected[verdict.reason!] += 1;
        this.logger.info('Reaction dropped as commentary rather than reaction', {
          eventId: parsed.eventId, bot: username, reason: verdict.reason, text: reaction.message,
        });
        return false;
      })
      : parsed.reactions;
    this.session.naturalnessChecked += parsed.reactions.length;
    this.session.naturalnessGuardMs += this.now() - naturalnessStartedAt;
    naturalnessRejections.forEach(() => this.options.usage.recordGuardRejection());

    const result = await this.options.policy.validateBatch({
      trigger: pending.trigger,
      reactions: natural,
      permittedUsernames: pending.permittedUsernames,
      currentCandidates: this.options.candidates(),
      isDuplicate: (username, message) => this.options.history.isDuplicate(username, message),
    });
    const allRejections = [...itemRejections, ...naturalnessRejections, ...result.rejected];
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
    this.logDecision(pending, decision);
    return {
      eventId: parsed.eventId,
      accepted: result.accepted.map((plan) => ({ username: plan.bot.username, delayMs: plan.delayMs })),
      rejected: allRejections,
    };
  }

  /**
   * One line that answers "why did this moment produce what it produced" without exposing the
   * model's private reasoning: what kind of trigger it was, who could have spoken, who did, how
   * many stayed silent, whether anything was thrown away, and how old the moment was by then.
   */
  private logDecision(pending: PendingContext, decision: ReactionDecisionRecord): void {
    const trigger = pending.trigger;
    const tally = this.session.byTrigger[trigger.kind];
    tally.decisions += 1;
    tally.selected += decision.selected.length;
    if (decision.selected.length === 0) tally.silent += 1;
    this.session.rejectedReactions += decision.rejected.length;
    this.logger.info('Gemini reaction batch validated', {
      eventId: decision.eventId,
      triggerKind: trigger.kind,
      // Whether this decision was made before this session had said anything. A silent decision
      // taken under it is not proof the gate caused the silence, but without the flag a quiet cold
      // start and a quiet stream read identically afterwards.
      coldStartGateActive: this.options.isColdStart?.() ?? false,
      candidates: pending.candidateCount,
      selected: decision.selected.map((item) => item.username),
      silent: decision.silentCandidateCount,
      rejected: decision.rejected.length,
      ...(decision.rejected.length > 0
        ? { rejectedReasons: [...new Set(decision.rejected.map((item) => item.reason))] }
        : {}),
      ...(trigger.kind === 'stream_event'
        ? {
          eventType: trigger.event.type,
          directMention: trigger.event.directMentions.length > 0,
          importance: trigger.event.importance,
          eventAgeMs: this.now() - trigger.event.timestamp,
          allowedReactions: this.options.policy.maxReactionsFor(pending.candidateCount, trigger.event.importance),
          // Who the speech was aimed at, and whether the account could have been grounded in
          // anything at all. A message answering game comms or inventing a menu path is only
          // diagnosable after the fact if the log says what perception thought it was hearing.
          ...(trigger.event.audience ? { audience: trigger.event.audience } : {}),
          ...(trigger.event.audienceConfidence !== undefined
            ? { audienceConfidence: trigger.event.audienceConfidence }
            : {}),
          grounding: groundingOf(trigger.event),
        }
        : {}),
    });
  }

  /**
   * The whole session as one line, emitted when a stream ends.
   *
   * Reading the last run meant pulling five hundred log lines and counting by hand to find that
   * thirty-one moments had produced five messages. These are the numbers that answer why: how many
   * moments there were, how many accounts each one could actually have used, what the cooldown took
   * away before anyone decided, and how the decisions split between speaking and silence.
   */
  logSessionSummary(reason: string): void {
    const stats = this.session;
    const drive = this.options.usage.snapshot().currentStream.drive;
    const events = stats.byTrigger.stream_event;
    const driven = stats.byTrigger.persona_drive;
    this.session = emptySessionStats();
    if (stats.events === 0 && events.decisions + driven.decisions === 0) return;
    const average = (total: number, count: number): number =>
      (count === 0 ? 0 : Number((total / count).toFixed(2)));
    this.logger.info('Stream decision summary', {
      reason,
      events: stats.events,
      eventsWithoutCandidate: stats.eventsWithoutCandidate,
      averageEligible: average(stats.eligibleSum, stats.events),
      averageCandidates: average(stats.candidateSum, stats.events),
      excludedByCooldown: stats.excludedByCooldown,
      // Each mechanism on its own line, so how often either one speaks is read rather than derived.
      streamEventDecisions: events.decisions,
      streamEventSilent: events.silent,
      streamEventSelected: events.selected,
      personaDriveDecisions: driven.decisions,
      personaDriveSilent: driven.silent,
      personaDriveSelected: driven.selected,
      rejectedReactions: stats.rejectedReactions,
      naturalnessChecked: stats.naturalnessChecked,
      naturalnessRejected: stats.naturalnessRejected.semantic_echo
        + stats.naturalnessRejected.borrowed_opinion + stats.naturalnessRejected.generic_evaluator,
      naturalnessSemanticEcho: stats.naturalnessRejected.semantic_echo,
      naturalnessBorrowedOpinion: stats.naturalnessRejected.borrowed_opinion,
      naturalnessGenericEvaluator: stats.naturalnessRejected.generic_evaluator,
      naturalnessGuardMs: Number(stats.naturalnessGuardMs.toFixed(1)),
      attentionNotices: stats.attention.notices,
      attentionPassesOver: stats.attention['passes over'],
      attentionNoPattern: stats.attention['no strong pattern'],
      // The gates in front of the drive, which is a different question from what it then decided.
      // driveBrainCalls minus driveSilentDecisions minus driveCancelledForExternalEvent is what
      // actually reached a persona; the last of those was invisible here and made three cancelled
      // calls look like three more silences.
      driveTicks: drive.ticks,
      driveEligibleTicks: drive.eligibleTicks,
      driveLocalSkips: drive.localSkips,
      driveBrainCalls: drive.brainCalls,
      driveSilentDecisions: drive.silentDecisions,
      driveCancelledForExternalEvent: drive.cancelledForExternalEvent,
      driveMessages: drive.messages,
    });
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
    metadata: { interactionId: string; previousInteractionId?: string; latencyMs: number; apiLatencyMs?: number },
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
        ...(metadata.apiLatencyMs !== undefined
          ? { brainApiLatencyMs: Math.max(0, metadata.apiLatencyMs) }
          : {}),
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
    const named = directTargets.size > 0
      ? eligibleCandidates.filter((candidate) => directTargets.has(candidate.username.toLowerCase()))
      : eligibleCandidates;
    // An account still inside its own interval cannot send anything, and offering it anyway meant
    // paying for a message the guard then binned: a measured fourteen minutes threw away 37
    // reactions to account_cooldown, and thirteen of thirty-four decisions ended up entirely empty
    // while the dashboard reported them as deliberate silence. Being named is the one exception —
    // leaving a question to a specific account unanswered is worse than answering it early.
    const candidates = directTargets.size > 0
      ? named
      : named.filter((candidate) => {
        const limit = this.options.policy.candidateRateLimit(candidate);
        return limit.cooldownRemainingMs <= 0 && !limit.busy;
      });
    const directTargetUnavailable = [...directTargets]
      .filter((username) => !candidates.some((candidate) => candidate.username.toLowerCase() === username))
      .map((username) => ({ username, reason: directTargetUnavailableReason(username, allCandidates) }));
    this.session.events += 1;
    this.session.eligibleSum += eligibleCandidates.length;
    this.session.candidateSum += candidates.length;
    this.session.excludedByCooldown += Math.max(0, named.length - candidates.length);
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

    // A spoken name was recognised for an account that is configured but not currently enabled and
    // connected, so narrowing to the mentioned accounts left nobody who could answer. Close the
    // trace here with the real reason and register no pending context: the Brain is given an empty
    // availableBots and skips the call entirely, instead of paying for a decision that could only
    // be silence and then reporting it as an expired context 45 seconds later.
    if (candidates.length === 0) {
      this.session.eventsWithoutCandidate += 1;
      this.updateTrace(event.id, {
        stage: 'STOPPED',
        outcome: 'FAILED',
        terminalReason: 'no_available_candidate',
        timing: { ...trace.timing, completedAt: this.now() },
      });
      this.logger.info('Event has no available candidate; Brain call skipped', {
        eventId: event.id,
        directMentions: event.directMentions,
        directTargetUnavailable,
      });
      return {
        event,
        triggerKind: 'external_stream_event',
        availableBots: [],
        recentChatDelta: [],
        targetedPersonaContext: [],
        reactionExamples: [],
        deltas: [],
        constraints: {
          maxReactions: this.options.policy.maxReactionsFor(0),
          maxMessageBytes: this.options.policy.maxMessageBytes(),
          globalSlotsAvailable: this.options.policy.globalSlotsAvailable(),
          expiresAt: this.now(),
        },
      };
    }

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
      trigger: { kind: 'stream_event', event },
      naturalnessEvent: event,
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
    // What each available account said recently, for every event rather than only direct mentions.
    // The anti-repetition rule tells the model to compare a draft against that account's own recent
    // messages — but those only ever arrived inside targetedPersonaContext, which is built for
    // direct mentions alone. On an ordinary event the model had nothing to compare against, so one
    // account opened three messages in a row with the same word. A few lines each is enough.
    const recentAccountMessages = await Promise.all(candidates.map(async (candidate) => ({
      username: candidate.username,
      messages: (await this.options.history.recent(candidate.username)).slice(-3).map((record) => record.message),
    })));

    // Two memories per candidate, and the streamer facts that bear on what was just said. The full
    // targeted context above is built only for direct mentions because it is large; this is the
    // cheap half of it, and it is the half that carries opinions. Without it every ordinary moment
    // was answered by accounts with no history of their own in front of them.
    const [recalledMemories, streamerMemories] = await Promise.all([
      Promise.all(candidates.map(async (candidate) => ({
        username: candidate.username,
        memories: (await this.options.personaMemory.recall(candidate.persona.id, {
          limit: 2, excludeViewerTagged: true,
        })).map((item) => ({ type: item.type, summary: item.summary })),
      }))),
      this.options.globalMemory.retrieve({
        channel: snapshot.channel,
        query: [event.summary, event.speech].filter(Boolean).join(' '),
        limit: 3,
      }).then((memories) => memories.map((memory) => ({ type: memory.type, summary: memory.summary })))
        .catch(() => []),
    ]);

    return {
      event,
      triggerKind: 'external_stream_event',
      availableBots: candidates.map((candidate) => candidate.username),
      recentAccountMessages: recentAccountMessages.filter((item) => item.messages.length > 0),
      recalledMemories: recalledMemories.filter((item) => item.memories.length > 0),
      candidateStates: candidates.map((candidate) => {
        const state = this.options.personaRuntime.get(candidate.persona.id);
        const attention = attentionFor(candidate.persona, event);
        this.session.attention[attention] += 1;
        return {
          username: candidate.username,
          mood: state.mood,
          engagement: state.engagement,
          sessionMessageCount: state.sessionMessageCount,
          // Fit taken from the character rather than from the clock. Selection used to be told that
          // an account which had been quiet was the stronger choice, which is a rotation wearing
          // the clothes of a judgement: a moment nobody cares about does not become interesting
          // because it is somebody's turn.
          attention,
        };
      }),
      ...(streamerMemories.length > 0 ? { streamerMemories } : {}),
      // Only what was said around this moment: older lines belong to a part of the stream the
      // event is not about, and the chain already carries them from earlier turns.
      recentSpeech: snapshot.recentSpeech.filter((line) => line.timestamp > chatAfter).slice(-8),
      recentChatDelta: snapshot.recentChat
        .filter((message) => message.timestamp > chatAfter)
        .slice(-40)
        .map(({ timestamp, username, message, kind }) => ({ timestamp, username, message, kind })),
      targetedPersonaContext,
      reactionExamples: reactionExamples.slice(0, 3),
      ...(this.options.isColdStart?.() ? { firstMessageGate: FIRST_MESSAGE_GATE } : {}),
      deltas: [],
      constraints: {
        // The ceiling follows the moment, not just the crowd: an ordinary remark is one voice at
        // most however many accounts are watching.
        maxReactions: this.options.policy.maxReactionsFor(candidates.length, event.importance),
        maxMessageBytes: this.options.policy.maxMessageBytes(),
        globalSlotsAvailable: this.options.policy.globalSlotsAvailable(),
        expiresAt,
      },
    };
  }

  /**
   * Registers a pending candidate set for a Persona Drive opportunity — the lean counterpart to
   * `prepareBrainEvent` used only for internal spontaneous-initiation attempts. No StreamEvent is
   * created or touched; the returned id exists solely to correlate the eventual `submitBatch` call
   * against the exact usernames that were actually offered, the same anti-hallucination guard the
   * external path gets. No trace record is created — the reaction-trace dashboard panel stays
   * exclusively about real observed events; `updateTrace` already no-ops safely without one.
   */
  prepareAutonomousCandidates(usernames: string[], observed?: NaturalnessInput['event']): string {
    const id = `persona-drive:${randomUUID()}`;
    const expiresAt = this.now() + this.contextTtlMs;
    const timer = setTimeout(() => this.expirePending(id), this.contextTtlMs);
    this.pendingContexts.set(id, {
      trigger: { kind: 'persona_drive', id },
      ...(observed ? { naturalnessEvent: observed } : {}),
      expiresAt,
      timer,
      permittedUsernames: new Set(usernames.map((username) => username.toLowerCase())),
      candidateCount: usernames.length,
      viewerByUsername: new Map(),
    });
    return id;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearPendingContexts();
    for (const pending of this.pendingDeliveries.values()) clearTimeout(pending.timer);
    this.pendingDeliveries.clear();
    for (const [timer, plan] of this.timers) {
      clearTimeout(timer);
      this.options.policy.releaseReservation(plan.reservationId);
      this.recordSendFailure(triggerId(plan.trigger), plan.bot.username, 'coordinator_stopped');
    }
    this.timers.clear();
  }

  private schedule(plan: PlannedReaction): void {
    const eventId = triggerId(plan.trigger);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.execute(plan);
    }, plan.delayMs);
    this.timers.set(timer, plan);
    const scheduledAt = this.now();
    const trace = this.traces.get(eventId);
    this.updateTrace(eventId, {
      stage: 'SCHEDULED',
      outcome: 'SCHEDULED',
      reactions: (trace?.reactions ?? []).map((reaction) => reaction.username === plan.bot.username
        ? { ...reaction, status: 'SCHEDULED' as const, scheduledAt }
        : reaction),
    });
    this.logger.info('Bot reaction queued', { bot: plan.bot.username, eventId, delayMs: plan.delayMs });
  }

  private async execute(plan: PlannedReaction): Promise<void> {
    const eventId = triggerId(plan.trigger);
    this.logger.info('Reaction scheduler fired', { bot: plan.bot.username, eventId });
    try {
      const current = this.options.candidates().find((candidate) => candidate.username === plan.bot.username);
      if (!current?.enabled || current.connectionState !== 'CONNECTED' || !current.chatConnected) {
        this.options.usage.recordSkipped();
        this.recordSendFailure(eventId, plan.bot.username, 'account_unavailable_at_send');
        return;
      }
      if (current.persona.id !== plan.bot.persona.id) {
        this.options.usage.recordSkipped();
        this.options.usage.recordGuardRejection();
        this.recordSendFailure(eventId, plan.bot.username, 'persona_reassigned');
        this.logger.warn('Queued reaction cancelled after persona reassignment', {
          bot: current.username,
          eventId,
          plannedPersonaId: plan.bot.persona.id,
          currentPersonaId: current.persona.id,
        });
        return;
      }
      if (await this.options.history.isDuplicate(current.username, plan.message)) {
        this.options.usage.recordSkipped();
        this.options.usage.recordGuardRejection();
        this.recordSendFailure(eventId, plan.bot.username, 'recent_duplicate_at_send');
        return;
      }
      const sendResult = await this.options.sender.send(current.username, plan.message);
      if (!sendResult.submitted) {
        this.options.usage.recordSkipped();
        this.recordSendFailure(eventId, plan.bot.username, sendResult.reason);
        return;
      }
      const sentAt = sendResult.submittedAt;
      // Submitted, not confirmed-visible. Confirmation is a separate signal that can legitimately
      // never arrive — one account went 0 for 4 on echoes across a whole run while two others went
      // 7 for 7 — and hanging the gate on it would leave a suppressed account holding the whole
      // session in cold start forever.
      this.options.onMessageSent?.();
      this.recordSendSuccess(eventId, current.username, sentAt);
      this.awaitDeliveryEcho(eventId, current.username, plan.message, sentAt);
      this.logger.info('Bot reaction submitted to Twitch', { bot: current.username, eventId, text: plan.message });
      try {
        this.options.policy.recordSent(sentAt, plan.reservationId);
        this.options.usage.recordSentResponse();
        this.options.personaRuntime.recordSent(current.persona.id);
        await this.options.history.add(current.username, plan.message, eventId);
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
          eventId,
          cause,
        });
      }
    } catch (cause) {
      this.options.usage.recordSkipped();
      this.recordSendFailure(eventId, plan.bot.username, safeErrorReason(cause));
      this.logger.warn('Queued bot reaction failed', { bot: plan.bot.username, eventId, cause });
    } finally {
      this.options.policy.releaseReservation(plan.reservationId);
    }
  }

  /**
   * Twitch never acknowledges a PRIVMSG, and tmi.js `say()` resolves once the bytes reach the
   * socket — so a message dropped by spam handling, followers-only mode, an unverified account or
   * AutoMod looks exactly like a delivered one. The reader account does receive every message the
   * channel actually shows, including the other bots', so an echo arriving back is the only real
   * delivery evidence available. Anything still unmatched when the window closes was not shown.
   *
   * Known blind spot: for the reader account's own messages tmi.js emits the echo locally rather
   * than receiving it from Twitch, so those confirm even if Twitch dropped them.
   */
  private awaitDeliveryEcho(eventId: string, username: string, message: string, sentAt: number): void {
    if (!this.options.observesChat?.()) return;
    const key = deliveryKey(username, message);
    const existing = this.pendingDeliveries.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pendingDeliveries.delete(key);
      this.options.usage.recordUndeliveredMessage();
      this.options.onDelivery?.({ username, result: 'hidden' });
      this.markReactionUndelivered(eventId, username);
      this.logger.warn('Reaction never appeared in Twitch chat', {
        bot: username, eventId, text: message, waitedMs: this.deliveryEchoTimeoutMs,
      });
    }, this.deliveryEchoTimeoutMs);
    timer.unref?.();
    this.options.onDelivery?.({ username, result: 'sent' });
    this.pendingDeliveries.set(key, { eventId, username, timer, sentAt });
  }

  /**
   * Called for every chat message the reader account observes. A match retires the pending
   * delivery, which is what turns "we wrote it to the socket" into "the channel actually shows it".
   */
  confirmDelivery(username: string, message: string): void {
    const key = deliveryKey(username, message);
    const pending = this.pendingDeliveries.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDeliveries.delete(key);
    this.options.usage.recordConfirmedDelivery();
    this.options.onDelivery?.({ username, result: 'shown' });
    this.logger.info('Reaction confirmed visible in Twitch chat', {
      bot: username, eventId: pending.eventId, roundTripMs: this.now() - pending.sentAt,
    });
  }

  /**
   * Twitch refused the message and said why on the sending account's connection. That is a far
   * better answer than waiting out the echo window and reporting a generic non-appearance, so the
   * pending delivery is retired immediately with the reported reason.
   */
  rejectDelivery(username: string, reason: string): void {
    const match = [...this.pendingDeliveries.entries()]
      .filter(([, pending]) => pending.username.toLowerCase() === username.toLowerCase())
      .sort((left, right) => right[1].sentAt - left[1].sentAt)[0];
    if (!match) return;
    const [key, pending] = match;
    clearTimeout(pending.timer);
    this.pendingDeliveries.delete(key);
    this.options.usage.recordUndeliveredMessage();
    this.options.onDelivery?.({ username: pending.username, result: 'hidden', reason });
    this.markReactionUndelivered(pending.eventId, pending.username, reason);
    this.logger.warn('Twitch refused a reaction', { bot: pending.username, eventId: pending.eventId, reason });
  }

  private markReactionUndelivered(eventId: string, username: string, reason?: string): void {
    const trace = this.traces.get(eventId);
    if (!trace) return;
    this.updateTrace(eventId, {
      reactions: trace.reactions.map((reaction) => reaction.username === username
        ? { ...reaction, status: 'UNDELIVERED' as const, ...(reason ? { failureReason: reason } : {}) }
        : reaction),
    });
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

/**
 * What the account could have been standing on when it answered.
 *
 * Not a judgement of the message — that needs reading it — but the observable half: whether this
 * moment carried words, a picture, or both. "в настройках интерфейса галка на миникарту" came from a
 * moment with speech and no relevant expertise behind it, and nothing in the log said so.
 */
function groundingOf(event: StreamEvent): 'speech' | 'scene' | 'speech+scene' | 'none' {
  const spoken = Boolean(event.speech);
  const seen = Boolean(event.visualContext);
  if (spoken && seen) return 'speech+scene';
  if (spoken) return 'speech';
  return seen ? 'scene' : 'none';
}

/**
 * Whether this moment is one this character would look at.
 *
 * Matching `event.type` against the profile's own event labels sounded right and did nothing. The
 * two vocabularies barely meet: the catalogue calls things 'football', 'dota-analysis', 'gossip',
 * 'music', 'routine', while the perception layer emits 'speech', 'question', 'conversation',
 * 'visual'. Across a measured stream that left `attention` at 'no strong pattern' for 28 of 31
 * moments and identical for all four accounts on the other three — a fit signal that never once
 * told two candidates apart, while the numeric selectivity beside it suppressed all of them.
 *
 * What the profiles do carry in the same language as the stream is what the person is into, so a
 * topical hit on interests or expertise is the signal that actually fires. The event-type lists are
 * still honoured where they happen to line up.
 */
function attentionFor(persona: ReactionBotCandidate['persona'], event: StreamEvent): 'notices' | 'passes over' | 'no strong pattern' {
  const activity = persona.behavior.activity;
  if (activity.ignoredEventTypes.includes(event.type)) return 'passes over';
  if (activity.preferredEventTypes.includes(event.type)) return 'notices';
  const moment = semanticTokens([event.summary, event.speech, event.visualContext, event.gameContext]
    .filter(Boolean).join(' '));
  if (moment.size === 0) return 'no strong pattern';
  const subjects = [
    ...persona.interests.games, ...persona.interests.music,
    ...persona.interests.food, ...persona.interests.other,
    ...persona.knowledge.expertise, ...persona.knowledge.familiarTopics,
  ];
  return subjects.some((subject) => relevanceScore(moment, subject) > 0)
    ? 'notices'
    : 'no strong pattern';
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
