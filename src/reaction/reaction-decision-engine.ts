import { randomUUID } from 'node:crypto';
import { StreamEvent } from '../stream-brain/types';
import { PlannedReaction, ReactionBotCandidate } from './types';

export interface ReactionDecisionOptions {
  eventThreshold: number;
  minimumDelayMs: number;
  maximumDelayMs: number;
  globalMessagesPer30Seconds: number;
  random?: () => number;
  now?: () => number;
}

export class ReactionDecisionEngine {
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly recentGlobalSends: number[] = [];
  private readonly reservations = new Map<string, number>();

  constructor(private readonly options: ReactionDecisionOptions) {
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  setEventThreshold(value: number): void {
    this.options.eventThreshold = Math.max(0, Math.min(1, value));
  }

  decide(event: StreamEvent, bots: ReactionBotCandidate[]): PlannedReaction[] {
    const now = this.now();
    this.prune(now);
    const direct = new Set(event.directMentions.map((username) => username.toLowerCase()));
    const connected = bots.filter((bot) => bot.enabled && bot.connectionState === 'CONNECTED' && bot.chatConnected);
    const directlyAddressed = connected.filter((bot) => direct.has(bot.username.toLowerCase()));

    // A mention is one exclusive decision path: it never falls through into the ordinary multi-bot flow.
    if (direct.size > 0) {
      const target = directlyAddressed.filter((bot) => this.allowedByCooldown(bot, now, true));
      return this.plan(target, event, true, now);
    }

    if (event.importance < this.options.eventThreshold || event.confidence < 0.4) return [];
    const capacity = Math.max(
      0,
      this.options.globalMessagesPer30Seconds - this.recentGlobalSends.length - this.reservations.size,
    );
    if (capacity === 0) return [];
    const desired = event.importance >= 0.85 ? 3 : event.importance >= 0.7 ? 2 : 1;
    const ranked = connected
      .filter((bot) => this.allowedByCooldown(bot, now, false))
      .map((bot) => ({ bot, score: this.score(bot, event) }))
      .filter(({ bot, score }) => this.random() < Math.min(0.95, score * bot.persona.reactionProbability))
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.min(desired, capacity))
      .map(({ bot }) => bot);
    return this.plan(ranked, event, false, now);
  }

  recordSent(at = this.now(), reservationId?: string): void {
    if (reservationId) this.reservations.delete(reservationId);
    this.recentGlobalSends.push(at);
    this.prune(at);
  }

  releaseReservation(reservationId: string): void { this.reservations.delete(reservationId); }

  private score(bot: ReactionBotCandidate, event: StreamEvent): number {
    const interests = new Set(bot.persona.interests.map((interest) => interest.toLowerCase()));
    const match = interests.has(event.type) || [...interests].some((interest) => event.summary.toLowerCase().includes(interest));
    return Math.min(1, event.importance * 0.7 + event.confidence * 0.2 + (match ? 0.2 : 0));
  }

  private allowedByCooldown(bot: ReactionBotCandidate, now: number, direct: boolean): boolean {
    if (!bot.lastReactionAt) return true;
    const cooldown = direct ? Math.min(10_000, bot.persona.minimumIntervalMs) : bot.persona.minimumIntervalMs;
    return now - bot.lastReactionAt >= cooldown;
  }

  private plan(bots: ReactionBotCandidate[], event: StreamEvent, directMention: boolean, now: number): PlannedReaction[] {
    const span = this.options.maximumDelayMs - this.options.minimumDelayMs;
    const capacity = Math.max(
      0,
      this.options.globalMessagesPer30Seconds - this.recentGlobalSends.length - this.reservations.size,
    );
    return bots.slice(0, capacity).map((bot, index, selected) => {
      const reservationId = randomUUID();
      const delayMs = Math.round(
        this.options.minimumDelayMs
        + ((index + this.random()) / Math.max(1, selected.length)) * span,
      );
      this.reservations.set(reservationId, now + delayMs);
      return { reservationId, event, bot, directMention, delayMs };
    });
  }

  private prune(now: number): void {
    while (this.recentGlobalSends[0] !== undefined && this.recentGlobalSends[0] <= now - 30_000) {
      this.recentGlobalSends.shift();
    }
    for (const [id, scheduledAt] of this.reservations) {
      if (scheduledAt <= now - 30_000) this.reservations.delete(id);
    }
  }
}
