import { Logger } from '../logger';
import { StreamEventCandidate } from './types';

export interface SpeechEventSynthesizerOptions {
  /** Names that make a line worth answering immediately, whatever the pacing says. */
  botUsernames: () => string[];
  emit: (candidate: StreamEventCandidate) => void;
  logger: Logger;
  /** Shortest gap between two decisions, so a talkative minute does not become a decision a second. */
  minIntervalMs?: number;
  /** Longest a line may wait for company before it is answered on its own. */
  maxWaitMs?: number;
  /** Material worth waking the decision layer for, in characters of speech. */
  minCharacters?: number;
  now?: () => number;
}

/**
 * Turns what was said into moments worth a decision.
 *
 * The layer this replaces had a model watch the stream and announce semantic events, which cost a
 * conversation-priced turn each and arrived as a retelling: the decision layer read "the streamer
 * proposes some sort of plan" where the words were "we are dragging him out for drinks". Speech
 * needs no interpreting to be a moment — it only needs pacing, so that a minute of talking becomes
 * a few decisions rather than forty.
 *
 * Nothing here judges whether a moment deserves an answer. That judgement belongs to the layer
 * that can actually make it, and silence is already one of its normal answers.
 */
export class SpeechEventSynthesizer {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly minCharacters: number;
  private buffer: string[] = [];
  private firstBufferedAt?: number;
  private lastEmittedAt = 0;
  private waitTimer?: NodeJS.Timeout;

  constructor(private readonly options: SpeechEventSynthesizerOptions) {
    this.logger = options.logger.child('PERCEPTION');
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? 9_000;
    this.maxWaitMs = options.maxWaitMs ?? 25_000;
    this.minCharacters = options.minCharacters ?? 60;
  }

  accept(text: string): void {
    const line = text.trim();
    if (!line) return;
    this.buffer.push(line);
    this.firstBufferedAt ??= this.now();

    // Being addressed by name outranks pacing entirely: a question to one of the accounts that
    // goes unanswered for twenty seconds has already failed, however cheap the wait was.
    if (this.mentionsBot(line)) {
      this.flush('direct_mention');
      return;
    }
    const quietEnough = this.now() - this.lastEmittedAt >= this.minIntervalMs;
    if (quietEnough && this.bufferedText().length >= this.minCharacters) {
      this.flush('paced');
      return;
    }
    this.scheduleWait();
  }

  /** Ends the stream cleanly: whatever is buffered is answered rather than dropped. */
  stop(): void {
    this.clearTimer();
    this.buffer = [];
    this.firstBufferedAt = undefined;
  }

  private scheduleWait(): void {
    if (this.waitTimer || this.firstBufferedAt === undefined) return;
    const untilQuietEnough = this.minIntervalMs - (this.now() - this.lastEmittedAt);
    const untilDeadline = this.maxWaitMs - (this.now() - this.firstBufferedAt);
    const delay = Math.max(250, Math.min(Math.max(untilQuietEnough, 0), Math.max(untilDeadline, 0)));
    this.waitTimer = setTimeout(() => {
      this.waitTimer = undefined;
      this.reconsider();
    }, delay);
    this.waitTimer.unref?.();
  }

  private reconsider(): void {
    if (this.buffer.length === 0 || this.firstBufferedAt === undefined) return;
    // Past the deadline a short line is answered on its own rather than waiting for company that
    // may never arrive — a quiet stream is exactly where a lone remark matters most.
    if (this.now() - this.firstBufferedAt >= this.maxWaitMs) {
      this.flush('waited');
      return;
    }
    if (this.now() - this.lastEmittedAt >= this.minIntervalMs
      && this.bufferedText().length >= this.minCharacters) {
      this.flush('paced');
      return;
    }
    this.scheduleWait();
  }

  private flush(reason: 'direct_mention' | 'paced' | 'waited'): void {
    this.clearTimer();
    const speech = this.bufferedText();
    this.buffer = [];
    this.firstBufferedAt = undefined;
    if (!speech) return;
    this.lastEmittedAt = this.now();
    const mention = this.mentionsBot(speech);
    this.logger.info('Speech became a moment worth deciding on', {
      reason, characters: speech.length, directMention: mention,
    });
    this.options.emit({
      type: mention ? 'direct_mention' : 'speech',
      // The words are the summary. Anything else here would be a retelling, and a retelling is
      // what the decision layer kept reacting to instead of what was actually said.
      summary: speech,
      speech,
      importance: mention ? 0.85 : 0.5,
      // Heard, not inferred: the only uncertainty left is the transcription itself.
      confidence: 0.9,
    });
  }

  private bufferedText(): string {
    return this.buffer.join(' ').replace(/\s+/g, ' ').trim();
  }

  private mentionsBot(text: string): boolean {
    const haystack = text.toLowerCase();
    return this.options.botUsernames().some((username) => {
      const name = username.trim().toLowerCase();
      if (!name) return false;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^\\p{L}\\p{N}_])@?${escaped}(?:$|[^\\p{L}\\p{N}_])`, 'iu').test(haystack);
    });
  }

  private clearTimer(): void {
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = undefined;
  }
}
