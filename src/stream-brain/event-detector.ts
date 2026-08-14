import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  STREAM_EVENT_TYPES,
  StreamEvent,
  StreamEventCandidate,
  StreamEventSource,
} from './types';

const candidateSchema = z.object({
  type: z.enum(STREAM_EVENT_TYPES),
  summary: z.string().trim().min(3).max(500),
  speech: z.string().trim().max(1_000).optional(),
  visualContext: z.string().trim().max(1_000).optional(),
  gameContext: z.string().trim().max(1_000).optional(),
  emotion: z.string().trim().max(100).optional(),
  importance: z.coerce.number().finite().min(0).max(1),
  confidence: z.coerce.number().finite().min(0).max(1),
  timestamp: z.coerce.number().finite().positive().optional(),
  directMentions: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
}).strict();

export interface EventDetectorOptions {
  minimumConfidence: number;
  now?: () => number;
}

export interface EventNormalizationContext {
  category?: string;
  timestamp?: number;
  source?: StreamEventSource;
  botUsernames?: string[];
  mentionMatcher?: import('../shared/bot-mention-matcher').BotMentionMatcher;
}

export class EventDetector {
  private readonly minimumConfidence: number;
  private readonly now: () => number;

  constructor(options: EventDetectorOptions) {
    this.minimumConfidence = Math.max(0, Math.min(1, options.minimumConfidence));
    this.now = options.now ?? Date.now;
  }

  normalize(raw: unknown, context: EventNormalizationContext = {}): StreamEvent | null {
    const value = this.parseRaw(raw);
    const result = candidateSchema.safeParse(value);
    if (!result.success || result.data.confidence < this.minimumConfidence) return null;

    const candidate: StreamEventCandidate = result.data;
    const allowedBots = new Set(context.botUsernames?.map((n) => n.toLowerCase()) ?? []);
    const directMentions = new Set(
      (candidate.directMentions ?? [])
        .map((name) => name.replace(/^@/, '').toLowerCase())
        .filter((name) => allowedBots.has(name)),
    );
    const searchable = [candidate.summary, candidate.speech].filter(Boolean).join(' ').toLowerCase();

    if (context.mentionMatcher) {
      for (const username of context.mentionMatcher.match(searchable)) {
        if (allowedBots.has(username)) directMentions.add(username);
      }
    } else {
      for (const username of context.botUsernames ?? []) {
        const normalized = username.toLowerCase();
        const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(?:^|[^a-z0-9_])@?${escaped}(?:$|[^a-z0-9_])`, 'i').test(searchable)) {
          directMentions.add(normalized);
        }
      }
    }

    return {
      id: randomUUID(),
      timestamp: context.timestamp ?? candidate.timestamp ?? this.now(),
      type: candidate.type,
      summary: candidate.summary,
      ...(candidate.speech ? { speech: candidate.speech } : {}),
      ...(candidate.visualContext ? { visualContext: candidate.visualContext } : {}),
      ...(candidate.gameContext ? { gameContext: candidate.gameContext } : {}),
      ...(candidate.emotion ? { emotion: candidate.emotion } : {}),
      ...(context.category ? { category: context.category } : {}),
      importance: candidate.importance,
      confidence: candidate.confidence,
      source: context.source ?? 'gemini-live',
      directMentions: [...directMentions],
    };
  }

  private parseRaw(raw: unknown): unknown {
    if (typeof raw !== 'string') return raw;
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
}
