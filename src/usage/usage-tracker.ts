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

/** A sensor's own share of the bill: what it did and what that cost. */
export interface SensorUsageSnapshot {
  calls: number;
  failures: number;
  costUsd: number;
  /** Hearing only: speech actually uploaded. Silence never leaves the machine. */
  audioSeconds: number;
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
  /** Sends the reader account saw come back, so the channel really showed them. */
  confirmedDeliveries: number;
  /** Sends Twitch accepted without error but never showed — dropped silently on their side. */
  undeliveredMessages: number;
  skippedResponses: number;
  memoryToolCalls: number;
  memoriesCreated: number;
  memoriesMerged: number;
  memoriesSuperseded: number;
  memoryRetrievals: number;
  perception: PerceptionUsageSnapshot;
  hearing: SensorUsageSnapshot;
  vision: SensorUsageSnapshot;
  brain: BrainUsageSnapshot;
  totalAi: TotalAiUsageSnapshot;
  currentStream: CurrentStreamUsageSnapshot;
  /** Persona Drive gate/outcome counters, lifetime. See DriveUsageCounters for field meaning. */
  drive: DriveUsageCounters;
  /** Persona Drive's own slice of Gemini 3.7 Brain cost, lifetime — separate from `brain` above so drive cost is visible on its own. */
  driveBrain: BrainUsageSnapshot;
  /** cachedInputTokens / inputTokens for driveBrain, 0 when driveBrain has no input tokens yet. */
  driveCacheHitRatio: number;
}

/**
 * How many Persona Drive ticks happened, how many were locally skipped vs actually reached
 * Gemini 3.7, and every distinct reason a tick or a message didn't happen — the exact breakdown
 * needed to tell whether the hourly caps are too tight, too loose, or about right after a real
 * stream.
 */
export interface DriveUsageCounters {
  ticks: number;
  eligibleTicks: number;
  localSkips: number;
  brainCalls: number;
  brainCallsBlockedByHourlyLimit: number;
  silentDecisions: number;
  messages: number;
  messagesBlockedByHourlyLimit: number;
  cancelledForExternalEvent: number;
  cancelledForCooldown: number;
  cancelledForNoCandidates: number;
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
  confirmedDeliveries: number;
  undeliveredMessages: number;
  perception: PerceptionUsageSnapshot;
  hearing: SensorUsageSnapshot;
  vision: SensorUsageSnapshot;
  brain: BrainUsageSnapshot;
  totalAi: TotalAiUsageSnapshot;
  drive: DriveUsageCounters;
  driveBrain: BrainUsageSnapshot;
  driveCacheHitRatio: number;
}

export interface BrainInteractionUsageInput {
  costUsd?: number;
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
/**
 * Per million tokens, and worth keeping honest: every cost decision in this project has been made
 * by reading these numbers off the dashboard. The Google direct figures were double the real ones,
 * which quietly overstated the Brain's share of the bill for weeks.
 */
export interface BrainTokenPrices { input: number; cachedInput: number; output: number }

const BRAIN_PRICES: Record<'google' | 'openrouter', BrainTokenPrices> = {
  google: { input: 0.375, cachedInput: 0.0375, output: 1.875 },
  openrouter: { input: 0.375, cachedInput: 0.0375, output: 1.875 },
};

interface MutableBrainUsage extends BrainInteractionUsageInput {
  interactions: number;
  decisions: number;
  totalLatencyMs: number;
  lastLatencyMs?: number;
}

export class UsageTracker {
  private brainPrices: BrainTokenPrices = BRAIN_PRICES.google;
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
  private confirmedDeliveries = 0;
  private currentConfirmedDeliveries = 0;
  private undeliveredMessages = 0;
  private currentUndeliveredMessages = 0;
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
  private readonly hearingUsage = emptySensorUsage();
  private currentHearingUsage = emptySensorUsage();
  private readonly visionUsage = emptySensorUsage();
  private currentVisionUsage = emptySensorUsage();
  private readonly brainUsage = emptyBrainUsage();
  private currentBrainUsage = emptyBrainUsage();
  private readonly driveBrainUsage = emptyBrainUsage();
  private currentDriveBrainUsage = emptyBrainUsage();
  private readonly driveCounters: DriveUsageCounters = emptyDriveCounters();
  private currentDriveCounters: DriveUsageCounters = emptyDriveCounters();

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
    this.currentConfirmedDeliveries = 0;
    this.currentUndeliveredMessages = 0;
    this.currentEventsDetected = 0;
    this.currentLiveInputByModality = emptyModalities();
    this.currentLiveOutputByModality = emptyModalities();
    this.currentHearingUsage = emptySensorUsage();
    this.currentVisionUsage = emptySensorUsage();
    this.currentBrainUsage = emptyBrainUsage();
    this.currentDriveBrainUsage = emptyBrainUsage();
    this.currentDriveCounters = emptyDriveCounters();
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
  /** Message came back through the reader account, so the channel really showed it. */
  recordConfirmedDelivery(): void {
    this.confirmedDeliveries += 1;
    if (this.streamStartedAt !== undefined) this.currentConfirmedDeliveries += 1;
  }
  /** Written to Twitch without error but never echoed back — silently dropped on their side. */
  recordUndeliveredMessage(): void {
    this.undeliveredMessages += 1;
    if (this.streamStartedAt !== undefined) this.currentUndeliveredMessages += 1;
  }
  recordSkipped(): void { this.skippedResponses += 1; }
  recordMemoryToolCall(): void { this.memoryToolCalls += 1; }
  recordMemoryCreated(count = 1): void { this.memoriesCreated += Math.max(0, count); }
  recordMemoryMerged(count = 1): void { this.memoriesMerged += Math.max(0, count); }
  recordMemorySuperseded(count = 1): void { this.memoriesSuperseded += Math.max(0, count); }
  recordMemoryRetrieval(): void { this.memoryRetrievals += 1; }

  /** Set once at startup: the two transports bill the same model at the same rate today, but the
   * dashboard should follow whichever one is actually being paid rather than assume. */
  /** One transcribed speech segment, priced by what the gateway charged for it. */
  recordHearingUsage(input: { costUsd?: number; audioSeconds?: number; failed?: boolean }): void {
    for (const bucket of [this.hearingUsage, this.currentHearingUsage]) {
      bucket.calls += 1;
      if (input.failed) bucket.failures += 1;
      bucket.costUsd += Math.max(0, input.costUsd ?? 0);
      bucket.audioSeconds += Math.max(0, input.audioSeconds ?? 0);
    }
  }

  /** One described frame. */
  recordVisionUsage(input: { costUsd?: number; failed?: boolean }): void {
    for (const bucket of [this.visionUsage, this.currentVisionUsage]) {
      bucket.calls += 1;
      if (input.failed) bucket.failures += 1;
      bucket.costUsd += Math.max(0, input.costUsd ?? 0);
    }
  }

  useBrainTransport(transport: 'google' | 'openrouter'): void {
    this.brainPrices = BRAIN_PRICES[transport];
  }

  recordBrainInteraction(
    usage: BrainInteractionUsageInput,
    metadata: { decision: boolean; latencyMs: number },
  ): void {
    addBrainUsage(this.brainUsage, usage, metadata);
    if (this.streamStartedAt !== undefined) addBrainUsage(this.currentBrainUsage, usage, metadata);
  }

  /** Persona Drive's own slice of Brain cost — kept separate from recordBrainInteraction's bucket so it's independently visible after a stream. */
  recordDriveBrainInteraction(
    usage: BrainInteractionUsageInput,
    metadata: { decision: boolean; latencyMs: number },
  ): void {
    addBrainUsage(this.driveBrainUsage, usage, metadata);
    if (this.streamStartedAt !== undefined) addBrainUsage(this.currentDriveBrainUsage, usage, metadata);
  }

  recordDriveTick(): void { this.incrementDrive('ticks'); }
  recordDriveEligibleTick(): void { this.incrementDrive('eligibleTicks'); }
  recordDriveLocalSkip(): void { this.incrementDrive('localSkips'); }
  recordDriveBrainCall(): void { this.incrementDrive('brainCalls'); }
  recordDriveBrainCallsBlockedByHourlyLimit(): void { this.incrementDrive('brainCallsBlockedByHourlyLimit'); }
  recordDriveSilentDecision(): void { this.incrementDrive('silentDecisions'); }
  recordDriveMessage(): void { this.incrementDrive('messages'); }
  recordDriveMessagesBlockedByHourlyLimit(): void { this.incrementDrive('messagesBlockedByHourlyLimit'); }
  recordDriveCancelledForExternalEvent(): void { this.incrementDrive('cancelledForExternalEvent'); }
  recordDriveCancelledForCooldown(): void { this.incrementDrive('cancelledForCooldown'); }
  recordDriveCancelledForNoCandidates(): void { this.incrementDrive('cancelledForNoCandidates'); }

  private incrementDrive(field: keyof DriveUsageCounters): void {
    this.driveCounters[field] += 1;
    if (this.streamStartedAt !== undefined) this.currentDriveCounters[field] += 1;
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
    const brain = brainSnapshot(this.brainUsage, this.brainPrices);
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
    const currentBrain = brainSnapshot(this.currentBrainUsage, this.brainPrices);
    const totalAi = totalSnapshot(
      perception.estimatedCostUsd + this.hearingUsage.costUsd + this.visionUsage.costUsd,
      brain.estimatedCostUsd,
      (this.accumulatedStreamMs + activeMs) / 60_000, this.eventsDetected, this.brainUsage.decisions, this.sentResponses);
    const currentTotalAi = totalSnapshot(
      currentPerception.estimatedCostUsd + this.currentHearingUsage.costUsd + this.currentVisionUsage.costUsd,
      currentBrain.estimatedCostUsd,
      currentDurationMs / 60_000, this.currentEventsDetected, this.currentBrainUsage.decisions, this.currentSentResponses);
    const driveBrain = brainSnapshot(this.driveBrainUsage, this.brainPrices);
    const currentDriveBrain = brainSnapshot(this.currentDriveBrainUsage, this.brainPrices);
    const driveCacheHitRatio = driveBrain.inputTokens > 0 ? driveBrain.cachedInputTokens / driveBrain.inputTokens : 0;
    const currentDriveCacheHitRatio = currentDriveBrain.inputTokens > 0
      ? currentDriveBrain.cachedInputTokens / currentDriveBrain.inputTokens : 0;

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
      confirmedDeliveries: this.confirmedDeliveries,
      undeliveredMessages: this.undeliveredMessages,
      skippedResponses: this.skippedResponses,
      memoryToolCalls: this.memoryToolCalls,
      memoriesCreated: this.memoriesCreated,
      memoriesMerged: this.memoriesMerged,
      memoriesSuperseded: this.memoriesSuperseded,
      memoryRetrievals: this.memoryRetrievals,
      perception,
      hearing: { ...this.hearingUsage },
      vision: { ...this.visionUsage },
      brain,
      totalAi,
      drive: { ...this.driveCounters },
      driveBrain,
      driveCacheHitRatio,
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
        confirmedDeliveries: this.currentConfirmedDeliveries,
        undeliveredMessages: this.currentUndeliveredMessages,
        perception: currentPerception,
        hearing: { ...this.currentHearingUsage },
        vision: { ...this.currentVisionUsage },
        brain: currentBrain,
        totalAi: currentTotalAi,
        drive: { ...this.currentDriveCounters },
        driveBrain: currentDriveBrain,
        driveCacheHitRatio: currentDriveCacheHitRatio,
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

function emptyDriveCounters(): DriveUsageCounters {
  return {
    ticks: 0, eligibleTicks: 0, localSkips: 0, brainCalls: 0, brainCallsBlockedByHourlyLimit: 0,
    silentDecisions: 0, messages: 0, messagesBlockedByHourlyLimit: 0,
    cancelledForExternalEvent: 0, cancelledForCooldown: 0, cancelledForNoCandidates: 0,
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
  // Sampled frames go out as image/jpeg, and the service accounts for them as IMAGE rather than
  // VIDEO. Counting that as 'other' made the dashboard read "video: 0" on a session that was in
  // fact being charged for every frame — the one number needed to tell whether perception can see
  // at all, reported as zero while it worked.
  if (normalized === 'image') return 'video';
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
  target.costUsd = (target.costUsd ?? 0) + Math.max(0, usage.costUsd ?? 0);
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

function brainSnapshot(usage: MutableBrainUsage, prices: BrainTokenPrices): BrainUsageSnapshot {
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
    // The transport's own figure when it reports one — every price table in this file has been
    // wrong at least once, and OpenRouter bills each call and says what it charged.
    estimatedCostUsd: usage.costUsd && usage.costUsd > 0
      ? usage.costUsd
      : (nonCachedInput * prices.input
        + usage.cachedInputTokens * prices.cachedInput
        + (usage.outputTokens + usage.thoughtTokens) * prices.output) / MILLION,
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

function emptySensorUsage(): SensorUsageSnapshot {
  return { calls: 0, failures: 0, costUsd: 0, audioSeconds: 0 };
}
