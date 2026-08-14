import { describe, expect, it } from 'vitest';
import { UsageTracker } from '../src/usage/usage-tracker';

describe('UsageTracker stream and billable media counters', () => {
  it('separates captured media from Gemini-sent media and resets only current-stream counters', () => {
    const usage = new UsageTracker();
    usage.startStream(1_000);
    usage.recordCapturedAudio(60_000);
    usage.recordCapturedVideo(20_000);
    usage.recordGeminiAudioSent(30_000);
    usage.recordGeminiVideoSent(5_000);
    usage.recordGeminiReconnect();
    usage.recordGeminiTokens(120, 30);
    usage.recordSentResponse();
    usage.stopStream(61_000);

    expect(usage.snapshot(61_000)).toMatchObject({
      capturedAudioMinutes: 1,
      capturedVideoMinutes: 1 / 3,
      geminiAudioSentMinutes: .5,
      geminiVideoSentMinutes: 1 / 12,
      audioMinutes: .5,
      videoMinutes: 1 / 12,
      currentStream: {
        active: false,
        durationMinutes: 1,
        geminiReconnects: 1,
        geminiInputTokens: 120,
        geminiOutputTokens: 30,
        sentResponses: 1,
      },
    });

    usage.startStream(120_000);
    expect(usage.snapshot(120_000)).toMatchObject({
      capturedAudioMinutes: 1,
      geminiAudioSentMinutes: .5,
      geminiReconnects: 1,
      geminiInputTokens: 120,
      sentResponses: 1,
      currentStream: {
        active: true,
        startedAt: 120_000,
        durationMinutes: 0,
        capturedAudioMinutes: 0,
        capturedVideoMinutes: 0,
        geminiAudioSentMinutes: 0,
        geminiVideoSentMinutes: 0,
        geminiReconnects: 0,
        geminiInputTokens: 0,
        geminiOutputTokens: 0,
        sentResponses: 0,
      },
    });
  });
});
