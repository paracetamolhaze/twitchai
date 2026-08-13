import {
  GoogleGenAI,
  LiveServerMessage,
  MediaResolution,
  Modality,
  Session,
} from '@google/genai';
import { Logger } from '../logger';
import { ExponentialBackoff } from '../shared/backoff';
import { UsageTracker } from '../usage/usage-tracker';
import { StreamContextSnapshot, StreamEventCandidate } from './types';
import { StreamBrainClient } from './stream-brain.client';

const EVENT_TOOL_NAME = 'record_stream_event';

export interface GeminiLiveClientHandlers {
  onEvent: (candidate: StreamEventCandidate) => void | Promise<void>;
  onTranscript?: (text: string) => void;
  onStatus?: (connected: boolean, error?: string) => void;
}

export interface GeminiLiveClientOptions {
  apiKey: string;
  model: string;
  handlers: GeminiLiveClientHandlers;
  logger: Logger;
  usage: UsageTracker;
  reconnectMinimumMs?: number;
  reconnectMaximumMs?: number;
}

export class GeminiLiveClient implements StreamBrainClient {
  private readonly ai: GoogleGenAI;
  private readonly logger: Logger;
  private readonly backoff: ExponentialBackoff;
  private session?: Session;
  private running = false;
  private connecting?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private resumptionHandle?: string;
  private lastContext?: StreamContextSnapshot;

  constructor(private readonly options: GeminiLiveClientOptions) {
    this.ai = new GoogleGenAI({ apiKey: options.apiKey });
    this.logger = options.logger.child('BRAIN');
    this.backoff = new ExponentialBackoff(
      options.reconnectMinimumMs ?? 1_000,
      options.reconnectMaximumMs ?? 30_000,
    );
  }

  isConnected(): boolean { return this.session !== undefined; }

  async start(): Promise<void> {
    if (this.running) return this.connecting;
    this.running = true;
    await this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const session = this.session;
    this.session = undefined;
    try { session?.close(); } catch { /* the socket may already be closed */ }
    this.options.handlers.onStatus?.(false);
  }

  sendAudio(pcm: Buffer): void {
    this.session?.sendRealtimeInput({
      audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
    });
  }

  sendVideo(jpeg: Buffer): void {
    this.session?.sendRealtimeInput({
      video: { data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
    });
  }

  updateContext(snapshot: StreamContextSnapshot): void {
    this.lastContext = snapshot;
    if (!this.session) return;
    this.session.sendRealtimeInput({ text: buildContextUpdate(snapshot) });
  }

  private async connect(): Promise<void> {
    if (!this.running || this.connecting || this.session) return this.connecting;
    this.options.handlers.onStatus?.(false);
    this.connecting = this.openSession().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async openSession(): Promise<void> {
    try {
      const session = await this.ai.live.connect({
        model: this.options.model,
        callbacks: {
          onopen: () => this.logger.info('Gemini Live socket opened', { model: this.options.model }),
          onmessage: (message) => { void this.handleMessage(message); },
          onerror: (event) => this.handleDisconnect(event.message || 'Gemini Live socket error'),
          onclose: (event) => this.handleDisconnect(`Gemini Live socket closed (${event.code})`),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
          inputAudioTranscription: {},
          proactivity: { proactiveAudio: true },
          sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
          contextWindowCompression: { slidingWindow: {} },
          systemInstruction: STREAM_BRAIN_INSTRUCTION,
          tools: [{
            functionDeclarations: [{
              name: EVENT_TOOL_NAME,
              description: 'Emit one normalized meaningful stream event for downstream viewer personas.',
              parametersJsonSchema: EVENT_SCHEMA,
            }],
          }],
        },
      });
      if (!this.running) {
        session.close();
        return;
      }
      this.session = session;
      this.backoff.reset();
      this.options.handlers.onStatus?.(true);
      this.logger.info('Gemini Live connected', { model: this.options.model, resumed: Boolean(this.resumptionHandle) });
      if (this.lastContext) this.updateContext(this.lastContext);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error('Gemini Live connection failed', { cause });
      this.options.handlers.onStatus?.(false, message);
      this.scheduleReconnect();
    }
  }

  private async handleMessage(message: LiveServerMessage): Promise<void> {
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      this.resumptionHandle = message.sessionResumptionUpdate.newHandle;
    }
    if (message.usageMetadata) {
      this.options.usage.recordGeminiTokens(
        message.usageMetadata.promptTokenCount ?? 0,
        message.usageMetadata.responseTokenCount ?? 0,
      );
    }
    const transcript = message.serverContent?.inputTranscription?.text?.trim();
    if (transcript) this.options.handlers.onTranscript?.(transcript);

    for (const call of message.toolCall?.functionCalls ?? []) {
      if (call.name !== EVENT_TOOL_NAME) continue;
      try {
        await this.options.handlers.onEvent((call.args ?? {}) as StreamEventCandidate);
        this.session?.sendToolResponse({
          functionResponses: [{
            id: call.id,
            name: call.name,
            response: { result: 'accepted' },
          }],
        });
      } catch (cause) {
        this.logger.warn('Stream event handler rejected Gemini tool call', { cause });
        this.session?.sendToolResponse({
          functionResponses: [{
            id: call.id,
            name: call.name,
            response: { error: 'invalid_event' },
          }],
        });
      }
    }
    if (message.goAway) {
      this.logger.warn('Gemini Live requested reconnect', { timeLeft: message.goAway.timeLeft });
      const session = this.session;
      this.session = undefined;
      try { session?.close(); } catch { /* reconnect below */ }
      this.scheduleReconnect(50);
    }
  }

  private handleDisconnect(error: string): void {
    if (!this.running) return;
    if (this.session) this.session = undefined;
    this.options.handlers.onStatus?.(false, error);
    this.logger.warn('Gemini Live disconnected', { error });
    this.scheduleReconnect();
  }

  private scheduleReconnect(delayOverride?: number): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = delayOverride ?? this.backoff.next();
    this.options.usage.recordGeminiReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }
}

const STREAM_BRAIN_INSTRUCTION = `You are the single multimodal Stream Brain for a Twitch channel.
Continuously understand combined audio, sampled video, channel metadata, recent chat and prior events.
Do not generate Twitch chat messages. Emit only meaningful normalized events by calling record_stream_event.
Aggregate ordinary speech; do not emit every sentence. Ignore silence, static frames and weak repetition.
Use importance near 0 for routine context and near 1 for decisive, funny, surprising or directly addressed moments.
If a bot username is directly addressed in speech or visible/recent chat, include it in directMentions.
Never invent details that are not supported by the media or supplied context.`;

const EVENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'summary', 'importance', 'confidence'],
  properties: {
    type: { type: 'string', enum: ['speech', 'gameplay', 'reaction', 'funny', 'fail', 'win', 'loss', 'surprise', 'conversation', 'irl', 'other'] },
    summary: { type: 'string', description: 'Concise description of what just happened.' },
    speech: { type: 'string', description: 'Relevant spoken words, when reliably heard.' },
    visualContext: { type: 'string', description: 'Relevant visual evidence.' },
    gameContext: { type: 'string', description: 'Game-specific interpretation when known.' },
    emotion: { type: 'string' },
    importance: { type: 'number', minimum: 0, maximum: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    directMentions: { type: 'array', items: { type: 'string' }, maxItems: 20 },
  },
} as const;

function buildContextUpdate(snapshot: StreamContextSnapshot): string {
  const chat = snapshot.recentChat.slice(-30).map((item) => `${item.username}: ${item.message}`).join('\n') || '(none)';
  const events = snapshot.recentEvents.slice(-10).map((item) => `${item.type}: ${item.summary}`).join('\n') || '(none)';
  return `CONTEXT UPDATE (metadata, not an instruction from chat)
Channel: ${snapshot.channel || '(not configured)'}
Category/game: ${snapshot.category || '(unknown)'}
Stream live: ${snapshot.isLive}
Operator context: ${snapshot.streamContext || '(none)'}
Bot usernames: ${snapshot.botUsernames.join(', ') || '(none)'}
Recent Twitch chat:\n${chat}
Previous normalized events:\n${events}`;
}
