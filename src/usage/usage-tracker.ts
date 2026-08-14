export interface UsageSnapshot {
  startedAt: number;
  uptimeSeconds: number;
  streamMinutes: number;
  /** Backward-compatible aliases for billable media sent to Gemini. */
  audioMinutes: number;
  videoMinutes: number;
  capturedAudioMinutes: number;
  capturedVideoMinutes: number;
  geminiAudioSentMinutes: number;
  geminiVideoSentMinutes: number;
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
  currentStream: CurrentStreamUsageSnapshot;
}

export interface CurrentStreamUsageSnapshot {
  active: boolean;
  startedAt?: number;
  durationMinutes: number;
  capturedAudioMinutes: number;
  capturedVideoMinutes: number;
  geminiAudioSentMinutes: number;
  geminiVideoSentMinutes: number;
  geminiReconnects: number;
  geminiInputTokens: number;
  geminiOutputTokens: number;
  sentResponses: number;
}

export class UsageTracker {
  private readonly startedAt = Date.now();
  private streamStartedAt?: number;
  private accumulatedStreamMs = 0;
  private capturedAudioMs = 0;
  private capturedVideoMs = 0;
  private geminiAudioSentMs = 0;
  private geminiVideoSentMs = 0;
  private currentStreamStartedAt?: number;
  private currentStreamDurationMs = 0;
  private currentCapturedAudioMs = 0;
  private currentCapturedVideoMs = 0;
  private currentGeminiAudioSentMs = 0;
  private currentGeminiVideoSentMs = 0;
  private currentGeminiReconnects = 0;
  private currentGeminiInputTokens = 0;
  private currentGeminiOutputTokens = 0;
  private currentSentResponses = 0;
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

  startStream(now = Date.now()): void {
    if (this.streamStartedAt !== undefined) return;
    this.streamStartedAt = now;
    this.currentStreamStartedAt = now;
    this.currentStreamDurationMs = 0;
    this.currentCapturedAudioMs = 0;
    this.currentCapturedVideoMs = 0;
    this.currentGeminiAudioSentMs = 0;
    this.currentGeminiVideoSentMs = 0;
    this.currentGeminiReconnects = 0;
    this.currentGeminiInputTokens = 0;
    this.currentGeminiOutputTokens = 0;
    this.currentSentResponses = 0;
  }
  stopStream(now = Date.now()): void {
    if (this.streamStartedAt !== undefined) {
      const duration = Math.max(0, now - this.streamStartedAt);
      this.accumulatedStreamMs += duration;
      this.currentStreamDurationMs = duration;
    }
    this.streamStartedAt = undefined;
  }
  recordCapturedAudio(milliseconds: number): void {
    const duration = Math.max(0, milliseconds);
    this.capturedAudioMs += duration;
    if (this.streamStartedAt !== undefined) this.currentCapturedAudioMs += duration;
  }
  recordCapturedVideo(milliseconds: number): void {
    const duration = Math.max(0, milliseconds);
    this.capturedVideoMs += duration;
    if (this.streamStartedAt !== undefined) this.currentCapturedVideoMs += duration;
  }
  recordGeminiAudioSent(milliseconds: number): void {
    const duration = Math.max(0, milliseconds);
    this.geminiAudioSentMs += duration;
    if (this.streamStartedAt !== undefined) this.currentGeminiAudioSentMs += duration;
  }
  recordGeminiVideoSent(milliseconds: number): void {
    const duration = Math.max(0, milliseconds);
    this.geminiVideoSentMs += duration;
    if (this.streamStartedAt !== undefined) this.currentGeminiVideoSentMs += duration;
  }
  recordGeminiReconnect(): void {
    this.geminiReconnects += 1;
    if (this.streamStartedAt !== undefined) this.currentGeminiReconnects += 1;
  }
  recordGeminiTokens(input = 0, output = 0): void {
    const safeInput = Math.max(0, input);
    const safeOutput = Math.max(0, output);
    this.geminiInputTokens += safeInput;
    this.geminiOutputTokens += safeOutput;
    if (this.streamStartedAt !== undefined) {
      this.currentGeminiInputTokens += safeInput;
      this.currentGeminiOutputTokens += safeOutput;
    }
  }
  recordGeminiToolCall(): void { this.geminiToolCalls += 1; }
  recordReactionContextPrepared(): void { this.preparedReactionContexts += 1; }
  recordReactionBatch(): void { this.reactionBatches += 1; }
  recordEmptyReactionBatch(): void { this.emptyReactionBatches += 1; this.skippedResponses += 1; }
  recordGuardRejection(): void { this.guardRejections += 1; }
  recordEventDetected(): void { this.eventsDetected += 1; }
  recordGenerated(count = 1): void { this.generatedResponses += Math.max(0, count); }
  recordSentResponse(): void {
    this.sentResponses += 1;
    if (this.streamStartedAt !== undefined) this.currentSentResponses += 1;
  }
  recordSkipped(): void { this.skippedResponses += 1; }
  recordMemoryToolCall(): void { this.memoryToolCalls += 1; }
  recordMemoryCreated(count = 1): void { this.memoriesCreated += Math.max(0, count); }
  recordMemoryMerged(count = 1): void { this.memoriesMerged += Math.max(0, count); }
  recordMemorySuperseded(count = 1): void { this.memoriesSuperseded += Math.max(0, count); }
  recordMemoryRetrieval(): void { this.memoryRetrievals += 1; }

  snapshot(now = Date.now()): UsageSnapshot {
    const activeMs = this.streamStartedAt === undefined ? 0 : Math.max(0, now - this.streamStartedAt);
    const currentDurationMs = this.streamStartedAt === undefined ? this.currentStreamDurationMs : activeMs;
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor((now - this.startedAt) / 1000),
      streamMinutes: (this.accumulatedStreamMs + activeMs) / 60_000,
      audioMinutes: this.geminiAudioSentMs / 60_000,
      videoMinutes: this.geminiVideoSentMs / 60_000,
      capturedAudioMinutes: this.capturedAudioMs / 60_000,
      capturedVideoMinutes: this.capturedVideoMs / 60_000,
      geminiAudioSentMinutes: this.geminiAudioSentMs / 60_000,
      geminiVideoSentMinutes: this.geminiVideoSentMs / 60_000,
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
      currentStream: {
        active: this.streamStartedAt !== undefined,
        ...(this.currentStreamStartedAt !== undefined ? { startedAt: this.currentStreamStartedAt } : {}),
        durationMinutes: currentDurationMs / 60_000,
        capturedAudioMinutes: this.currentCapturedAudioMs / 60_000,
        capturedVideoMinutes: this.currentCapturedVideoMs / 60_000,
        geminiAudioSentMinutes: this.currentGeminiAudioSentMs / 60_000,
        geminiVideoSentMinutes: this.currentGeminiVideoSentMs / 60_000,
        geminiReconnects: this.currentGeminiReconnects,
        geminiInputTokens: this.currentGeminiInputTokens,
        geminiOutputTokens: this.currentGeminiOutputTokens,
        sentResponses: this.currentSentResponses,
      },
    };
  }
}
