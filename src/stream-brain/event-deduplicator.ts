import { tokenSimilarity } from '../shared/similarity';
import { StreamEvent } from './types';

export interface DeduplicatedStreamEvent {
  event: StreamEvent;
  isNew: boolean;
}

/** Lightweight deterministic merge for repeated Live observations of one moment. */
export class StreamEventDeduplicator {
  private readonly recent: StreamEvent[] = [];

  constructor(private readonly windowMs = 1_000, private readonly similarityThreshold = 0.34) {}

  accept(event: StreamEvent): DeduplicatedStreamEvent {
    const cutoff = event.timestamp - this.windowMs;
    while (this.recent[0] && this.recent[0].timestamp < cutoff) this.recent.shift();
    const duplicate = [...this.recent]
      .reverse()
      .find((candidate) => this.sameMoment(candidate, event));
    if (!duplicate) {
      this.recent.push(event);
      return { event, isNew: true };
    }

    const merged = mergeEvents(duplicate, event);
    const index = this.recent.findIndex((candidate) => candidate.id === duplicate.id);
    if (index >= 0) this.recent[index] = merged;
    return { event: merged, isNew: false };
  }

  clear(): void { this.recent.splice(0); }

  settleWindowMs(): number { return this.windowMs === 0 ? 0 : this.windowMs + 10; }

  private sameMoment(left: StreamEvent, right: StreamEvent): boolean {
    if (Math.abs(left.timestamp - right.timestamp) > this.windowMs) return false;
    const leftText = [left.summary, left.speech, left.visualContext, left.gameContext].filter(Boolean).join(' ');
    const rightText = [right.summary, right.speech, right.visualContext, right.gameContext].filter(Boolean).join(' ');
    const summaryScore = tokenSimilarity(normalizeEventLanguage(left.summary), normalizeEventLanguage(right.summary));
    const completeScore = tokenSimilarity(normalizeEventLanguage(leftText), normalizeEventLanguage(rightText));
    return Math.max(summaryScore, completeScore) >= this.similarityThreshold;
  }
}

function normalizeEventLanguage(value: string): string {
  return value
    .toLocaleLowerCase('ru')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .map((token) => {
      if (/^(?:умер|погиб|убит|смерт)/u.test(token)) return 'death';
      if (/^(?:стример|персонаж)/u.test(token)) return 'streamer';
      return token;
    })
    .join(' ');
}

function mergeEvents(first: StreamEvent, repeated: StreamEvent): StreamEvent {
  const directMentions = [...new Set([...first.directMentions, ...repeated.directMentions])];
  return {
    ...first,
    type: directMentions.length > 0
      ? 'direct_mention'
      : repeated.importance > first.importance ? repeated.type : first.type,
    summary: mergeText(first.summary, repeated.summary, 500),
    ...(mergeOptional(first.speech, repeated.speech, 1_000) ? { speech: mergeOptional(first.speech, repeated.speech, 1_000) } : {}),
    ...(mergeOptional(first.visualContext, repeated.visualContext, 1_000)
      ? { visualContext: mergeOptional(first.visualContext, repeated.visualContext, 1_000) }
      : {}),
    ...(mergeOptional(first.gameContext, repeated.gameContext, 1_000)
      ? { gameContext: mergeOptional(first.gameContext, repeated.gameContext, 1_000) }
      : {}),
    ...(repeated.emotion ?? first.emotion ? { emotion: repeated.emotion ?? first.emotion } : {}),
    importance: Math.max(first.importance, repeated.importance),
    confidence: Math.max(first.confidence, repeated.confidence),
    directMentions,
    ...(repeated.viewerUsername ?? first.viewerUsername
      ? { viewerUsername: repeated.viewerUsername ?? first.viewerUsername }
      : {}),
  };
}

function mergeOptional(first: string | undefined, second: string | undefined, limit: number): string | undefined {
  if (!first) return second?.slice(0, limit);
  if (!second || first === second || first.includes(second)) return first.slice(0, limit);
  if (second.includes(first)) return second.slice(0, limit);
  return `${first} ${second}`.slice(0, limit);
}

function mergeText(first: string, second: string, limit: number): string {
  return mergeOptional(first, second, limit) ?? first.slice(0, limit);
}
