import { EventEmitter } from 'node:events';
import { Logger } from '../logger';
import { UsageTracker } from '../usage/usage-tracker';
import { ContextStore } from './context-store';
import { EventDetector } from './event-detector';
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
}

export class StreamBrainService extends EventEmitter {
  private readonly logger: Logger;
  private status: StreamBrainStatus;
  private contextTimer?: NodeJS.Timeout;
  private running = false;
  private geminiDesired = false;
  private lifecycleGeneration = 0;
  private geminiStart?: Promise<void>;

  constructor(private readonly options: StreamBrainServiceOptions) {
    super();
    this.logger = options.logger.child('BRAIN');
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
    if (mediaConnected && previousState !== 'STREAMING') this.options.usage.startStream();
    if (!mediaConnected && previousState === 'STREAMING') this.options.usage.stopStream();

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
    this.options.contextStore.addEvent(event);
    this.options.usage.recordEventDetected();
    this.patchStatus({ lastEventAt: event.timestamp });
    this.logger.info('Normalized stream event', { type: event.type, importance: event.importance, confidence: event.confidence });
    this.emit('event', event);
    if (this.options.eventSink) {
      await this.options.eventSink.saveStreamEvent(event)
        .catch((cause: unknown) => this.logger.warn('Stream event persistence failed', { eventId: event.id, cause }));
    }
    return event;
  }

  requestReaction(candidate: StreamEventCandidate): boolean {
    if (this.status.mediaState !== 'STREAMING' || !this.geminiDesired) return false;
    return this.options.gemini?.requestReaction(candidate) ?? false;
  }

  recordSpokenMention(eligibleBots: number): void {
    this.patchStatus({
      spokenMentionsDetected: (this.status.spokenMentionsDetected ?? 0) + 1,
      eligibleBots: Math.max(0, eligibleBots),
    });
  }

  async reconfigureMedia(channel: string, visionFps: number): Promise<void> {
    this.geminiDesired = false;
    this.lifecycleGeneration += 1;
    this.stopContextUpdates();
    this.options.gemini?.stop();
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
