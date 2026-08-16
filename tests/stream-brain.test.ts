import { describe, expect, it } from 'vitest';
import { EventDetector } from '../src/stream-brain/event-detector';
import { ContextStore } from '../src/stream-brain/context-store';
import { StreamBrainService } from '../src/stream-brain/stream-brain.service';
import { Logger } from '../src/logger';
import { UsageTracker } from '../src/usage/usage-tracker';

describe('perception media flow', () => {
  it('does not hold the tool call open waiting for the event to be persisted', async () => {
    // Realtime media is dropped, not buffered, for as long as a tool batch is outstanding, so a
    // database round trip inside the tool call silenced the stream: production delivered about 9%
    // of both audio and video, and perception was left describing scenes it had barely seen.
    let releaseSave = (): void => {};
    const saved = new Promise<void>((resolve) => { releaseSave = resolve; });
    const service = new StreamBrainService({
      channel: 'streamer',
      contextStore: new ContextStore({ chatWindowMs: 120_000, maxChatMessages: 100, maxEvents: 100 }),
      eventDetector: new EventDetector({ minimumConfidence: 0.4 }),
      eventSink: { saveStreamEvent: async () => saved } as never,
      usage: new UsageTracker(),
      logger: new Logger('TEST', 'error'),
      contextRefreshMs: 30_000,
      enabled: false,
      eventDeduplicationWindowMs: 0,
    });

    const accepted = await Promise.race([
      service.acceptCandidate({
        type: 'visual', summary: 'Стример показал экран.', importance: 0.7, confidence: 0.9,
      }),
      new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 50)),
    ]);
    expect(accepted).not.toBe('still-waiting');
    releaseSave();
  });
});

describe('StreamBrain event normalization', () => {
  const detector = new EventDetector({ minimumConfidence: 0.2 });

  it('normalizes a valid multimodal candidate', () => {
    const event = detector.normalize({
      type: 'fail',
      summary: 'streamer missed Black Hole and lost the fight',
      speech: 'ну всё приехали',
      visualContext: 'Enigma cast the ultimate away from every enemy',
      gameContext: 'Dota 2 ranked match',
      emotion: 'frustrated',
      importance: 0.91,
      confidence: 0.94,
    }, { category: 'Dota 2', timestamp: 1_700_000_000_000 });

    expect(event).toMatchObject({
      type: 'fail',
      summary: 'streamer missed Black Hole and lost the fight',
      category: 'Dota 2',
      importance: 0.91,
      confidence: 0.94,
      timestamp: 1_700_000_000_000,
    });
    expect(event?.id).toEqual(expect.any(String));
  });

  it('rejects malformed and very low-confidence candidates', () => {
    expect(detector.normalize('{not json', { category: 'Dota 2' })).toBeNull();
    expect(detector.normalize({
      type: 'gameplay',
      summary: 'something moved',
      importance: 0.4,
      confidence: 0.05,
    }, { category: 'Dota 2' })).toBeNull();
  });

  it('ignores hallucinated direct mentions that are not configured bot usernames', () => {
    const event = detector.normalize({
      type: 'conversation',
      summary: 'someone called a viewer',
      importance: 0.7,
      confidence: 0.9,
      directMentions: ['not-a-bot', 'real-bot'],
    }, { botUsernames: ['real-bot'] });
    expect(event?.directMentions).toEqual(['real-bot']);
  });
});
