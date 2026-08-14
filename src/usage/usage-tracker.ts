export interface UsageSnapshot {
  startedAt: number;
  uptimeSeconds: number;
  streamMinutes: number;
  audioMinutes: number;
  videoMinutes: number;
  geminiReconnects: number;
  geminiInputTokens: number;
  geminiOutputTokens: number;
  geminiToolCalls: number;
  preparedReactionContexts: number;
  reactionBatches: number;
  emptyReactionBatches: number;
  guardRejections: number;
  eventsDetected: number;
  generatedResponses: number;
  sentResponses: number;
  skippedResponses: number;
  memoryToolCalls: number;
  memoriesCreated: number;
  memoriesMerged: number;
  memoriesSuperseded: number;
  memoryRetrievals: number;
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
  private geminiToolCalls = 0;
  private preparedReactionContexts = 0;
  private reactionBatches = 0;
  private emptyReactionBatches = 0;
  private guardRejections = 0;
  private eventsDetected = 0;
  private generatedResponses = 0;
  private sentResponses = 0;
  private skippedResponses = 0;
  private memoryToolCalls = 0;
  private memoriesCreated = 0;
  private memoriesMerged = 0;
  private memoriesSuperseded = 0;
  private memoryRetrievals = 0;

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
  recordGeminiToolCall(): void { this.geminiToolCalls += 1; }
  recordReactionContextPrepared(): void { this.preparedReactionContexts += 1; }
  recordReactionBatch(): void { this.reactionBatches += 1; }
  recordEmptyReactionBatch(): void { this.emptyReactionBatches += 1; this.skippedResponses += 1; }
  recordGuardRejection(): void { this.guardRejections += 1; }
  recordEventDetected(): void { this.eventsDetected += 1; }
  recordGenerated(count = 1): void { this.generatedResponses += Math.max(0, count); }
  recordSentResponse(): void { this.sentResponses += 1; }
  recordSkipped(): void { this.skippedResponses += 1; }
  recordMemoryToolCall(): void { this.memoryToolCalls += 1; }
  recordMemoryCreated(count = 1): void { this.memoriesCreated += Math.max(0, count); }
  recordMemoryMerged(count = 1): void { this.memoriesMerged += Math.max(0, count); }
  recordMemorySuperseded(count = 1): void { this.memoriesSuperseded += Math.max(0, count); }
  recordMemoryRetrieval(): void { this.memoryRetrievals += 1; }

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
      geminiToolCalls: this.geminiToolCalls,
      preparedReactionContexts: this.preparedReactionContexts,
      reactionBatches: this.reactionBatches,
      emptyReactionBatches: this.emptyReactionBatches,
      guardRejections: this.guardRejections,
      eventsDetected: this.eventsDetected,
      generatedResponses: this.generatedResponses,
      sentResponses: this.sentResponses,
      skippedResponses: this.skippedResponses,
      memoryToolCalls: this.memoryToolCalls,
      memoriesCreated: this.memoriesCreated,
      memoriesMerged: this.memoriesMerged,
      memoriesSuperseded: this.memoriesSuperseded,
      memoryRetrievals: this.memoryRetrievals,
    };
  }
}
