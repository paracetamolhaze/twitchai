import { randomUUID } from 'node:crypto';
import { StreamEvent } from '../stream-brain/types';
import {
  PlannedReaction,
  ReactionBotCandidate,
  ReactionRejection,
  SubmittedReaction,
} from './types';

export interface ReactionPolicyOptions {
  minimumDelayMs: number;
  maximumDelayMs: number;
  globalMessagesPer30Seconds: number;
  maxReactionsPerEvent: number;
  maxMessageBytes?: number;
  random?: () => number;
  now?: () => number;
}

export interface ValidateReactionBatchInput {
  event: StreamEvent;
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
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly recentGlobalSends: number[] = [];
  private readonly reservations = new Map<string, { username: string; scheduledAt: number }>();

  constructor(private readonly options: ReactionPolicyOptions) {
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
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
    const current = new Map(input.currentCandidates.map((candidate) => [candidate.username.toLowerCase(), candidate]));
    const seen = new Set<string>();
    const accepted: PlannedReaction[] = [];
    const rejected: ReactionRejection[] = [];

    for (let index = 0; index < input.reactions.length; index += 1) {
      const submitted = input.reactions[index]!;
      const username = submitted.username.trim().toLowerCase();
      const message = normalizeMessage(submitted.message);
      const reject = (reason: ReactionRejection['reason']): void => { rejected.push({ username, reason }); };

      if (seen.has(username)) { reject('duplicate_username'); continue; }
      seen.add(username);
      if (accepted.length >= this.options.maxReactionsPerEvent) {
        reject('too_many_reactions'); continue;
      }
      if (!input.permittedUsernames.has(username)) { reject('unknown_candidate'); continue; }
      const candidate = current.get(username);
      if (!candidate?.enabled || candidate.connectionState !== 'CONNECTED' || !candidate.chatConnected) {
        reject('not_connected'); continue;
      }
      if (!message) { reject('empty_message'); continue; }
      if (isControlValue(message)) { reject('control_value'); continue; }
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
      const delayMs = this.delayFor(accepted.length, Math.min(input.reactions.length, this.options.maxReactionsPerEvent));
      this.reservations.set(reservationId, { username, scheduledAt: now + delayMs });
      accepted.push({
        reservationId,
        event: input.event,
        bot: candidate,
        delayMs,
        directMention: input.event.directMentions.includes(username),
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

  private delayFor(index: number, count: number): number {
    const minimum = Math.max(0, this.options.minimumDelayMs);
    const maximum = Math.max(minimum, this.options.maximumDelayMs);
    const span = maximum - minimum;
    return Math.round(minimum + ((index + this.random()) / Math.max(1, count)) * span);
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
function isControlValue(value: string): boolean {
  return /^<\/?[a-z][^>]*>$/i.test(value) || /^<?skip>?[.!]?$/i.test(value) || /^[/.]/.test(value);
}
