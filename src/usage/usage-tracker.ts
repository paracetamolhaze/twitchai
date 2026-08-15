export interface TokenModalityUsage {
  text: number;
  audio: number;
  video: number;
  other: number;
}

export interface PerceptionUsageSnapshot {
  sessionDurationMinutes: number;
  audioSentMinutes: number;
  videoSentMinutes: number;
  inputTokens: number;
  outputTokens: number;
  inputTokensByModality: TokenModalityUsage;
  outputTokensByModality: TokenModalityUsage;
  toolCalls: number;
  events: number;
  estimatedCostUsd: number;
}

export interface BrainUsageSnapshot {
  interactions: number;
  decisions: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  averageLatencyMs: number;
  lastLatencyMs?: number;
  estimatedCostUsd: number;
}

export interface TotalAiUsageSnapshot {
  estimatedCostUsd: number;
  estimatedCostPerHourUsd: number;
  eventsPerHour: number;
  brainDecisionsPerHour: number;
  messagesPerHour: number;
}

export interface UsageSnapshot {
  startedAt: number;
  uptimeSeconds: number;
  streamMinutes: number;
  /** Backward-compatible aliases for existing API consumers. */
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
  perception: PerceptionUsageSnapshot;
  brain: BrainUsageSnapshot;
  totalAi: TotalAiUsageSnapshot;
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
  perception: PerceptionUsageSnapshot;
  brain: BrainUsageSnapshot;
  totalAi: TotalAiUsageSnapshot;
}

export interface BrainInteractionUsageInput {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
}

export interface GeminiLiveUsageInput {
  inputTokens: number;
  outputTokens: number;
  inputByModality?: Array<{ modality?: string; tokenCount?: number }>;
  outputByModality?: Array<{ modality?: string; tokenCount?: number }>;
}

const MILLION = 1_000_000;
const LIVE_INPUT_PRICE = { text: 0.75, audio: 3, video: 1, other: 0.75 } as const;
const LIVE_OUTPUT_PRICE = { text: 4.5, audio: 12, video: 4.5, other: 4.5 } as const;
const BRAIN_INPUT_PRICE = 0.75;
const BRAIN_CACHED_INPUT_PRICE = 0.075;
const BRAIN_OUTPUT_PRICE = 3.75;

interface MutableBrainUsage extends BrainInteractionUsageInput {
  interactions: number;
  decisions: number;
  totalLatencyMs: number;
  lastLatencyMs?: number;
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
  private currentEventsDetected = 0;
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
  private readonly liveInputByModality = emptyModalities();
  private readonly liveOutputByModality = emptyModalities();
  private currentLiveInputByModality = emptyModalities();
  private currentLiveOutputByModality = emptyModalities();
  private readonly brainUsage = emptyBrainUsage();
  private currentBrainUsage = emptyBrainUsage();

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
    this.currentEventsDetected = 0;
    this.currentLiveInputByModality = emptyModalities();
    this.currentLiveOutputByModality = emptyModalities();
    this.currentBrainUsage = emptyBrainUsage();
  }

  stopStream(now = Date.now()): void {
    if (this.streamStartedAt !== undefined) {
      const duration = Math.max(0, now - this.streamStartedAt);
      this.accumulatedStreamMs += duration;
      this.currentStreamDurationMs = duration;
    }
    this.streamStartedAt = undefined;
  }

  recordCapturedAudio(milliseconds: number): void { this.addDuration('audio', milliseconds, false); }
  recordCapturedVideo(milliseconds: number): void { this.addDuration('video', milliseconds, false); }
  recordGeminiAudioSent(milliseconds: number): void { this.addDuration('audio', milliseconds, true); }
  recordGeminiVideoSent(milliseconds: number): void { this.addDuration('video', milliseconds, true); }
  recordGeminiReconnect(): void {
    this.geminiReconnects += 1;
    if (this.streamStartedAt !== undefined) this.currentGeminiReconnects += 1;
  }

  recordGeminiTokens(input = 0, output = 0): void {
    this.recordGeminiLiveUsage({ inputTokens: input, outputTokens: output });
  }

  recordGeminiLiveUsage(usage: GeminiLiveUsageInput): void {
    const input = Math.max(0, usage.inputTokens);
    const output = Math.max(0, usage.outputTokens);
    this.geminiInputTokens += input;
    this.geminiOutputTokens += output;
    addModalityUsage(this.liveInputByModality, usage.inputByModality, input);
    addModalityUsage(this.liveOutputByModality, usage.outputByModality, output);
    if (this.streamStartedAt !== undefined) {
      this.currentGeminiInputTokens += input;
      this.currentGeminiOutputTokens += output;
      addModalityUsage(this.currentLiveInputByModality, usage.inputByModality, input);
      addModalityUsage(this.currentLiveOutputByModality, usage.outputByModality, output);
    }
  }

  recordGeminiToolCall(): void { this.geminiToolCalls += 1; }
  recordReactionContextPrepared(): void { this.preparedReactionContexts += 1; }
  recordReactionBatch(): void { this.reactionBatches += 1; }
  recordEmptyReactionBatch(): void { this.emptyReactionBatches += 1; this.skippedResponses += 1; }
  recordGuardRejection(): void { this.guardRejections += 1; }
  recordEventDetected(): void {
    this.eventsDetected += 1;
    if (this.streamStartedAt !== undefined) this.currentEventsDetected += 1;
  }
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

  recordBrainInteraction(
    usage: BrainInteractionUsageInput,
    metadata: { decision: boolean; latencyMs: number },
  ): void {
    addBrainUsage(this.brainUsage, usage, metadata);
    if (this.streamStartedAt !== undefined) addBrainUsage(this.currentBrainUsage, usage, metadata);
  }

  snapshot(now = Date.now()): UsageSnapshot {
    const activeMs = this.streamStartedAt === undefined ? 0 : Math.max(0, now - this.streamStartedAt);
    const currentDurationMs = this.streamStartedAt === undefined ? this.currentStreamDurationMs : activeMs;
    const perception = perceptionSnapshot(
      (this.accumulatedStreamMs + activeMs) / 60_000,
      this.geminiAudioSentMs / 60_000,
      this.geminiVideoSentMs / 60_000,
      this.geminiInputTokens,
      this.geminiOutputTokens,
      this.liveInputByModality,
      this.liveOutputByModality,
      this.geminiToolCalls,
      this.eventsDetected,
    );
    const brain = brainSnapshot(this.brainUsage);
    const currentPerception = perceptionSnapshot(
      currentDurationMs / 60_000,
      this.currentGeminiAudioSentMs / 60_000,
      this.currentGeminiVideoSentMs / 60_000,
      this.currentGeminiInputTokens,
      this.currentGeminiOutputTokens,
      this.currentLiveInputByModality,
      this.currentLiveOutputByModality,
      0,
      this.currentEventsDetected,
    );
    const currentBrain = brainSnapshot(this.currentBrainUsage);
    const totalAi = totalSnapshot(perception.estimatedCostUsd, brain.estimatedCostUsd,
      (this.accumulatedStreamMs + activeMs) / 60_000, this.eventsDetected, this.brainUsage.decisions, this.sentResponses);
    const currentTotalAi = totalSnapshot(currentPerception.estimatedCostUsd, currentBrain.estimatedCostUsd,
      currentDurationMs / 60_000, this.currentEventsDetected, this.currentBrainUsage.decisions, this.currentSentResponses);

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
      perception,
      brain,
      totalAi,
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
        perception: currentPerception,
        brain: currentBrain,
        totalAi: currentTotalAi,
      },
    };
  }

  private addDuration(modality: 'audio' | 'video', milliseconds: number, sent: boolean): void {
    const duration = Math.max(0, milliseconds);
    if (modality === 'audio' && sent) this.geminiAudioSentMs += duration;
    else if (modality === 'video' && sent) this.geminiVideoSentMs += duration;
    else if (modality === 'audio') this.capturedAudioMs += duration;
    else this.capturedVideoMs += duration;
    if (this.streamStartedAt === undefined) return;
    if (modality === 'audio' && sent) this.currentGeminiAudioSentMs += duration;
    else if (modality === 'video' && sent) this.currentGeminiVideoSentMs += duration;
    else if (modality === 'audio') this.currentCapturedAudioMs += duration;
    else this.currentCapturedVideoMs += duration;
  }
}

function emptyModalities(): TokenModalityUsage { return { text: 0, audio: 0, video: 0, other: 0 }; }
function emptyBrainUsage(): MutableBrainUsage {
  return {
    interactions: 0, decisions: 0, inputTokens: 0, cachedInputTokens: 0,
    outputTokens: 0, thoughtTokens: 0, totalTokens: 0, totalLatencyMs: 0,
  };
}

function addModalityUsage(
  target: TokenModalityUsage,
  details: GeminiLiveUsageInput['inputByModality'],
  total: number,
): void {
  if (!details?.length) { target.other += total; return; }
  let categorized = 0;
  for (const item of details) {
    const tokens = Math.max(0, item.tokenCount ?? 0);
    const modality = normalizeModality(item.modality);
    target[modality] += tokens;
    categorized += tokens;
  }
  target.other += Math.max(0, total - categorized);
}

function normalizeModality(value: string | undefined): keyof TokenModalityUsage {
  const normalized = value?.toLowerCase();
  if (normalized === 'text' || normalized === 'audio' || normalized === 'video') return normalized;
  return 'other';
}

function addBrainUsage(
  target: MutableBrainUsage,
  usage: BrainInteractionUsageInput,
  metadata: { decision: boolean; latencyMs: number },
): void {
  target.interactions += 1;
  if (metadata.decision) {
    target.decisions += 1;
    target.totalLatencyMs += Math.max(0, metadata.latencyMs);
    target.lastLatencyMs = Math.max(0, metadata.latencyMs);
  }
  target.inputTokens += Math.max(0, usage.inputTokens);
  target.cachedInputTokens += Math.max(0, usage.cachedInputTokens);
  target.outputTokens += Math.max(0, usage.outputTokens);
  target.thoughtTokens += Math.max(0, usage.thoughtTokens);
  target.totalTokens += Math.max(0, usage.totalTokens);
}

function perceptionSnapshot(
  sessionDurationMinutes: number,
  audioSentMinutes: number,
  videoSentMinutes: number,
  inputTokens: number,
  outputTokens: number,
  inputTokensByModality: TokenModalityUsage,
  outputTokensByModality: TokenModalityUsage,
  toolCalls: number,
  events: number,
): PerceptionUsageSnapshot {
  return {
    sessionDurationMinutes, audioSentMinutes, videoSentMinutes, inputTokens, outputTokens,
    inputTokensByModality: { ...inputTokensByModality },
    outputTokensByModality: { ...outputTokensByModality },
    toolCalls, events,
    estimatedCostUsd: modalityCost(inputTokensByModality, LIVE_INPUT_PRICE)
      + modalityCost(outputTokensByModality, LIVE_OUTPUT_PRICE),
  };
}

function brainSnapshot(usage: MutableBrainUsage): BrainUsageSnapshot {
  const nonCachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return {
    interactions: usage.interactions,
    decisions: usage.decisions,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    thinkingTokens: usage.thoughtTokens,
    totalTokens: usage.totalTokens,
    averageLatencyMs: usage.decisions > 0 ? usage.totalLatencyMs / usage.decisions : 0,
    ...(usage.lastLatencyMs !== undefined ? { lastLatencyMs: usage.lastLatencyMs } : {}),
    estimatedCostUsd: (nonCachedInput * BRAIN_INPUT_PRICE
      + usage.cachedInputTokens * BRAIN_CACHED_INPUT_PRICE
      + (usage.outputTokens + usage.thoughtTokens) * BRAIN_OUTPUT_PRICE) / MILLION,
  };
}

function totalSnapshot(
  perceptionCost: number,
  brainCost: number,
  minutes: number,
  events: number,
  decisions: number,
  messages: number,
): TotalAiUsageSnapshot {
  const hours = minutes / 60;
  const rate = (value: number): number => hours > 0 ? value / hours : 0;
  const estimatedCostUsd = perceptionCost + brainCost;
  return {
    estimatedCostUsd,
    estimatedCostPerHourUsd: hours > 0 ? estimatedCostUsd / hours : 0,
    eventsPerHour: rate(events),
    brainDecisionsPerHour: rate(decisions),
    messagesPerHour: rate(messages),
  };
}

function modalityCost(tokens: TokenModalityUsage, prices: Record<keyof TokenModalityUsage, number>): number {
  return (Object.keys(tokens) as Array<keyof TokenModalityUsage>)
    .reduce((cost, modality) => cost + tokens[modality] * prices[modality] / MILLION, 0);
}
