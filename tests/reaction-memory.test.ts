import { describe, expect, it } from 'vitest';
import { ReactionMemory } from '../src/learning/reaction-memory';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { StreamContextSnapshot, StreamEvent } from '../src/stream-brain/types';

describe('ReactionMemory', () => {
  it('persists event → real-chat reactions and retrieves a similar event', async () => {
    const repository = new MemoryRepository();
    const now = 10_000;
    const memory = new ReactionMemory({ enabled: true, reactionWindowMs: 1_000, repository, now: () => now });
    const event: StreamEvent = {
      id: 'event-1', timestamp: now, type: 'fail', summary: 'streamer died after aggressive dive',
      speech: 'ну всё приехали', importance: 0.9, confidence: 0.95, source: 'gemini-live', directMentions: [],
    };
    const snapshot: StreamContextSnapshot = {
      channel: 'channel', category: 'Dota 2', streamContext: 'ranked with friends', isLive: true,
      recentChat: [], recentEvents: [], botUsernames: [], updatedAt: now,
    };
    memory.recordEvent(event, snapshot);
    memory.recordChat({ id: 'chat-1', timestamp: now + 200, username: 'viewer', displayName: 'viewer', message: 'зачем туда полез', kind: 'viewer' });
    await memory.flushDue(now + 2_000);

    const stored = await repository.listReactionExamples(10);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ event: event.summary, game: 'Dota 2', chatMessages: ['зачем туда полез'] });
    expect(await memory.retrieve({ ...event, id: 'event-2', summary: 'aggressive dive ended in a death' }, snapshot, 3)).toHaveLength(1);
    expect('generate' in memory).toBe(false);
  });
});
