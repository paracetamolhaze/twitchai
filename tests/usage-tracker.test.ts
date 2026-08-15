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

  it('uses exact Live modalities and Interactions cached/thinking counters for cost observability', () => {
    const usage = new UsageTracker();
    usage.startStream(0);
    usage.recordGeminiLiveUsage({
      inputTokens: 300_000,
      outputTokens: 50_000,
      inputByModality: [
        { modality: 'TEXT', tokenCount: 100_000 },
        { modality: 'AUDIO', tokenCount: 200_000 },
      ],
      outputByModality: [{ modality: 'TEXT', tokenCount: 50_000 }],
    });
    usage.recordBrainInteraction({
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 100_000,
      thoughtTokens: 50_000,
      totalTokens: 1_150_000,
    }, { decision: true, latencyMs: 1_200 });
    usage.recordEventDetected();
    usage.recordSentResponse();

    const snapshot = usage.snapshot(3_600_000);
    expect(snapshot.perception).toMatchObject({
      inputTokens: 300_000,
      outputTokens: 50_000,
      inputTokensByModality: { text: 100_000, audio: 200_000 },
    });
    expect(snapshot.brain).toMatchObject({
      interactions: 1,
      decisions: 1,
      cachedInputTokens: 400_000,
      thinkingTokens: 50_000,
      averageLatencyMs: 1_200,
    });
    expect(snapshot.perception.estimatedCostUsd).toBeCloseTo(0.9, 8);
    expect(snapshot.brain.estimatedCostUsd).toBeCloseTo(1.0425, 8);
    expect(snapshot.currentStream.totalAi).toMatchObject({
      eventsPerHour: 1,
      brainDecisionsPerHour: 1,
      messagesPerHour: 1,
    });
    expect(snapshot.currentStream.totalAi.estimatedCostUsd).toBeCloseTo(1.9425, 8);
    expect(snapshot.currentStream.totalAi.estimatedCostPerHourUsd).toBeCloseTo(1.9425, 8);
  });
});
