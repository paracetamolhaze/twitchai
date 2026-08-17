import { Logger } from '../logger';
import { BotMentionMatcher } from '../shared/bot-mention-matcher';
import { StreamEventCandidate } from './types';

export interface SpeechEventSynthesizerOptions {
  /** Names that make a line worth answering immediately, whatever the pacing says. */
  botUsernames: () => string[];
  emit: (candidate: StreamEventCandidate) => void;
  logger: Logger;
  /** Shortest gap between two decisions, so a talkative minute does not become a decision a second. */
  minIntervalMs?: number;
  /** The same gap for a line that asks something: an answer twenty seconds late is not an answer. */
  quickIntervalMs?: number;
  /** Longest a line may wait for company before it is answered on its own. */
  maxWaitMs?: number;
  /** Material worth waking the decision layer for, in characters of speech. */
  minCharacters?: number;
  /**
   * Longest the moment itself may be.
   *
   * Everything said between two decisions used to become one event: 400 characters of several
   * people talking across each other, and a reply to that can only be vague. A viewer reacts to
   * the last thing said, not to the last minute — the rest still reaches the decision layer as
   * recentSpeech, which is where history belongs.
   */
  maxMomentCharacters?: number;
  /** Silence a changed scene must follow before it becomes a moment on its own. */
  quietBeforeVisualMs?: number;
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
  private readonly quickIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly minCharacters: number;
  private readonly maxMomentCharacters: number;
  private readonly quietBeforeVisualMs: number;
  private currentScene?: string;
  private buffer: string[] = [];
  private firstBufferedAt?: number;
  private lastEmittedAt = 0;
  private waitTimer?: NodeJS.Timeout;
  private matcher?: BotMentionMatcher;
  private matcherKey?: string;

  constructor(private readonly options: SpeechEventSynthesizerOptions) {
    this.logger = options.logger.child('PERCEPTION');
    this.now = options.now ?? Date.now;
    // A measured stream produced 227 decisions an hour, one every sixteen seconds, and half of
    // them ended in deliberate silence — a paid question about a moment nobody was going to answer.
    this.minIntervalMs = options.minIntervalMs ?? 20_000;
    // Above the model's own latency on purpose. At five seconds this path became the normal one —
    // eighteen of twenty-seven moments came through it, because casual speech is full of question
    // marks — and events outran the decisions they were asking for.
    this.quickIntervalMs = options.quickIntervalMs ?? 12_000;
    this.maxWaitMs = options.maxWaitMs ?? 40_000;
    this.minCharacters = options.minCharacters ?? 90;
    this.maxMomentCharacters = options.maxMomentCharacters ?? 200;
    this.quietBeforeVisualMs = options.quietBeforeVisualMs ?? 40_000;
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
    // Pacing exists to keep a talkative minute from becoming forty decisions, but a question is
    // the one thing that stops being answerable while it waits. Those get a five-second floor
    // instead of twenty; on a real stream they are a minority, so the call count barely moves.
    const waited = this.now() - this.lastEmittedAt;
    if (invitesAnAnswer(line) && waited >= this.quickIntervalMs) {
      this.flush('asked');
      return;
    }
    if (waited >= this.minIntervalMs && this.bufferedText().length >= this.minCharacters) {
      this.flush('paced');
      return;
    }
    this.scheduleWait();
  }

  /**
   * What is on screen now. It rides along with whatever is said next, and becomes a moment of its
   * own only when the scene has changed and nobody has said anything for a while — on a talkative
   * stream the words are the moment, and a second trigger for the same instant is just noise.
   */
  acceptScene(description: string, changed: boolean): void {
    const scene = description.trim();
    if (!scene) return;
    this.currentScene = scene;
    if (!changed || this.buffer.length > 0) return;
    if (this.now() - this.lastEmittedAt < this.quietBeforeVisualMs) return;
    this.lastEmittedAt = this.now();
    this.logger.info('A changed scene became a moment worth deciding on', { characters: scene.length });
    this.options.emit({
      type: 'visual',
      summary: scene,
      visualContext: scene,
      importance: 0.4,
      // Described rather than heard, and a description can be confidently wrong about a blur.
      confidence: 0.75,
    });
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
    if (invitesAnAnswer(this.bufferedText()) && this.now() - this.lastEmittedAt >= this.quickIntervalMs) {
      this.flush('asked');
      return;
    }
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

  private flush(reason: 'direct_mention' | 'asked' | 'paced' | 'waited'): void {
    this.clearTimer();
    const speech = this.moment();
    const buffered = this.bufferedText().length;
    this.buffer = [];
    this.firstBufferedAt = undefined;
    if (!speech) return;
    this.lastEmittedAt = this.now();
    const mention = this.mentionsBot(speech);
    this.logger.info('Speech became a moment worth deciding on', {
      reason, characters: speech.length, buffered, directMention: mention,
    });
    this.options.emit({
      type: mention ? 'direct_mention' : speechType(speech),
      // The words are the summary. Anything else here would be a retelling, and a retelling is
      // what the decision layer kept reacting to instead of what was actually said.
      summary: speech,
      speech,
      ...(this.currentScene ? { visualContext: this.currentScene } : {}),
      importance: mention ? 0.85 : speechImportance(speech),
      // Heard, not inferred: the only uncertainty left is the transcription itself.
      confidence: 0.9,
    });
  }

  private bufferedText(): string {
    return this.buffer.join(' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * The part of what was said that is actually the moment: the latest lines, from the end back.
   * Whatever came before is history, and history already travels as recentSpeech.
   */
  private moment(): string {
    const lines: string[] = [];
    let length = 0;
    for (const line of [...this.buffer].reverse()) {
      if (lines.length > 0 && length + line.length > this.maxMomentCharacters) break;
      lines.unshift(line);
      length += line.length + 1;
    }
    const moment = lines.join(' ').replace(/\s+/g, ' ').trim();
    return moment.length > this.maxMomentCharacters * 2
      ? moment.slice(-this.maxMomentCharacters * 2).replace(/^\S*\s/u, '')
      : moment;
  }

  private mentionsBot(text: string): boolean {
    // The shared matcher, so a name said out loud in Russian is recognised here exactly as the
    // same name typed in chat already was.
    const usernames = this.options.botUsernames();
    const key = usernames.join(' ');
    if (key !== this.matcherKey) {
      this.matcher = new BotMentionMatcher(usernames.map((username) => ({ username })));
      this.matcherKey = key;
    }
    return (this.matcher?.match(text).length ?? 0) > 0;
  }

  private clearTimer(): void {
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = undefined;
  }
}

/**
 * What kind of moment this is, from the words themselves.
 *
 * Live used to label every event, and losing that left the whole feed reading "speech, importance
 * 0.50" whether the streamer asked chat something or muttered at a traffic light. These are plain
 * signals rather than an interpretation — a question mark is a question in any language.
 */
function speechType(speech: string): 'question' | 'funny' | 'reaction' | 'conversation' | 'speech' {
  if (/[?？]/.test(speech)) return 'question';
  if (/(?:ха[- ]?ха|хах|ахах|лол|ржу|угар)/iu.test(speech)) return 'funny';
  if (/(?:^|\s)(?:ого|ничего себе|обалдеть|вот это|ужас|кошмар|ого себе|бля+ть?)/iu.test(speech)) return 'reaction';
  return speech.length > 160 ? 'conversation' : 'speech';
}

/**
 * How much this moment offers to answer. A question aimed at chat is worth more than a passing
 * remark, and a long stretch of talk carries more to pick from than three words.
 */
function speechImportance(speech: string): number {
  let importance = 0.4;
  if (/[?？]/.test(speech)) importance += 0.2;
  if (speech.length > 120) importance += 0.1;
  if (/(?:^|\s)(?:чат|ребят|народ|парни|пацаны|guys|chat)/iu.test(speech)) importance += 0.15;
  return Math.min(0.9, Number(importance.toFixed(2)));
}

/**
 * A line someone is actually waiting on an answer to.
 *
 * A question mark alone is not that. Transcribed speech is full of them — "да?", "понимаешь?",
 * "чё?" — and treating each as a question made this the normal path rather than the exception.
 * Either the line addresses the chat, or it is short enough to be a question rather than a ramble
 * that happens to contain one.
 */
function invitesAnAnswer(speech: string): boolean {
  if (/(?:^|\s)(?:чат|ребят|народ|парни|пацаны|guys|chat)/iu.test(speech)) return true;
  return /[?？]/.test(speech) && speech.length <= 120;
}
