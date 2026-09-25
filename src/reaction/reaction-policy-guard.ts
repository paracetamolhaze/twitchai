import { randomUUID } from 'node:crypto';
import { isAccountClassificationQuestion } from '../shared/account-classification';
import {
  PlannedReaction,
  ReactionBotCandidate,
  ReactionRejection,
  ReactionTrigger,
  SubmittedReaction,
  triggerDirectMentions,
} from './types';

export interface ReactionPolicyOptions {
  globalMessagesPer30Seconds: number;
  /** Ceiling. The number actually allowed scales with how many accounts are available. */
  maxReactionsPerEvent: number;
  /** Share of available accounts that may answer one moment. */
  reactionShareOfCandidates?: number;
  maxMessageBytes?: number;
  /** Spacing between accounts in one batch so two never reach Twitch in the same instant. */
  batchStaggerMs?: number;
  now?: () => number;
}

export interface ValidateReactionBatchInput {
  trigger: ReactionTrigger;
  reactions: SubmittedReaction[];
  permittedUsernames: Set<string>;
  currentCandidates: ReactionBotCandidate[];
  isDuplicate: (username: string, message: string) => Promise<boolean>;
  /** Optional: whether this account was specifically marked down for a close match before. */
  isDisliked?: (username: string, message: string) => boolean;
  /**
   * A social ceiling replacing maxReactionsFor for this batch — set by the coordinator for a
   * confirmed crowd call, where several voices are the natural shape. Counts UNIQUE accounts;
   * a same-person burst never spends another account's seat.
   */
  maxReactionsOverride?: number;
  /**
   * The crowd call, when present, asked for a constrained answer («киньте плюс»). One persona
   * then sends exactly one physical message: «+ слышно» is a person answering a poll; «+» then
   * «слышно» then «норм» is a machine padding one. Bursts stay legal for open conversation only.
   */
  constrainedCall?: boolean;
  /** Accounts whose per-account cooldown is waived: a direct continuation of their own active
   *  thread. Busy-state and the global rate limit still apply — continuity is not a spam pass. */
  recencyExempt?: ReadonlySet<string>;
  /** Waives the recent-duplicate check for one message — an explicit constrained chat call being
   *  answered in kind («+» after «киньте плюс»). The caller counts every use. */
  duplicateExempt?: (username: string, message: string) => boolean;
}

/** One person may add at most two follow-up thoughts in one batch — and the second follow-up has
 *  its own higher bar in validateBatch (new words or a question), so the OPERATIONAL default is
 *  two messages and three happens only for a visibly distinct third thought. Four is a monologue
 *  nobody has in a stream chat. */
const MAX_BURST_PARTS = 3;

export interface PolicyBatchResult {
  accepted: PlannedReaction[];
  rejected: ReactionRejection[];
  /** What this event actually planned against its own caps — the numbers the decision log reads. */
  planned: {
    uniqueResponders: number;
    physicalMessages: number;
    /** Physical messages refused by the per-event ceiling specifically — never by the global
     *  rate limit, which is the LAST safety net, not the normal way one event gets bounded. */
    droppedByEventCap: number;
  };
}

/**
 * How many physical messages past the unique-responder count one event may add through bursts.
 * Two, because a burst is at most two follow-up thoughts and most events carry at most one burst:
 * an ordinary single-voice moment stays at three messages worst case, an open-feedback call at
 * six, and nothing ever again multiplies voices by burst parts into an 18-message pile the global
 * limiter has to catch.
 */
const BURST_HEADROOM = 2;

export class ReactionPolicyGuard {
  private readonly now: () => number;
  private readonly batchStaggerMs: number;
  private readonly recentGlobalSends: number[] = [];
  private readonly reservations = new Map<string, { username: string; scheduledAt: number }>();

  constructor(private readonly options: ReactionPolicyOptions) {
    this.now = options.now ?? Date.now;
    this.batchStaggerMs = options.batchStaggerMs ?? 900;
  }

  maxReactions(): number { return this.options.maxReactionsPerEvent; }

  /**
   * How many accounts may answer one moment: a share of who is available, narrowed by how much the
   * moment actually carries.
   *
   * Two things were wrong with a fixed number. It was written for a full chat and read as a pile-up
   * on a small one, where two of four accounts answered the same event a second apart with two
   * wordings of one thought. And a crowd share alone still allowed a whole group to answer an
   * ordinary remark, which no real chat does: several people reply at once when something lands
   * that way, not because several were available. An ordinary moment allows up to two voices in a larger group,
   * while small groups stay at one and strong moments open up to the full share.
   */
  maxReactionsFor(availableCandidates: number, salience = 1): number {
    if (availableCandidates <= 0) return 0;
    const share = Math.max(1, Math.round(availableCandidates * (this.options.reactionShareOfCandidates ?? 0.15)));
    const ceiling = Math.min(this.options.maxReactionsPerEvent, share);
    if (salience >= 0.8) return ceiling;
    if (salience >= 0.6) return Math.min(2, ceiling);
    return Math.min(availableCandidates >= 10 ? 2 : 1, ceiling);
  }
  maxMessageBytes(): number { return this.options.maxMessageBytes ?? 450; }

  globalSlotsAvailable(): number {
    this.prune(this.now());
    return this.availableCapacity();
  }

  candidateRateLimit(candidate: ReactionBotCandidate): { cooldownRemainingMs: number; busy: boolean } {
    const now = this.now();
    this.prune(now);
    const cooldownRemainingMs = candidate.lastReactionAt
      ? Math.max(0, candidate.persona.behavior.minimumIntervalMs - (now - candidate.lastReactionAt))
      : 0;
    const busy = [...this.reservations.values()].some((reservation) => reservation.username === candidate.username.toLowerCase());
    return { cooldownRemainingMs, busy };
  }

  async validateBatch(input: ValidateReactionBatchInput): Promise<PolicyBatchResult> {
    const now = this.now();
    this.prune(now);
    if (isClassificationEvent(input.trigger)) {
      return {
        accepted: [],
        rejected: input.reactions.map((reaction) => ({
          username: reaction.username.trim().toLowerCase(),
          reason: 'account_classification' as const,
        })),
        planned: { uniqueResponders: 0, physicalMessages: 0, droppedByEventCap: 0 },
      };
    }
    const directMentions = triggerDirectMentions(input.trigger);
    const current = new Map(input.currentCandidates.map((candidate) => [candidate.username.toLowerCase(), candidate]));
    // Parts per account, in order. The same username appearing again is no longer an error: it is
    // a same-person burst — a second, distinct thought sent as its own consecutive message, which
    // is one of the most ordinary things a real chatter does and the one thing the old `seen` set
    // made structurally impossible.
    const partsByUsername = new Map<string, PlannedReaction[]>();
    // Exact normalized text -> the account that already holds it in THIS batch. Two different
    // people typing the same line at the same moment is an AI chorus unless the streamer asked
    // for exactly that shape — the duplicateExempt carve-out below is what allows «+» «+».
    const textOwners = new Map<string, string>();
    const batchReservationIds = new Set<string>();
    const accepted: PlannedReaction[] = [];
    const rejected: ReactionRejection[] = [];
    const maxVoices = input.maxReactionsOverride ?? this.maxReactionsFor(input.currentCandidates.length);
    // The physical ceiling is the second, separate bound: voices count PEOPLE, this counts Twitch
    // messages. A constrained poll gets no burst headroom at all — its whole point is one short
    // answer per person.
    const physicalCap = input.constrainedCall ? maxVoices : maxVoices + BURST_HEADROOM;
    let droppedByEventCap = 0;

    for (let index = 0; index < input.reactions.length; index += 1) {
      const submitted = input.reactions[index]!;
      const username = submitted.username.trim().toLowerCase();
      const message = normalizeMessage(submitted.message);
      const reject = (reason: ReactionRejection['reason']): void => { rejected.push({ username, reason }); };

      const candidate = current.get(username);
      if (!input.permittedUsernames.has(username) || !candidate || submitted.username !== candidate.username) {
        reject('unknown_candidate'); continue;
      }
      const parts = partsByUsername.get(username) ?? [];
      if (parts.length >= MAX_BURST_PARTS) { reject('duplicate_username'); continue; }
      // A follow-up must be a distinct thought; the same line twice is a stutter, not a burst.
      if (parts.some((part) => part.message.toLowerCase() === message.toLowerCase())) {
        reject('duplicate_username'); continue;
      }
      // A constrained call takes one physical message per person, full stop.
      if (input.constrainedCall && parts.length >= 1) {
        droppedByEventCap += 1;
        reject('too_many_reactions'); continue;
      }
      // The event's physical ceiling: burst parts are real Twitch messages and are bounded as
      // such, independently of how many PEOPLE answered.
      if (accepted.length >= physicalCap) {
        droppedByEventCap += 1;
        reject('too_many_reactions'); continue;
      }
      // A THIRD consecutive message has a higher bar than a second: it must visibly be its own
      // thought — new words or a question — or two parts were enough. Deterministic, no dice.
      if (parts.length === 2) {
        const seenTokens = new Set(parts.flatMap((part) => part.message.toLowerCase().split(' ')));
        const fresh = message.toLowerCase().split(' ').filter((token) => !seenTokens.has(token));
        if (fresh.length < 2 && !/[?？]/.test(message)) {
          droppedByEventCap += 1;
          reject('duplicate_username'); continue;
        }
      }
      // Voices are counted by ACCOUNT: a burst spends its own author's seat only.
      if (parts.length === 0 && partsByUsername.size >= maxVoices) {
        reject('too_many_reactions'); continue;
      }
      if (!candidate?.enabled || candidate.connectionState !== 'CONNECTED' || !candidate.chatConnected) {
        reject('not_connected'); continue;
      }
      if (!message) { reject('empty_message'); continue; }
      if (isControlValue(message)) { reject('control_value'); continue; }
      // Nobody types an em dash into a chat box; it is the clearest tell that a message was
      // written rather than typed. Three separate instructions failed to stop it, so it is a
      // rule here instead of a request.
      if (/[—–]/.test(message)) { reject('typographic_dash'); continue; }
      if (hasInternalMetadataLeak(message)) { reject('internal_metadata'); continue; }
      if (Buffer.byteLength(message, 'utf8') > this.maxMessageBytes()) { reject('message_too_long'); continue; }
      if (!input.recencyExempt?.has(username)
        && candidate.lastReactionAt && now - candidate.lastReactionAt < candidate.persona.behavior.minimumIntervalMs) {
        reject('account_cooldown'); continue;
      }
      if ([...this.reservations.entries()]
        .some(([id, reservation]) => reservation.username === username && !batchReservationIds.has(id))) {
        reject('account_busy'); continue;
      }
      if (this.availableCapacity() <= 0) { reject('global_rate_limit'); continue; }
      const duplicateExempt = input.duplicateExempt?.(username, submitted.message) ?? false;
      const textKey = message.toLowerCase();
      if (!duplicateExempt && textOwners.has(textKey) && textOwners.get(textKey) !== username) {
        reject('recent_duplicate'); continue;
      }
      if (!duplicateExempt && await input.isDuplicate(username, message)) { reject('recent_duplicate'); continue; }
      if (input.isDisliked?.(username, message)) { reject('disliked_near_duplicate'); continue; }

      const reservationId = randomUUID();
      // Transport spacing, not the human-typing simulation removed in b650a98: the first accepted
      // account still answers immediately; each additional ACCOUNT is offset by a fixed step so two
      // never reach Twitch in the same instant. A burst follow-up instead trails its own previous
      // part by a shorter human pause — a person adding a thought, not a queue slot.
      const delayMs = parts.length === 0
        ? (partsByUsername.size) * this.batchStaggerMs
        : parts[parts.length - 1]!.delayMs + 800 + ((accepted.length * 977) % 1_700);
      this.reservations.set(reservationId, { username, scheduledAt: now + delayMs });
      batchReservationIds.add(reservationId);
      accepted.push({
        // Passed through, never minted here: the coordinator assigns the id on intake so the same
        // value reaches every layer. The fallback exists only for direct callers in tests.
        reactionId: submitted.reactionId ?? randomUUID(),
        reservationId,
        trigger: input.trigger,
        bot: candidate,
        delayMs,
        directMention: directMentions.includes(username),
        message,
        plannedAt: now,
        ...(duplicateExempt ? { duplicateExempt: true } : {}),
      });
      parts.push(accepted[accepted.length - 1]!);
      partsByUsername.set(username, parts);
      if (!textOwners.has(textKey)) textOwners.set(textKey, username);
    }

    // Stamp burst identity where one account holds several seats: independent messages, one
    // social act. burstIndex orders the thoughts; analytics joins them by burstId.
    for (const parts of partsByUsername.values()) {
      if (parts.length < 2) continue;
      const burstId = randomUUID();
      parts.forEach((part, index) => {
        part.burstId = burstId;
        part.burstIndex = index;
        part.burstSize = parts.length;
      });
    }
    return {
      accepted,
      rejected,
      planned: {
        uniqueResponders: partsByUsername.size,
        physicalMessages: accepted.length,
        droppedByEventCap,
      },
    };
  }

  recordSent(at = this.now(), reservationId?: string): void {
    if (reservationId) this.reservations.delete(reservationId);
    this.recentGlobalSends.push(at);
    this.prune(at);
  }

  releaseReservation(reservationId: string): void { this.reservations.delete(reservationId); }

  private availableCapacity(): number {
    return Math.max(0, this.options.globalMessagesPer30Seconds - this.recentGlobalSends.length - this.reservations.size);
  }

  private prune(now: number): void {
    while (this.recentGlobalSends[0] !== undefined && this.recentGlobalSends[0] <= now - 30_000) {
      this.recentGlobalSends.shift();
    }
    for (const [id, reservation] of this.reservations) {
      if (reservation.scheduledAt <= now - 30_000) this.reservations.delete(id);
    }
  }
}

function normalizeMessage(value: string): string {
  // Operator style: drop a final full stop, preserving inner punctuation and ellipses.
  return value.replace(/\s+/g, ' ').trim().replace(/(?<!\.)\.$/u, '').trimEnd();
}
function isClassificationEvent(trigger: ReactionTrigger): boolean {
  if (trigger.kind !== 'stream_event') return false;
  const { event } = trigger;
  return event.directMentions.length > 0
    && isAccountClassificationQuestion([event.summary, event.speech].filter(Boolean).join('\n'));
}
function isControlValue(value: string): boolean {
  return /^<\/?[a-z][^>]*>$/i.test(value) || /^<?skip>?[.!]?$/i.test(value) || /^[/.]/.test(value);
}

/**
 * Rejects only operational self-disclosure and implementation identifiers. Terms
 * such as Gemini or AI remain valid when the stream is discussing them normally.
 */
function hasInternalMetadataLeak(value: string): boolean {
  const normalized = value.toLowerCase();
  const implementationMarkers = [
    /(?<![\p{L}\p{N}_])personaid(?![\p{L}\p{N}_])/iu,
    /(?<![\p{L}\p{N}_])prepare_reaction_context(?![\p{L}\p{N}_])/iu,
    /(?<![\p{L}\p{N}_])emit_reaction_batch(?![\p{L}\p{N}_])/iu,
    /(?<![\p{L}\p{N}_])personacontextbuilder(?![\p{L}\p{N}_])/iu,
    /(?<![\p{L}\p{N}_])reactionmemory(?![\p{L}\p{N}_])/iu,
    /(?<![\p{L}\p{N}_])(?:system\s+(?:prompt|instruction)|системн\p{L}*\s+(?:промпт\p{L}*|инструкц\p{L}*))(?![\p{L}\p{N}_])/iu,
    /(?<![\p{L}\p{N}_])(?:backend\s+metadata|метаданн\p{L}*\s+бэкенд\p{L}*|database\s+(?:field|metadata))(?![\p{L}\p{N}_])/iu,
    /(?<![\p{L}\p{N}_])(?:generated\s+profile|profile\s+generation|ai\s+persona|bot\s+personality)(?![\p{L}\p{N}_])/iu,
    /(?<![\p{L}\p{N}_])(?:сгенерированн\p{L}*\s+(?:профил\p{L}*|персонаж\p{L}*)|персон\p{L}*\s+в\s+промпт\p{L}*)(?![\p{L}\p{N}_])/iu,
  ];
  if (implementationMarkers.some((pattern) => pattern.test(normalized))) return true;

  const selfDisclosure = [
    /(?:^|[\s,.!?])я(?:\s+являюсь)?\s*(?:[—-]\s*)?(?:не\s+)?(?:бот(?:ик)?|ии(?![\p{L}\p{N}_])|ai|нейросет[\p{L}\p{N}_]*|нейронк[\p{L}\p{N}_]*|gemini|openai|chatgpt|gpt|программ[\p{L}\p{N}_]*|алгоритм[\p{L}\p{N}_]*|языков(?:ая|ой)\s+модел[\p{L}\p{N}_]*|искусственн[\p{L}\p{N}_]*\s+(?:интеллект|зрител[\p{L}\p{N}_]*|viewer)|синтетическ[\p{L}\p{N}_]*\s+(?:зрител[\p{L}\p{N}_]*|viewer)|виртуальн[\p{L}\p{N}_]*\s+(?:зрител[\p{L}\p{N}_]*|viewer)|автоматизированн[\p{L}\p{N}_]*\s+(?:зрител[\p{L}\p{N}_]*|аккаунт[\p{L}\p{N}_]*))/iu,
    /(?:^|[\s,.!?])я\s+(?:(?:точно|реально|настоящий|реальный)\s+)?человек(?=$|[\s,.!?])/iu,
    /(?:^|[\s,.!?])i\s*(?:am|'m)\s+(?:an?\s+)?(?:bot|ai|language\s+model|gemini|openai|chatgpt|gpt|(?:artificial|synthetic|virtual|automated)\s+viewer)/iu,
    /(?:^|[\s,.!?])i\s*(?:am|'m)\s+(?:(?:definitely|really|a\s+real)\s+)?human(?=$|[\s,.!?])/iu,
    /(?:меня|нас)\s+(?:создали|сгенерировали|настроили|запрограммировали)/iu,
    /(?:у\s+меня|мне)\s+(?:прописан|назначен|выдан)\s+(?:промпт|профил|персон)/iu,
    /(?:как\s+я\s+устроен|кто\s+меня\s+создал|какая\s+модель\s+меня\s+генерир[\p{L}\p{N}_]*|(?:мой|у\s+меня)\s+(?:системн[\p{L}\p{N}_]*\s+)?промпт)/iu,
  ];
  return selfDisclosure.some((pattern) => pattern.test(normalized));
}
