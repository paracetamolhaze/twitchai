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
  maxReactionsPerEvent: number;
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
}

export interface PolicyBatchResult {
  accepted: PlannedReaction[];
  rejected: ReactionRejection[];
}

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
      };
    }
    const directMentions = triggerDirectMentions(input.trigger);
    const current = new Map(input.currentCandidates.map((candidate) => [candidate.username.toLowerCase(), candidate]));
    const seen = new Set<string>();
    const accepted: PlannedReaction[] = [];
    const rejected: ReactionRejection[] = [];

    for (let index = 0; index < input.reactions.length; index += 1) {
      const submitted = input.reactions[index]!;
      const username = submitted.username.trim().toLowerCase();
      const message = normalizeMessage(submitted.message);
      const reject = (reason: ReactionRejection['reason']): void => { rejected.push({ username, reason }); };

      const candidate = current.get(username);
      if (!input.permittedUsernames.has(username) || !candidate || submitted.username !== candidate.username) {
        reject('unknown_candidate'); continue;
      }
      if (seen.has(username)) { reject('duplicate_username'); continue; }
      seen.add(username);
      if (accepted.length >= this.options.maxReactionsPerEvent) {
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
      if (candidate.lastReactionAt && now - candidate.lastReactionAt < candidate.persona.behavior.minimumIntervalMs) {
        reject('account_cooldown'); continue;
      }
      if ([...this.reservations.values()].some((reservation) => reservation.username === username)) {
        reject('account_busy'); continue;
      }
      if (this.availableCapacity() <= 0) { reject('global_rate_limit'); continue; }
      if (await input.isDuplicate(username, message)) { reject('recent_duplicate'); continue; }

      const reservationId = randomUUID();
      // Transport spacing, not the human-typing simulation removed in b650a98: the first accepted
      // account still answers immediately. Production logs showed two different accounts hitting
      // Twitch 4-5ms apart, which its spam handling can silently drop with no error back to us,
      // so each additional account in the same batch is offset by a fixed step.
      const delayMs = accepted.length * this.batchStaggerMs;
      this.reservations.set(reservationId, { username, scheduledAt: now + delayMs });
      accepted.push({
        reservationId,
        trigger: input.trigger,
        bot: candidate,
        delayMs,
        directMention: directMentions.includes(username),
        message,
      });
    }
    return { accepted, rejected };
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

function normalizeMessage(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
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
