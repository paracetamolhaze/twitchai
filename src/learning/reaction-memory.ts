import { randomUUID } from 'node:crypto';
import { Logger } from '../logger';
import { AppRepository } from '../persistence/repository';
import { tokenSimilarity } from '../shared/similarity';
import { ChatMessage, StreamContextSnapshot, StreamEvent } from '../stream-brain/types';
import { ReactionExample } from './types';

interface PendingExample {
  event: StreamEvent;
  snapshot: StreamContextSnapshot;
  chatMessages: string[];
  expiresAt: number;
  timer?: NodeJS.Timeout;
}

export interface ReactionMemoryOptions {
  enabled: boolean;
  reactionWindowMs: number;
  repository: AppRepository;
  logger?: Logger;
  now?: () => number;
}

export class ReactionMemory {
  private readonly pending = new Map<string, PendingExample>();
  private readonly now: () => number;
  private readonly logger?: Logger;

  constructor(private readonly options: ReactionMemoryOptions) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger?.child('LEARN');
  }

  recordEvent(event: StreamEvent, snapshot: StreamContextSnapshot): void {
    if (!this.options.enabled) return;
    const priorChat = snapshot.recentChat
      .filter((message) => message.kind === 'viewer' && message.timestamp >= event.timestamp - 5_000)
      .map((message) => message.message);
    const pending: PendingExample = {
      event,
      snapshot,
      chatMessages: [...new Set(priorChat)],
      expiresAt: this.now() + this.options.reactionWindowMs,
    };
    pending.timer = setTimeout(() => { void this.flush(event.id); }, this.options.reactionWindowMs);
    this.pending.set(event.id, pending);
  }

  recordChat(message: ChatMessage): void {
    if (!this.options.enabled || message.kind !== 'viewer') return;
    for (const pending of this.pending.values()) {
      if (message.timestamp >= pending.event.timestamp && message.timestamp <= pending.expiresAt) {
        if (!pending.chatMessages.includes(message.message)) pending.chatMessages.push(message.message);
      }
    }
  }

  async flushDue(now = this.now()): Promise<void> {
    await Promise.all([...this.pending.entries()]
      .filter(([, pending]) => pending.expiresAt <= now)
      .map(([id]) => this.flush(id)));
  }

  async retrieve(event: StreamEvent, snapshot: StreamContextSnapshot, limit: number): Promise<ReactionExample[]> {
    const examples = await this.options.repository.listReactionExamples(500);
    const target = `${event.type} ${event.summary} ${event.speech ?? ''} ${event.gameContext ?? ''} ${snapshot.category}`;
    return examples
      .map((example) => ({
        example,
        score: tokenSimilarity(
          target,
          `${example.eventType} ${example.event} ${example.transcript ?? ''} ${example.game}`,
        ) + (example.eventType === event.type ? 0.25 : 0) + (example.game === snapshot.category ? 0.15 : 0),
      }))
      .filter(({ score }) => score >= 0.18)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ example }) => example);
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) if (pending.timer) clearTimeout(pending.timer);
    await Promise.all([...this.pending.keys()].map((id) => this.flush(id)));
  }

  private async flush(id: string): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.chatMessages.length === 0) return;
    const example: ReactionExample = {
      id: randomUUID(),
      timestamp: pending.event.timestamp,
      game: pending.snapshot.category,
      streamContext: pending.snapshot.streamContext,
      eventType: pending.event.type,
      event: pending.event.summary,
      chatMessages: pending.chatMessages.slice(0, 50),
      ...(pending.event.speech ? { transcript: pending.event.speech } : {}),
    };
    try {
      await this.options.repository.saveReactionExample(example);
    } catch (cause) {
      this.logger?.warn('Reaction example persistence failed', { eventId: pending.event.id, cause });
    }
  }
}
