import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger';
import { ContextStore } from '../src/stream-brain/context-store';
import { EventDetector } from '../src/stream-brain/event-detector';
import { MediaPipeline } from '../src/stream-brain/media-pipeline';
import { StreamBrainClient } from '../src/stream-brain/stream-brain.client';
import { StreamBrainService } from '../src/stream-brain/stream-brain.service';
import { UsageTracker } from '../src/usage/usage-tracker';

afterEach(() => vi.useRealTimers());

describe('StreamBrain paid-session lifecycle', () => {
  it('keeps Gemini completely stopped while Twitch stays offline for ten minutes', async () => {
    vi.useFakeTimers();
    const contextStore = new ContextStore({ chatWindowMs: 1_000, maxChatMessages: 10, maxEvents: 10 });
    contextStore.configure({ channel: 'offline-channel' });
    const gemini = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      sendAudio: vi.fn(),
      sendVideo: vi.fn(),
      updateContext: vi.fn(),
      isConnected: vi.fn(() => false),
    } satisfies StreamBrainClient;
    const media = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    } as unknown as MediaPipeline;
    const usage = new UsageTracker();
    const brain = new StreamBrainService({
      channel: 'offline-channel',
      contextStore,
      eventDetector: new EventDetector({ minimumConfidence: 0.4 }),
      gemini,
      media,
      usage,
      logger: new Logger('TEST', 'error'),
      contextRefreshMs: 1_000,
      enabled: true,
    });

    const serviceStart = brain.start();
    await Promise.resolve();
    expect(media.start).toHaveBeenCalledTimes(1);
    await serviceStart;
    brain.onMediaState('OFFLINE');
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(media.start).toHaveBeenCalledTimes(1);
    expect(gemini.start).not.toHaveBeenCalled();
    expect(gemini.updateContext).not.toHaveBeenCalled();
    expect(gemini.sendAudio).not.toHaveBeenCalled();
    expect(gemini.sendVideo).not.toHaveBeenCalled();
    expect(usage.snapshot()).toMatchObject({
      geminiReconnects: 0,
      geminiInputTokens: 0,
      geminiOutputTokens: 0,
    });
    await brain.stop();
  });

  it('opens one Gemini session only after STREAMING and stops it on OFFLINE', async () => {
    const contextStore = new ContextStore({ chatWindowMs: 1_000, maxChatMessages: 10, maxEvents: 10 });
    contextStore.configure({ channel: 'live-channel' });
    const gemini = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      sendAudio: vi.fn(),
      sendVideo: vi.fn(),
      updateContext: vi.fn(),
      isConnected: vi.fn(() => true),
    } satisfies StreamBrainClient;
    const media = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    } as unknown as MediaPipeline;
    const brain = new StreamBrainService({
      channel: 'live-channel',
      contextStore,
      eventDetector: new EventDetector({ minimumConfidence: 0.4 }),
      gemini,
      media,
      usage: new UsageTracker(),
      logger: new Logger('TEST', 'error'),
      contextRefreshMs: 100_000,
      enabled: true,
    });

    await brain.start();
    expect(gemini.start).not.toHaveBeenCalled();

    brain.onMediaState('STREAMING');
    await vi.waitFor(() => expect(gemini.start).toHaveBeenCalledTimes(1));
    brain.onMediaState('STREAMING');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gemini.start).toHaveBeenCalledTimes(1);

    brain.onMediaState('OFFLINE');
    await vi.waitFor(() => expect(gemini.stop).toHaveBeenCalledTimes(1));
    expect(brain.getStatus()).toMatchObject({
      state: 'OFFLINE',
      mediaState: 'OFFLINE',
      geminiState: 'STOPPED',
      mediaConnected: false,
      geminiConnected: false,
      geminiSessionActive: false,
      geminiSessionReason: 'twitch_offline',
    });
    await brain.stop();
  });

  it('cancels an in-flight Gemini start when media turns OFFLINE', async () => {
    let resolveStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => { resolveStart = resolve; });
    const contextStore = new ContextStore({ chatWindowMs: 1_000, maxChatMessages: 10, maxEvents: 10 });
    contextStore.configure({ channel: 'race-channel' });
    const gemini = {
      start: vi.fn(() => startGate),
      stop: vi.fn(),
      sendAudio: vi.fn(),
      sendVideo: vi.fn(),
      updateContext: vi.fn(),
      isConnected: vi.fn(() => false),
    } satisfies StreamBrainClient;
    const media = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    } as unknown as MediaPipeline;
    const brain = new StreamBrainService({
      channel: 'race-channel',
      contextStore,
      eventDetector: new EventDetector({ minimumConfidence: 0.4 }),
      gemini,
      media,
      usage: new UsageTracker(),
      logger: new Logger('TEST', 'error'),
      contextRefreshMs: 100_000,
      enabled: true,
    });

    const serviceStart = brain.start();
    await Promise.resolve();
    expect(media.start).toHaveBeenCalledTimes(1);
    await serviceStart;
    brain.onMediaState('STREAMING');
    await vi.waitFor(() => expect(gemini.start).toHaveBeenCalledTimes(1));
    brain.onMediaState('OFFLINE');
    resolveStart?.();

    await vi.waitFor(() => expect(gemini.stop).toHaveBeenCalled());
    expect(brain.getStatus()).toMatchObject({ mediaState: 'OFFLINE', geminiSessionActive: false });
    await brain.stop();
  });

  it('separates captured media from media actually sent to Gemini', async () => {
    const contextStore = new ContextStore({ chatWindowMs: 1_000, maxChatMessages: 10, maxEvents: 10 });
    contextStore.configure({ channel: 'usage-channel' });
    const gemini = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      sendAudio: vi.fn(() => true),
      sendVideo: vi.fn(() => true),
      updateContext: vi.fn(() => true),
      isConnected: vi.fn(() => false),
    } satisfies StreamBrainClient;
    const media = { start: vi.fn(), stop: vi.fn(async () => undefined) } as unknown as MediaPipeline;
    const usage = new UsageTracker();
    const brain = new StreamBrainService({
      channel: 'usage-channel', contextStore,
      eventDetector: new EventDetector({ minimumConfidence: 0.4 }),
      gemini, media, usage, logger: new Logger('TEST', 'error'), contextRefreshMs: 100_000, enabled: true,
    });

    await brain.start();
    brain.onMediaState('STREAMING');
    await vi.waitFor(() => expect(gemini.start).toHaveBeenCalledTimes(1));
    brain.sendAudio(Buffer.from([1]), 40);
    brain.sendVideo(Buffer.from([2]), 1_000);
    expect(usage.snapshot()).toMatchObject({
      capturedAudioMinutes: 40 / 60_000,
      capturedVideoMinutes: 1_000 / 60_000,
      geminiAudioSentMinutes: 0,
      geminiVideoSentMinutes: 0,
    });

    brain.onGeminiStatus(true);
    brain.sendAudio(Buffer.from([3]), 40);
    brain.sendVideo(Buffer.from([4]), 1_000);
    expect(usage.snapshot()).toMatchObject({
      capturedAudioMinutes: 80 / 60_000,
      capturedVideoMinutes: 2_000 / 60_000,
      geminiAudioSentMinutes: 40 / 60_000,
      geminiVideoSentMinutes: 1_000 / 60_000,
    });
    await brain.stop();
  });
});
