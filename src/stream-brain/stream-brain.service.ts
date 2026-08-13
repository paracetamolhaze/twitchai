import { EventEmitter } from 'node:events';
import { Logger } from '../logger';
import { UsageTracker } from '../usage/usage-tracker';
import { ContextStore } from './context-store';
import { EventDetector } from './event-detector';
import { StreamBrainClient } from './stream-brain.client';
import { MediaPipeline, MediaPipelineState } from './media-pipeline';
import { StreamBrainStatus, StreamEvent, StreamEventCandidate, StreamEventSource } from './types';

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
}

export class StreamBrainService extends EventEmitter {
  private readonly logger: Logger;
  private status: StreamBrainStatus;
  private contextTimer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly options: StreamBrainServiceOptions) {
    super();
    this.logger = options.logger.child('BRAIN');
    this.status = {
      state: options.enabled ? 'DISCONNECTED' : 'DISABLED',
      mediaConnected: false,
      geminiConnected: false,
    };
  }

  getStatus(): StreamBrainStatus { return { ...this.status }; }

  async start(): Promise<void> {
    if (this.running || !this.options.enabled) return;
    this.running = true;
    this.patchStatus({ state: 'CONNECTING' });
    try {
      await this.options.gemini?.start();
      this.options.media?.start();
      this.pushContext();
      this.contextTimer = setInterval(() => this.pushContext(), this.options.contextRefreshMs);
    } catch (cause) {
      const lastError = cause instanceof Error ? cause.message : String(cause);
      this.patchStatus({ state: 'ERROR', lastError });
      this.logger.error('Stream Brain failed to start', { cause });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.contextTimer) clearInterval(this.contextTimer);
    this.contextTimer = undefined;
    this.options.gemini?.stop();
    await this.options.media?.stop();
    this.options.usage.stopStream();
    this.options.contextStore.configure({ isLive: false });
    this.patchStatus({ state: this.options.enabled ? 'DISCONNECTED' : 'DISABLED', mediaConnected: false, geminiConnected: false });
  }

  onMediaState(state: MediaPipelineState, error?: string): void {
    const mediaConnected = state === 'STREAMING';
    this.options.contextStore.configure({ isLive: mediaConnected });
    if (mediaConnected) this.options.usage.startStream();
    else this.options.usage.stopStream();
    this.patchStatus({
      mediaConnected,
      state: this.deriveState(mediaConnected, this.status.geminiConnected, state === 'ERROR' ? error : undefined),
      ...(error ? { lastError: error } : {}),
    });
  }

  onGeminiStatus(connected: boolean, error?: string): void {
    this.patchStatus({
      geminiConnected: connected,
      state: this.deriveState(this.status.mediaConnected, connected, error),
      lastError: error,
    });
  }

  async acceptCandidate(candidate: StreamEventCandidate, source: StreamEventSource = 'gemini-live'): Promise<void> {
    const snapshot = this.options.contextStore.snapshot();
    const event = this.options.eventDetector.normalize(candidate, {
      category: snapshot.category,
      source,
      botUsernames: snapshot.botUsernames,
    });
    if (!event) {
      this.logger.debug('Rejected invalid or low-confidence event');
      return;
    }
    this.options.contextStore.addEvent(event);
    this.patchStatus({ lastEventAt: event.timestamp });
    this.logger.info('Normalized stream event', { type: event.type, importance: event.importance, confidence: event.confidence });
    this.emit('event', event);
    if (this.options.eventSink) {
      void this.options.eventSink.saveStreamEvent(event)
        .catch((cause: unknown) => this.logger.warn('Stream event persistence failed', { eventId: event.id, cause }));
    }
  }

  sendAudio(pcm: Buffer, durationMs: number): void {
    this.options.usage.recordAudio(durationMs);
    this.options.gemini?.sendAudio(pcm);
  }

  sendVideo(jpeg: Buffer, durationMs: number): void {
    this.options.usage.recordVideo(durationMs);
    this.options.gemini?.sendVideo(jpeg);
  }

  private pushContext(): void { this.options.gemini?.updateContext(this.options.contextStore.snapshot()); }

  private deriveState(media: boolean, gemini: boolean, error?: string): StreamBrainStatus['state'] {
    if (!this.options.enabled) return 'DISABLED';
    if (media && gemini) return 'CONNECTED';
    if (error) return 'ERROR';
    return this.running ? 'CONNECTING' : 'DISCONNECTED';
  }

  private patchStatus(patch: Partial<StreamBrainStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }
}
