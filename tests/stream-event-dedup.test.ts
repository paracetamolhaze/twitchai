import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { ContextStore } from '../src/stream-brain/context-store';
import { EventDetector } from '../src/stream-brain/event-detector';
import { StreamBrainService } from '../src/stream-brain/stream-brain.service';
import { StreamEvent } from '../src/stream-brain/types';
import { UsageTracker } from '../src/usage/usage-tracker';

describe('StreamEvent ingestion deduplication', () => {
  it('merges repeated descriptions of one moment without losing a direct mention', async () => {
    vi.useFakeTimers();
    let now = 1_700_000_000_000;
    const repository = new MemoryRepository();
    await repository.initialize();
    const contextStore = new ContextStore({
      chatWindowMs: 120_000, maxChatMessages: 50, maxEvents: 50, now: () => now,
    });
    contextStore.configure({ category: 'Counter-Strike 2', botUsernames: ['karlbekner'] });
    const service = new StreamBrainService({
      channel: 'streamer',
      contextStore,
      eventDetector: new EventDetector({ minimumConfidence: 0.2, now: () => now }),
      eventSink: repository,
      usage: new UsageTracker(),
      logger: new Logger('TEST', 'error'),
      contextRefreshMs: 10_000,
      enabled: true,
      eventDeduplicationWindowMs: 1_000,
    });
    const emitted: StreamEvent[] = [];
    service.on('event', (event: StreamEvent) => emitted.push(event));

    const first = await service.acceptCandidate({
      type: 'loss',
      summary: 'Стример умер.',
      importance: 0.86,
      confidence: 0.94,
    });
    now += 800;
    const repeated = await service.acceptCandidate({
      type: 'direct_mention',
      summary: 'Персонаж стримера погиб.',
      speech: 'karlbekner ну ты видел?',
      directMentions: ['karlbekner'],
      importance: 0.92,
      confidence: 0.96,
    });
    await vi.advanceTimersByTimeAsync(1_010);

    expect(repeated?.id).toBe(first?.id);
    expect(repeated?.directMentions).toEqual(['karlbekner']);
    expect(emitted).toEqual([
      expect.objectContaining({ id: first?.id, directMentions: ['karlbekner'] }),
    ]);
    expect(contextStore.snapshot().recentEvents).toHaveLength(1);
    expect(await repository.listStreamEvents(10)).toEqual([
      expect.objectContaining({ id: first?.id, directMentions: ['karlbekner'] }),
    ]);
  });
});

afterEach(() => vi.useRealTimers());
