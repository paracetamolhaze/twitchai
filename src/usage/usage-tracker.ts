export interface UsageSnapshot {
  startedAt: number;
  uptimeSeconds: number;
  streamMinutes: number;
  audioMinutes: number;
  videoMinutes: number;
  geminiReconnects: number;
  geminiInputTokens: number;
  geminiOutputTokens: number;
  generatedResponses: number;
  skippedResponses: number;
}

export class UsageTracker {
  private readonly startedAt = Date.now();
  private streamStartedAt?: number;
  private accumulatedStreamMs = 0;
  private audioMs = 0;
  private videoMs = 0;
  private geminiReconnects = 0;
  private geminiInputTokens = 0;
  private geminiOutputTokens = 0;
  private generatedResponses = 0;
  private skippedResponses = 0;

  startStream(now = Date.now()): void { this.streamStartedAt ??= now; }
  stopStream(now = Date.now()): void {
    if (this.streamStartedAt !== undefined) this.accumulatedStreamMs += Math.max(0, now - this.streamStartedAt);
    this.streamStartedAt = undefined;
  }
  recordAudio(milliseconds: number): void { this.audioMs += Math.max(0, milliseconds); }
  recordVideo(milliseconds: number): void { this.videoMs += Math.max(0, milliseconds); }
  recordGeminiReconnect(): void { this.geminiReconnects += 1; }
  recordGeminiTokens(input = 0, output = 0): void {
    this.geminiInputTokens += Math.max(0, input);
    this.geminiOutputTokens += Math.max(0, output);
  }
  recordGenerated(): void { this.generatedResponses += 1; }
  recordSkipped(): void { this.skippedResponses += 1; }

  snapshot(now = Date.now()): UsageSnapshot {
    const activeMs = this.streamStartedAt === undefined ? 0 : Math.max(0, now - this.streamStartedAt);
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor((now - this.startedAt) / 1000),
      streamMinutes: (this.accumulatedStreamMs + activeMs) / 60_000,
      audioMinutes: this.audioMs / 60_000,
      videoMinutes: this.videoMs / 60_000,
      geminiReconnects: this.geminiReconnects,
      geminiInputTokens: this.geminiInputTokens,
      geminiOutputTokens: this.geminiOutputTokens,
      generatedResponses: this.generatedResponses,
      skippedResponses: this.skippedResponses,
    };
  }
}
