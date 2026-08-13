import { describe, expect, it } from 'vitest';
import { Logger } from '../src/logger';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { ContextStore } from '../src/stream-brain/context-store';
import { EventDetector } from '../src/stream-brain/event-detector';
import { GeminiLiveClient } from '../src/stream-brain/gemini-live.client';
import { MediaPipeline } from '../src/stream-brain/media-pipeline';
import { StreamBrainService } from '../src/stream-brain/stream-brain.service';
import { UsageTracker } from '../src/usage/usage-tracker';

describe('StreamBrain connection status', () => {
  it('recovers to CONNECTED after a Gemini disconnect/reconnect', async () => {
    const fakeGemini = {
      start: async () => undefined, stop: () => undefined, sendAudio: () => undefined, sendVideo: () => undefined, updateContext: () => undefined,
    } as unknown as GeminiLiveClient;
    const fakeMedia = { start: () => undefined, stop: async () => undefined } as unknown as MediaPipeline;
    const brain = new StreamBrainService({
      channel: 'channel', contextStore: new ContextStore({ chatWindowMs: 1000, maxChatMessages: 10, maxEvents: 10 }),
      eventDetector: new EventDetector({ minimumConfidence: 0.4 }), gemini: fakeGemini, media: fakeMedia,
      eventSink: new MemoryRepository(), usage: new UsageTracker(), logger: new Logger('TEST', 'error'),
      contextRefreshMs: 100_000, enabled: true,
    });
    await brain.start();
    brain.onMediaState('STREAMING');
    brain.onGeminiStatus(false, 'temporary disconnect');
    expect(brain.getStatus().state).toBe('ERROR');
    brain.onGeminiStatus(true);
    expect(brain.getStatus()).toMatchObject({ state: 'CONNECTED', mediaConnected: true, geminiConnected: true });
    await brain.stop();
  });
});
