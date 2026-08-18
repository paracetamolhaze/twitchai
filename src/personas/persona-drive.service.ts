import { Logger } from '../logger';
import { BrainDecision, BrainDriveCandidate, BrainDriveOpportunityInput, FIRST_MESSAGE_GATE } from '../brain/types';
import { ReactionBatchResult, ReactionBotCandidate } from '../reaction/types';
import { ContextStore } from '../stream-brain/context-store';
import { UsageTracker } from '../usage/usage-tracker';
import { BotHistory } from './bot-history';
import { PersonaMemory } from './persona-memory';
import { PersonaRuntimeStore } from './persona-runtime-store';
import { PersonaActivityPattern } from './types';

export interface PersonaDriveServiceOptions {
  enabled: boolean;
  minIntervalMs: number;
  maxIntervalMs: number;
  minQuietMs: number;
  globalCooldownMs: number;
  personaCooldownMs: number;
  maxCandidates: number;
  maxBrainCallsPerHour: number;
  maxMessagesPerHour: number;
  maxBrainCallProbability: number;
  /** All bot candidates, regardless of current availability — filtered internally. */
  candidates: () => ReactionBotCandidate[];
  isStreamLive: () => boolean;
  isBrainReady: () => boolean;
  contextStore: ContextStore;
  personaMemory: PersonaMemory;
  personaRuntime: PersonaRuntimeStore;
  history: BotHistory;
  evaluateOpportunity: (input: BrainDriveOpportunityInput) => Promise<BrainDecision | undefined>;
  /**
   * Whether the session has yet to put a message in chat. A spontaneous aside is a worse first
   * impression than a reaction to something visible, so the drive is held to the same condition
   * rather than being allowed to slip under it.
   */
  isColdStart?: () => boolean;
  /** ReactionCoordinator.prepareAutonomousCandidates */
  prepareCandidates: (usernames: string[]) => string;
  /** ReactionCoordinator.submitBatch, wrapped as (requestId, reactions) => ... */
  submitReaction: (requestId: string, reactions: Array<{ username: string; message: string }>) => Promise<ReactionBatchResult>;
  /**
   * Durable memory the Brain proposed on this tick. Every decision may carry some, and until this
   * existed the ones from spontaneous initiation were parsed and then dropped on the floor.
   */
  applyMemoryUpdates: (decision: BrainDecision, requestId: string) => Promise<void>;
  usage: UsageTracker;
  logger: Logger;
  now?: () => number;
  random?: () => number;
}

/**
 * v1 hard rule, not configurable: one AI-authored reply may follow another bot's message with no
 * human message in between (A → B), but a second consecutive AI-authored reply may not (A → B →
 * C is blocked). aiChainDepth() counts trailing consecutive kind:'bot' messages; a single trailing
 * bot message (just A, depth 1) still permits one more hop, so the block threshold is 2 (A and B
 * already trailing means the one allowed hop was used).
 */
const AI_CHAIN_DEPTH_LIMIT = 2;
const MAX_TRAILING_BOT_MESSAGES_INSPECTED = 8;
const HOURLY_WINDOW_MS = 60 * 60_000;
const MAX_MEMORIES_PER_CANDIDATE = 3;
const MAX_RECENT_OWN_MESSAGES = 4;
const MAX_RECENT_CHAT_FOR_DRIVE = 15;
/** The tail of the session, enough to see whether a subject is still live without resending it all. */
const MAX_RECENT_SPEECH_FOR_DRIVE = 8;
const MAX_RECENT_EVENTS_FOR_DRIVE = 4;
/** How long without any own message before "hasn't spoken in a while" stops adding extra weight. */
const IDLE_REFERENCE_WINDOW_MS = 30 * 60_000;

const CHAT_FREQUENCY_WEIGHT: Record<PersonaActivityPattern['chatFrequency'], number> = {
  'very-low': 0.15,
  low: 0.4,
  medium: 1,
  high: 2,
};

/**
 * Single global scheduler for autonomous, spontaneous persona-initiated messages — the internal
 * counterpart to Gemini 3.1 Live's external StreamEvent detection. Holds no reference to the Live
 * perception client, by construction: additional Live calls, audio, video, or context pushes from
 * Persona Drive are structurally impossible, not just avoided by convention. Most ticks resolve
 * locally with no Gemini 3.7 call at all; silence is the expected, successful outcome.
 */
export class PersonaDriveService {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly random: () => number;
  private running = false;
  private timer?: NodeJS.Timeout;
  private lastExternalEventAt = 0;
  private lastAnyAutonomousMessageAt = 0;
  private readonly lastAutonomousMessageByPersona = new Map<string, number>();
  private brainCallTimestamps: number[] = [];
  private messageTimestamps: number[] = [];

  constructor(private readonly options: PersonaDriveServiceOptions) {
    this.logger = options.logger.child('PERSONA_DRIVE');
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastExternalEventAt = 0;
    this.logger.info('PERSONA_DRIVE_STARTED');
    this.scheduleNext();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.logger.info('PERSONA_DRIVE_STOPPED');
  }

  /** Called for every real StreamEvent (Live perception, chat, spoken transcription) so drive opportunities stay behind real observations. */
  notifyExternalEvent(): void {
    this.lastExternalEventAt = this.now();
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const span = Math.max(0, this.options.maxIntervalMs - this.options.minIntervalMs);
    const delay = this.options.minIntervalMs + Math.floor(this.random() * span);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.options.usage.recordDriveTick();
    this.logger.info('PERSONA_DRIVE_TICK');
    try {
      await this.attemptOpportunity();
    } catch (cause) {
      this.logger.warn('Persona Drive tick failed', { cause });
    } finally {
      this.scheduleNext();
    }
  }

  private async attemptOpportunity(): Promise<void> {
    const o = this.options;
    if (!o.enabled || !o.isStreamLive() || !o.isBrainReady()) {
      o.usage.recordDriveLocalSkip();
      this.logger.info('PERSONA_DRIVE_SKIPPED', { reason: 'not_eligible' });
      return;
    }
    const now = this.now();
    if (now - this.lastExternalEventAt < o.minQuietMs) {
      o.usage.recordDriveLocalSkip();
      this.logger.info('PERSONA_DRIVE_SKIPPED', { reason: 'not_quiet' });
      return;
    }
    if (now - this.lastAnyAutonomousMessageAt < o.globalCooldownMs) {
      o.usage.recordDriveLocalSkip();
      this.logger.info('PERSONA_DRIVE_SKIPPED', { reason: 'global_cooldown' });
      return;
    }
    if (await this.aiChainDepth() >= AI_CHAIN_DEPTH_LIMIT) {
      o.usage.recordDriveCancelledForCooldown();
      this.logger.info('PERSONA_DRIVE_SKIPPED', { reason: 'ai_chain_depth' });
      return;
    }
    this.pruneWindow(this.brainCallTimestamps, now);
    if (this.brainCallTimestamps.length >= o.maxBrainCallsPerHour) {
      o.usage.recordDriveBrainCallsBlockedByHourlyLimit();
      this.logger.info('PERSONA_DRIVE_SKIPPED', { reason: 'brain_hourly_limit' });
      return;
    }
    this.pruneWindow(this.messageTimestamps, now);
    if (this.messageTimestamps.length >= o.maxMessagesPerHour) {
      o.usage.recordDriveMessagesBlockedByHourlyLimit();
      this.logger.info('PERSONA_DRIVE_SKIPPED', { reason: 'message_hourly_limit' });
      return;
    }

    const candidateUsernames = this.selectCandidates(now);
    if (candidateUsernames.length === 0) {
      o.usage.recordDriveCancelledForNoCandidates();
      this.logger.info('PERSONA_DRIVE_SKIPPED', { reason: 'no_candidates' });
      return;
    }
    this.logger.info('PERSONA_DRIVE_CANDIDATES', { candidates: candidateUsernames });

    const driveCandidates = await this.buildCandidateInputs(candidateUsernames);
    for (const candidate of driveCandidates) {
      for (const memory of candidate.recalledMemories) {
        this.logger.info('PERSONA_MEMORY_RECALLED', { username: candidate.username, type: memory.type, importance: memory.importance });
      }
    }
    // A candidate with a memory to draw on still makes the better opportunity, but the penalty for
    // having none is mild rather than disqualifying: at the old floor almost every tick without a
    // recalled memory was thrown away, which is fine for a rare aside and far too strict for a
    // layer meant to keep chat alive.
    const qualityScore = driveCandidates.reduce(
      (sum, candidate) => sum + (candidate.recalledMemories.length > 0 ? 1 : 0.7), 0,
    ) / driveCandidates.length;
    const probability = o.maxBrainCallProbability * qualityScore;
    o.usage.recordDriveEligibleTick();
    if (this.random() >= probability) {
      o.usage.recordDriveLocalSkip();
      this.logger.info('PERSONA_DRIVE_SKIPPED', { reason: 'probability_gate', probability });
      return;
    }

    const snapshot = o.contextStore.snapshot();
    // Perception going quiet is not the same as the stream being quiet, and neither the decision
    // layer nor this service can tell them apart on its own. Production ran nearly six minutes in
    // which a connected perception layer reported nothing at all, and every spontaneous message in
    // that window was written against the same frozen observation, which is how the accounts ended
    // up discussing servers on a stream about dinner.
    const lastObservationAt = Math.max(
      snapshot.recentEvents.at(-1)?.timestamp ?? 0,
      snapshot.recentSpeech.at(-1)?.timestamp ?? 0,
    ) || undefined;
    // What was just heard and just seen. The drive fires twelve seconds after the last observation,
    // so the subject is still live — but the payload used to read these two arrays only for their
    // newest timestamp and throw the content away, leaving the model to answer "does anyone have
    // something to add" with no idea what there was to add to. Same state, already in memory, no
    // extra call: the drive now sees the tail of the session it is being asked about.
    const recentSpeech = snapshot.recentSpeech.slice(-MAX_RECENT_SPEECH_FOR_DRIVE)
      .map(({ timestamp, text }) => ({ timestamp, text }));
    const recentEvents = snapshot.recentEvents.slice(-MAX_RECENT_EVENTS_FOR_DRIVE)
      .map(({ timestamp, type, summary }) => ({ timestamp, type, summary }));
    const input: BrainDriveOpportunityInput = {
      triggerKind: 'persona_drive',
      channel: snapshot.channel,
      category: snapshot.category,
      streamContext: snapshot.streamContext,
      candidates: driveCandidates,
      recentChat: snapshot.recentChat.slice(-MAX_RECENT_CHAT_FOR_DRIVE)
        .map(({ timestamp, username, message, kind }) => ({ timestamp, username, message, kind })),
      ...(recentSpeech.length > 0 ? { recentSpeech } : {}),
      ...(recentEvents.length > 0 ? { recentEvents } : {}),
      ...(lastObservationAt !== undefined
        ? { secondsSinceLastObservation: Math.round((now - lastObservationAt) / 1000) }
        : {}),
      ...(o.isColdStart?.() ? { firstMessageGate: FIRST_MESSAGE_GATE } : {}),
      deltas: [],
    };

    const driveStartedAt = this.now();
    this.brainCallTimestamps.push(driveStartedAt);
    o.usage.recordDriveBrainCall();
    const requestId = o.prepareCandidates(candidateUsernames);
    this.logger.info('PERSONA_DRIVE_BRAIN_CALL', { requestId, candidates: candidateUsernames });
    const decision = await o.evaluateOpportunity(input);

    if (!decision) {
      await o.submitReaction(requestId, []);
      o.usage.recordDriveSilentDecision();
      this.logger.info('PERSONA_DRIVE_SILENT', { requestId, reason: 'no_decision' });
      return;
    }
    // Before the branches below, all of which can end the tick: whether this persona ends up
    // speaking has nothing to do with whether what the Brain noticed is worth keeping.
    await o.applyMemoryUpdates(decision, requestId);
    if (this.lastExternalEventAt > driveStartedAt) {
      // A real observation arrived while Gemini was still thinking about the drive opportunity.
      // The tokens are already spent; sending a now-stale autonomous reply on top of something
      // that actually just happened would be worse, so the result is discarded before it ever
      // reaches the scheduler.
      await o.submitReaction(requestId, []);
      o.usage.recordDriveCancelledForExternalEvent();
      this.logger.info('PERSONA_DRIVE_CANCELLED_EXTERNAL_EVENT', { requestId });
      return;
    }
    if (decision.reactions.length === 0) {
      await o.submitReaction(requestId, []);
      o.usage.recordDriveSilentDecision();
      // Not a failure and not rare: the backend offers the floor, and nobody having a reason to
      // take it is the ordinary outcome of a quiet minute.
      this.logger.info('PERSONA_DRIVE_SILENT', { requestId, candidates: candidateUsernames.length });
      return;
    }

    const reaction = decision.reactions[0]!;
    const result = await o.submitReaction(requestId, [{ username: reaction.username, message: reaction.message }]);
    if (result.accepted.length > 0) {
      const sentAt = this.now();
      this.lastAnyAutonomousMessageAt = sentAt;
      this.lastAutonomousMessageByPersona.set(reaction.username.toLowerCase(), sentAt);
      this.messageTimestamps.push(sentAt);
      o.usage.recordDriveMessage();
      this.logger.info('PERSONA_DRIVE_SELECTED', { requestId, username: reaction.username });
    } else {
      this.logger.info('PERSONA_DRIVE_RATE_LIMITED', { requestId, username: reaction.username, rejected: result.rejected });
    }
  }

  /**
   * How deep the bots are into talking among themselves.
   *
   * Only messages with nothing external behind them count. Several accounts answering one
   * StreamEvent are parallel reactions to the same thing that happened on stream, not a
   * conversation between bots — counting them as one made the gate permanently closed, because a
   * single event routinely draws three replies and the limit is two. What this is actually meant
   * to stop is an autonomous message drawing an autonomous answer with nothing on stream between.
   */
  private async aiChainDepth(): Promise<number> {
    const chat = this.options.contextStore.snapshot().recentChat;
    const trailing: typeof chat = [];
    for (let index = chat.length - 1; index >= 0; index -= 1) {
      const message = chat[index]!;
      if (message.kind !== 'bot') break;
      trailing.unshift(message);
      if (trailing.length >= MAX_TRAILING_BOT_MESSAGES_INSPECTED) break;
    }
    if (trailing.length === 0) return 0;

    const usernames = [...new Set(trailing.map((message) => message.username.toLowerCase()))];
    const records = new Map<string, string | undefined>();
    await Promise.all(usernames.map(async (username) => {
      for (const record of await this.options.history.recent(username)) {
        records.set(`${username}::${normalizeForLookup(record.message)}`, record.eventId);
      }
    }));

    let depth = 0;
    for (const message of trailing) {
      const eventId = records.get(`${message.username.toLowerCase()}::${normalizeForLookup(message.message)}`);
      // A persona-drive id, or no id at all, means nothing on stream prompted this message.
      if (!eventId || eventId.startsWith('persona-drive:')) depth += 1;
    }
    return depth;
  }

  private selectCandidates(now: number): string[] {
    const eligible = this.options.candidates().filter((candidate) => {
      if (!candidate.enabled || candidate.connectionState !== 'CONNECTED' || !candidate.chatConnected) return false;
      const lastAutonomous = this.lastAutonomousMessageByPersona.get(candidate.username.toLowerCase());
      return !lastAutonomous || now - lastAutonomous >= this.options.personaCooldownMs;
    });
    const weighted = eligible.map((candidate) => {
      const runtime = this.options.personaRuntime.peek(candidate.persona.id);
      const chatFrequency = CHAT_FREQUENCY_WEIGHT[candidate.persona.behavior.activity.chatFrequency];
      const engagementFactor = 0.5 + runtime.engagement;
      const idleMs = now - (candidate.lastReactionAt ?? 0);
      const idleFactor = Math.min(2, Math.max(0.5, idleMs / IDLE_REFERENCE_WINDOW_MS));
      const weight = chatFrequency * candidate.persona.behavior.reactionProbability * engagementFactor * idleFactor;
      return { item: candidate.username, weight: Math.max(0.001, weight) };
    });
    return weightedSampleWithoutReplacement(weighted, this.options.maxCandidates, this.random);
  }

  private async buildCandidateInputs(usernames: string[]): Promise<BrainDriveCandidate[]> {
    const candidates = this.options.candidates();
    const results: BrainDriveCandidate[] = [];
    for (const username of usernames) {
      const candidate = candidates.find((item) => item.username === username);
      if (!candidate) continue;
      const [recalledMemories, ownMessages] = await Promise.all([
        this.options.personaMemory.recall(candidate.persona.id, {
          limit: MAX_MEMORIES_PER_CANDIDATE,
          excludeViewerTagged: true,
        }),
        this.options.history.recent(candidate.username),
      ]);
      const runtime = this.options.personaRuntime.peek(candidate.persona.id);
      results.push({
        username: candidate.username,
        mood: runtime.mood,
        engagement: runtime.engagement,
        sessionMessageCount: runtime.sessionMessageCount,
        recalledMemories: recalledMemories.map(({ type, summary, importance }) => ({ type, summary, importance })),
        recentOwnMessages: ownMessages.slice(-MAX_RECENT_OWN_MESSAGES).map((record) => record.message),
      });
    }
    return results;
  }

  private pruneWindow(timestamps: number[], now: number): void {
    while (timestamps[0] !== undefined && timestamps[0] <= now - HOURLY_WINDOW_MS) timestamps.shift();
  }
}

/** Matches a chat echo back to the stored record it came from, ignoring whitespace differences. */
function normalizeForLookup(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Weighted random sampling without replacement — probabilistic candidate selection, not round-robin. */
function weightedSampleWithoutReplacement(
  entries: Array<{ item: string; weight: number }>,
  count: number,
  random: () => number,
): string[] {
  const pool = entries.filter((entry) => entry.weight > 0).map((entry) => ({ ...entry }));
  const picked: string[] = [];
  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
    if (total <= 0) break;
    let roll = random() * total;
    let index = 0;
    for (; index < pool.length - 1; index += 1) {
      roll -= pool[index]!.weight;
      if (roll <= 0) break;
    }
    const [selected] = pool.splice(index, 1);
    if (selected) picked.push(selected.item);
  }
  return picked;
}
