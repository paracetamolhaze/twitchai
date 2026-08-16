import { EventEmitter } from 'node:events';
import { Logger } from '../logger';
import { UsageTracker } from '../usage/usage-tracker';
import { ContextStore } from './context-store';
import { EventDetector } from './event-detector';
import { StreamEventDeduplicator } from './event-deduplicator';
import { StreamBrainClient } from './stream-brain.client';
import { MediaPipeline, MediaPipelineState } from './media-pipeline';
import { GeminiLiveDiagnostics, StreamBrainStatus, StreamEvent, StreamEventCandidate, StreamEventSource } from './types';

export interface StreamEventSink {
  saveStreamEvent(event: StreamEvent): Promise<void>;
}

export interface StreamBrainServiceOptions {
  channel: string;
  contextStore: ContextStore;
  eventDetector: EventDetector;
  gemini?: StreamBrainClient;
  media?: MediaPipeline;
  eventSink?: StreamEventSink;
  usage: UsageTracker;
  logger: Logger;
  contextRefreshMs: number;
  enabled: boolean;
  model?: string;
  eventDeduplicationWindowMs?: number;
}

export class StreamBrainService extends EventEmitter {
  private readonly logger: Logger;
  private status: StreamBrainStatus;
  private contextTimer?: NodeJS.Timeout;
  private running = false;
  private geminiDesired = false;
  private lifecycleGeneration = 0;
  private geminiStart?: Promise<void>;
  private readonly eventDeduplicator: StreamEventDeduplicator;
  private readonly pendingEventEmissions = new Map<string, { event: StreamEvent; timer: NodeJS.Timeout }>();

  constructor(private readonly options: StreamBrainServiceOptions) {
    super();
    this.logger = options.logger.child('PERCEPTION');
    this.eventDeduplicator = new StreamEventDeduplicator(options.eventDeduplicationWindowMs);
    this.status = {
      state: options.enabled ? 'STOPPED' : 'DISABLED',
      mediaState: 'STOPPED',
      geminiState: options.enabled && options.gemini ? 'STOPPED' : 'DISABLED',
      mediaConnected: false,
      geminiConnected: false,
      geminiStable: false,
      geminiSessionActive: false,
      geminiSessionReason: options.enabled ? 'application_stopped' : 'disabled',
      ...(options.model ? { model: options.model } : {}),
    };
  }

  getStatus(): StreamBrainStatus { return { ...this.status }; }

  async start(): Promise<void> {
    if (this.running || !this.options.enabled) return;
    this.running = true;
    if (this.options.contextStore.snapshot().channel && this.options.media) {
      this.patchStatus({
        state: 'CONNECTING',
        mediaState: 'CONNECTING',
        geminiState: this.options.gemini ? 'STOPPED' : 'DISABLED',
        geminiSessionReason: 'media_connecting',
        lastError: undefined,
      });
      this.options.media.start();
    } else {
      this.patchStatus({
        state: 'STOPPED',
        mediaState: 'STOPPED',
        geminiSessionReason: 'application_stopped',
      });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.geminiDesired = false;
    this.lifecycleGeneration += 1;
    this.stopContextUpdates();
    this.options.gemini?.stop();
    this.clearPendingEventEmissions();
    await this.options.media?.stop();
    this.options.usage.stopStream();
    this.options.contextStore.configure({ isLive: false });
    this.patchStatus({
      state: this.options.enabled ? 'STOPPED' : 'DISABLED',
      mediaState: 'STOPPED',
      geminiState: this.options.enabled && this.options.gemini ? 'STOPPED' : 'DISABLED',
      mediaConnected: false,
      geminiConnected: false,
      geminiStable: false,
      geminiSessionActive: false,
      geminiSessionReason: this.options.enabled ? 'application_stopped' : 'disabled',
      sessionStartedAt: undefined,
      lastError: undefined,
    });
  }

  onMediaState(state: MediaPipelineState, error?: string): void {
    const previousState = this.status.mediaState;
    const mediaConnected = state === 'STREAMING';
    this.options.contextStore.configure({ isLive: mediaConnected });
    if (mediaConnected && previousState !== 'STREAMING') {
      this.eventDeduplicator.clear();
      this.clearPendingEventEmissions();
      this.options.usage.startStream();
    }
    if (!mediaConnected && previousState === 'STREAMING') {
      this.eventDeduplicator.clear();
      this.clearPendingEventEmissions();
      this.options.usage.stopStream();
    }

    if (mediaConnected) {
      this.patchStatus({
        mediaState: state,
        mediaConnected: true,
        state: this.status.geminiConnected ? 'CONNECTED' : 'CONNECTING',
        geminiState: this.status.geminiConnected ? 'CONNECTED' : 'CONNECTING',
        geminiSessionActive: this.status.geminiConnected,
        geminiSessionReason: 'twitch_live',
        spokenMentionsDetected: previousState === 'STREAMING' ? this.status.spokenMentionsDetected : 0,
        lastError: undefined,
      });
      if (!this.geminiDesired && this.options.gemini) {
        this.geminiDesired = true;
        const generation = ++this.lifecycleGeneration;
        const start = this.startGemini(generation);
        this.geminiStart = start;
        void start.finally(() => {
          if (this.geminiStart === start) this.geminiStart = undefined;
        });
      }
    } else {
      this.geminiDesired = false;
      this.lifecycleGeneration += 1;
      this.stopContextUpdates();
      this.options.gemini?.stop();
      const reason = state === 'OFFLINE'
        ? 'twitch_offline'
        : state === 'ERROR'
          ? 'media_error'
          : state === 'CONNECTING'
            ? 'media_connecting'
            : 'application_stopped';
      this.patchStatus({
        mediaState: state,
        mediaConnected: false,
        state: this.deriveState(state, false, state === 'ERROR' ? error : undefined),
        geminiState: this.options.gemini ? 'STOPPED' : 'DISABLED',
        geminiConnected: false,
        geminiStable: false,
        geminiSessionActive: false,
        geminiSessionReason: reason,
        sessionStartedAt: undefined,
        lastError: state === 'ERROR' ? error : undefined,
      });
    }
    this.emit('media', { state, error, mediaConnected });
  }

  onGeminiStatus(connected: boolean, error?: string, diagnostics?: GeminiLiveDiagnostics): void {
    if (connected && (!this.running || !this.geminiDesired || this.status.mediaState !== 'STREAMING')) {
      this.options.gemini?.stop();
      return;
    }
    if (connected) this.startContextUpdates();
    else this.stopContextUpdates();
    const client = diagnostics ?? this.options.gemini?.getDiagnostics?.();
    const geminiState = client?.state ?? (connected ? 'CONNECTED' : error ? 'ERROR' : 'CONNECTING');
    const stable = client?.stable ?? connected;
    const fatal = geminiState === 'FATAL_CONFIG_ERROR';
    this.patchStatus({
      geminiConnected: connected,
      geminiStable: stable,
      geminiSessionActive: client?.sessionActive ?? connected,
      geminiState,
      sessionStartedAt: client?.sessionStartedAt ?? (connected ? this.options.gemini?.getSessionStartedAt?.() : undefined),
      state: fatal
        ? 'FATAL_CONFIG_ERROR'
        : connected && !stable
          ? 'CONNECTING'
          : this.deriveState(this.status.mediaState, connected, error),
      geminiSessionReason: fatal
        ? 'fatal_error'
        : this.status.mediaState === 'STREAMING'
          ? 'twitch_live'
          : this.status.geminiSessionReason,
      lastError: error,
      lastCloseCode: client?.lastCloseCode,
      lastCloseReason: client?.lastCloseReason,
      lastCloseWasClean: client?.lastCloseWasClean,
      lastSessionAgeMs: client?.lastSessionAgeMs,
      lastOutbound: client?.lastOutbound,
      lastToolCall: client?.lastToolCall,
      lastToolResponse: client?.lastToolResponse,
      lastMediaInput: client?.lastMediaInput,
      outboundTrace: client?.outboundTrace,
      protocolErrorsInWindow: client?.protocolErrorsInWindow,
      resumeAttempts: client?.resumeAttempts,
      freshReconnects: client?.freshReconnects,
      audioChunksSent: client?.audioChunksSent,
      videoFramesSent: client?.videoFramesSent,
      transcriptsReceived: client?.transcriptsReceived,
      modelTurns: client?.modelTurns,
      usageReports: client?.usageReports,
      contextWindowMode: client?.contextWindowMode,
      responseModality: client?.responseModality,
      stallRecoveries: client?.stallRecoveries,
      msSincePerceptionOutput: client?.msSincePerceptionOutput,
    });
  }

  async acceptCandidate(candidate: StreamEventCandidate, source: StreamEventSource = 'gemini-live'): Promise<StreamEvent | undefined> {
    const snapshot = this.options.contextStore.snapshot();
    const event = this.options.eventDetector.normalize(candidate, {
      category: snapshot.category,
      source,
      botUsernames: snapshot.botUsernames,
    });
    if (!event) {
      this.logger.debug('Rejected invalid or low-confidence event');
      return undefined;
    }
    const deduplicated = this.eventDeduplicator.accept(event);
    this.options.contextStore.addEvent(deduplicated.event);
    if (deduplicated.isNew) this.options.usage.recordEventDetected();
    this.patchStatus({ lastEventAt: deduplicated.event.timestamp });
    this.logger.info(deduplicated.isNew ? 'Normalized stream event' : 'Merged duplicate stream event', {
      eventId: deduplicated.event.id,
      type: deduplicated.event.type,
      importance: deduplicated.event.importance,
      confidence: deduplicated.event.confidence,
      // What perception claims it observed. Without this a report of "the bot reacted to something
      // that never happened" cannot be checked against anything: the logs recorded that an event
      // existed, never what it said, so a description invented by the model and an accurate one
      // were indistinguishable after the fact.
      summary: deduplicated.event.summary,
      ...(deduplicated.event.speech ? { speech: deduplicated.event.speech } : {}),
      ...(deduplicated.event.visualContext ? { visualContext: deduplicated.event.visualContext } : {}),
    });
    this.queueEventEmission(deduplicated);
    // Deliberately not awaited. This runs inside the perception tool call, and realtime media is
    // dropped rather than buffered for as long as a tool batch is outstanding — so waiting on a
    // database round trip here silenced the stream itself. Production delivered roughly 9% of both
    // audio and video: 750 chunks of an expected 8100, 9 frames of an expected 97, which is also
    // why perception was left describing scenes it had barely seen. The event is already in the
    // context store and already queued for delivery; persistence only feeds history and the next
    // bootstrap, and nothing in the live path waits on it.
    if (this.options.eventSink) {
      void this.options.eventSink.saveStreamEvent(deduplicated.event)
        .catch((cause: unknown) => this.logger.warn('Stream event persistence failed', { eventId: deduplicated.event.id, cause }));
    }
    return deduplicated.event;
  }

  recordSpokenMention(eligibleBots: number): void {
    this.patchStatus({
      spokenMentionsDetected: (this.status.spokenMentionsDetected ?? 0) + 1,
      eligibleBots: Math.max(0, eligibleBots),
    });
  }

  private queueEventEmission(result: ReturnType<StreamEventDeduplicator['accept']>): void {
    const pending = this.pendingEventEmissions.get(result.event.id);
    if (pending) {
      pending.event = structuredClone(result.event);
      return;
    }
    if (result.isNew && this.eventDeduplicator.settleWindowMs() === 0) {
      this.emit('event', structuredClone(result.event));
      return;
    }
    if (!result.isNew) return;
    const entry = {
      event: structuredClone(result.event),
      timer: setTimeout(() => {
        const latest = this.pendingEventEmissions.get(result.event.id);
        if (!latest) return;
        this.pendingEventEmissions.delete(result.event.id);
        this.emit('event', structuredClone(latest.event));
      }, this.eventDeduplicator.settleWindowMs()),
    };
    this.pendingEventEmissions.set(result.event.id, entry);
  }

  private clearPendingEventEmissions(): void {
    for (const pending of this.pendingEventEmissions.values()) clearTimeout(pending.timer);
    this.pendingEventEmissions.clear();
  }

  async reconfigureMedia(channel: string, visionFps: number): Promise<void> {
    this.geminiDesired = false;
    this.lifecycleGeneration += 1;
    this.stopContextUpdates();
    this.options.gemini?.stop();
    this.clearPendingEventEmissions();
    this.options.contextStore.configure({ channel });
    await this.options.media?.reconfigure(channel, visionFps);
    if (this.running && channel) this.options.media?.start();
  }

  sendAudio(pcm: Buffer, durationMs: number): void {
    if (this.status.mediaState !== 'STREAMING') return;
    this.options.usage.recordCapturedAudio(durationMs);
    if (!this.status.geminiConnected) return;
    if (this.options.gemini?.sendAudio(pcm)) this.options.usage.recordGeminiAudioSent(durationMs);
  }

  sendVideo(jpeg: Buffer, durationMs: number): void {
    if (this.status.mediaState !== 'STREAMING') return;
    this.options.usage.recordCapturedVideo(durationMs);
    if (!this.status.geminiConnected) return;
    if (this.options.gemini?.sendVideo(jpeg)) this.options.usage.recordGeminiVideoSent(durationMs);
  }

  private async startGemini(generation: number): Promise<void> {
    try {
      await this.options.gemini?.start();
      if (!this.running || !this.geminiDesired || generation !== this.lifecycleGeneration || this.status.mediaState !== 'STREAMING') {
        this.options.gemini?.stop();
        return;
      }
      if (this.options.gemini?.isConnected()) this.onGeminiStatus(true);
    } catch (cause) {
      if (generation !== this.lifecycleGeneration || !this.geminiDesired) return;
      const lastError = cause instanceof Error ? cause.message : String(cause);
      this.patchStatus({ state: 'ERROR', geminiState: 'ERROR', geminiSessionActive: false, lastError });
      this.logger.error('Gemini Live failed to start for active media', { cause });
    }
  }

  private startContextUpdates(): void {
    if (!this.running || !this.geminiDesired || this.status.mediaState !== 'STREAMING') return;
    this.pushContext();
    if (!this.contextTimer) this.contextTimer = setInterval(() => this.pushContext(), this.options.contextRefreshMs);
  }

  private stopContextUpdates(): void {
    if (this.contextTimer) clearInterval(this.contextTimer);
    this.contextTimer = undefined;
  }

  private pushContext(): void {
    if (!this.running || !this.geminiDesired || this.status.mediaState !== 'STREAMING' || !this.status.geminiConnected) return;
    this.options.gemini?.updateContext(this.options.contextStore.snapshot());
  }

  private deriveState(mediaState: MediaPipelineState, gemini: boolean, error?: string): StreamBrainStatus['state'] {
    if (!this.options.enabled) return 'DISABLED';
    if (!this.running || mediaState === 'STOPPED') return 'STOPPED';
    if (mediaState === 'OFFLINE') return 'OFFLINE';
    if (mediaState === 'STREAMING' && gemini) return 'CONNECTED';
    if (error) return 'ERROR';
    return 'CONNECTING';
  }

  private patchStatus(patch: Partial<StreamBrainStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }
}
