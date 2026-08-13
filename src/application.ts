import { ApiServer, createApiServer } from './api/server';
import { AppConfig, normalizeChannel } from './config';
import { ReactionMemory } from './learning/reaction-memory';
import { Logger } from './logger';
import { BotHistory } from './personas/bot-history';
import { PersonaStore } from './personas/persona-store';
import { AppRepository } from './persistence/repository';
import { MemoryRepository } from './persistence/memory-repository';
import { PostgresRepository } from './persistence/postgres-repository';
import { ReactionCoordinator } from './reaction/reaction-coordinator';
import { ReactionPolicyGuard } from './reaction/reaction-policy-guard';
import { ReactionDecisionRecord } from './reaction/types';
import { ContextStore } from './stream-brain/context-store';
import { EventDetector } from './stream-brain/event-detector';
import { GeminiLiveClient } from './stream-brain/gemini-live.client';
import { MediaPipeline } from './stream-brain/media-pipeline';
import { StreamBrainService } from './stream-brain/stream-brain.service';
import { ChatMessage, StreamEvent, StreamEventCandidate } from './stream-brain/types';
import { GroqWhisperFallback } from './transcription/groq-whisper-fallback';
import { TwitchBotManager } from './twitch/bot-manager';
import { TwitchHelixClient } from './twitch/helix-client';
import { UsageTracker } from './usage/usage-tracker';

export class Application {
  private readonly logger: Logger;
  private readonly usage = new UsageTracker();
  private readonly repository: AppRepository;
  private readonly contextStore: ContextStore;
  private readonly personas: PersonaStore;
  private readonly policy: ReactionPolicyGuard;
  private readonly memory: ReactionMemory;
  private readonly history: BotHistory;
  private readonly decisions: ReactionDecisionRecord[] = [];
  private botManager!: TwitchBotManager;
  private brain!: StreamBrainService;
  private coordinator!: ReactionCoordinator;
  private api!: ApiServer;
  private gemini?: GeminiLiveClient;
  private transcriber?: GroqWhisperFallback;
  private categoryTimer?: NodeJS.Timeout;
  private usageTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private databaseReady = false;
  private stopping = false;
  private runtimeSettings: Record<string, unknown> = {};

  constructor(private readonly config: AppConfig) {
    this.logger = new Logger('APP', config.app.logLevel);
    this.repository = config.database.url
      ? new PostgresRepository(config.database.url, config.database.ssl)
      : new MemoryRepository();
    this.contextStore = new ContextStore({ chatWindowMs: 120_000, maxChatMessages: 200, maxEvents: 100 });
    this.personas = new PersonaStore(this.repository);
    this.policy = new ReactionPolicyGuard({
      minimumDelayMs: config.reaction.minimumDelayMs,
      maximumDelayMs: config.reaction.maximumDelayMs,
      globalMessagesPer30Seconds: config.reaction.globalMessagesPer30Seconds,
      maxReactionsPerEvent: config.reaction.maxReactionsPerEvent,
    });
    this.memory = new ReactionMemory({
      enabled: config.learning.enabled,
      reactionWindowMs: config.learning.reactionWindowSeconds * 1000,
      repository: this.repository,
      logger: this.logger,
    });
    this.history = new BotHistory(this.repository, 50);
  }

  async start(): Promise<void> {
    await this.repository.initialize();
    this.databaseReady = true;
    if (!this.config.database.url) this.logger.warn('DATABASE_URL is not configured; using non-persistent in-memory storage');
    await this.personas.initialize();
    this.runtimeSettings = await this.repository.getSettings();
    this.config.twitch.channel = normalizeChannel(stringSetting(this.runtimeSettings.channel, this.config.twitch.channel));
    this.config.stream.visionFps = boundedNumberSetting(this.runtimeSettings.visionFps, this.config.stream.visionFps, 0.05, 1);
    const streamContext = stringSetting(this.runtimeSettings.streamContext, this.config.stream.context);
    this.contextStore.configure({
      channel: this.config.twitch.channel,
      streamContext,
      botUsernames: this.config.twitch.accounts.map((account) => account.username),
    });

    this.botManager = new TwitchBotManager({
      channel: this.config.twitch.channel,
      accounts: this.config.twitch.accounts,
      repository: this.repository,
      personas: this.personas,
      logger: this.logger,
    });
    await this.botManager.initialize();

    this.coordinator = new ReactionCoordinator({
      policy: this.policy,
      sender: this.botManager,
      history: this.history,
      memory: this.memory,
      contextStore: this.contextStore,
      usage: this.usage,
      logger: this.logger,
      retrievalLimit: this.config.learning.retrievalLimit,
      candidates: () => this.botManager.candidates(),
    });

    if (this.config.gemini.apiKey) {
      this.gemini = new GeminiLiveClient({
        apiKey: this.config.gemini.apiKey,
        model: this.config.gemini.liveModel,
        logger: this.logger,
        usage: this.usage,
        handlers: {
          onPrepareReactionContext: async (candidate) => {
            const event = await this.brain.acceptCandidate(candidate);
            if (!event) throw new Error('invalid_event');
            return this.coordinator.prepare(event);
          },
          onEmitReactionBatch: (batch) => this.coordinator.submitBatch(batch),
          onTranscript: (text) => this.logger.debug('Gemini input transcription received', { characters: text.length }),
          onStatus: (connected, error) => {
            if (!connected) this.coordinator.clearPendingContexts();
            this.brain.onGeminiStatus(connected, error);
          },
        },
      });
    }

    if ((this.config.transcription.provider === 'groq-whisper' || this.config.transcription.fallback) && this.config.transcription.groqApiKey) {
      this.transcriber = new GroqWhisperFallback({
        apiKey: this.config.transcription.groqApiKey,
        language: this.config.transcription.language,
        logger: this.logger,
        onTranscript: (text) => {
          const candidate: StreamEventCandidate = {
            type: 'speech', summary: `Streamer said: ${text}`, speech: text, importance: 0.5, confidence: 0.8,
          };
          if (this.gemini?.isConnected()) this.gemini.requestReaction(candidate);
          else void this.brain.acceptCandidate(candidate, 'fallback-transcription');
        },
      });
    }

    const hasStreamAnalyzer = Boolean(this.gemini || this.transcriber);
    const media = hasStreamAnalyzer
      ? new MediaPipeline({
          channel: this.config.twitch.channel,
          visionFps: this.config.stream.visionFps,
          frameWidth: this.config.stream.frameWidth,
          logger: this.logger,
          handlers: {
            onAudio: (pcm, durationMs) => {
              this.brain.sendAudio(pcm, durationMs);
              const useWhisper = this.config.transcription.provider === 'groq-whisper'
                || (this.config.transcription.fallback === 'groq-whisper' && !this.gemini?.isConnected());
              if (useWhisper) this.transcriber?.acceptPcm(pcm);
            },
            onVideo: (jpeg, durationMs) => this.brain.sendVideo(jpeg, durationMs),
            onState: (state, error) => this.brain.onMediaState(state, error),
          },
        })
      : undefined;

    this.brain = new StreamBrainService({
      channel: this.config.twitch.channel,
      contextStore: this.contextStore,
      eventDetector: new EventDetector({ minimumConfidence: this.config.stream.confidenceThreshold }),
      gemini: this.gemini,
      media,
      eventSink: this.repository,
      usage: this.usage,
      logger: this.logger,
      contextRefreshMs: this.config.stream.contextRefreshMs,
      enabled: hasStreamAnalyzer,
      model: this.config.gemini.liveModel,
    });

    this.api = createApiServer({
      port: this.config.app.port,
      frontendUrls: this.config.app.frontendUrls,
      dashboardToken: this.config.app.dashboardToken,
      dashboardSessionDays: this.config.app.dashboardSessionDays,
      secureCookies: this.config.app.nodeEnv === 'production',
      logger: this.logger,
      health: () => ({
        status: this.config.database.url && this.databaseReady ? 'ok' : 'degraded',
        twitch: this.botManager.listStatuses().some((bot) => bot.chatConnected),
        streamBrain: this.brain.getStatus().state === 'CONNECTED',
        gemini: this.brain.getStatus().geminiConnected,
        database: Boolean(this.config.database.url && this.databaseReady),
      }),
      overview: () => {
        const snapshot = this.contextStore.snapshot();
        const bots = this.botManager.listStatuses();
        return {
          channel: snapshot.channel,
          category: snapshot.category,
          isLive: snapshot.isLive,
          twitchConnected: bots.some((bot) => bot.chatConnected),
          streamBrain: this.brain.getStatus(),
          activeBots: bots.filter((bot) => bot.enabled && bot.chatConnected).length,
          totalBots: bots.length,
          uptimeSeconds: this.usage.snapshot().uptimeSeconds,
        };
      },
      bots: () => this.botManager.listStatuses(),
      setBotEnabled: (username, enabled) => this.botManager.setEnabled(username, enabled),
      events: (limit) => this.repository.listStreamEvents(limit),
      chat: () => this.contextStore.snapshot().recentChat,
      usage: () => this.usage.snapshot(),
      decisions: () => [...this.decisions].reverse(),
      settings: () => this.getSettings(),
      updateSettings: (settings) => this.updateSettings(settings),
      personas: () => this.personas.list(),
      updatePersona: (persona) => this.personas.update(persona),
    });

    this.wireEvents();
    await this.api.start();
    if (!this.config.app.dashboardToken) this.logger.warn('DASHBOARD_TOKEN is missing; protected dashboard API and realtime connections are unavailable');
    await Promise.allSettled([this.brain.start(), this.botManager.start()]);
    this.startCategoryMonitor();
    this.usageTimer = setInterval(() => { void this.persistUsage(); }, 60_000);
    this.healthTimer = setInterval(() => { void this.refreshDatabaseHealth(); }, 30_000);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.categoryTimer) clearInterval(this.categoryTimer);
    if (this.usageTimer) clearInterval(this.usageTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.categoryTimer = undefined;
    this.usageTimer = undefined;
    this.healthTimer = undefined;
    await this.api?.stop();
    await this.coordinator?.stop();
    await this.memory.stop();
    await this.transcriber?.flush();
    await this.brain?.stop();
    await this.botManager?.stop();
    await this.persistUsage();
    this.databaseReady = false;
    await this.repository.close();
    this.logger.info('Application stopped');
  }

  private wireEvents(): void {
    this.brain.on('event', (event: StreamEvent) => {
      this.api.emitEvent(event);
      this.api.emitOverview();
    });
    this.brain.on('status', (status) => {
      this.api.emitBrain(status);
      this.api.emitOverview();
    });
    this.coordinator.on('decision', (decision: ReactionDecisionRecord) => {
      this.decisions.push(decision);
      if (this.decisions.length > 100) this.decisions.shift();
      this.api.emitDecision(decision);
    });
    this.botManager.on('status', (bots) => {
      this.api.emitBots(bots);
      this.api.emitOverview();
    });
    this.botManager.on('chat', (message: ChatMessage) => {
      void this.handleChat(message).catch((cause: unknown) => this.logger.warn('Chat context handling failed', { cause }));
    });
  }

  private async handleChat(message: ChatMessage): Promise<void> {
    this.contextStore.addChat(message);
    this.memory.recordChat(message);
    this.api.emitChat(message);
    if (message.kind !== 'viewer') return;
    const mentions = this.config.twitch.accounts
      .map((account) => account.username)
      .filter((username) => new RegExp(`@${escapeRegex(username)}\\b`, 'i').test(message.message));
    if (mentions.length === 0) return;
    this.brain.requestReaction({
      timestamp: message.timestamp,
      type: 'conversation',
      summary: `${message.username} directly addressed ${mentions.map((name) => `@${name}`).join(', ')}: ${message.message}`,
      speech: message.message,
      importance: 0.85,
      confidence: 1,
      directMentions: mentions,
    });
  }

  private startCategoryMonitor(): void {
    if (this.categoryTimer) clearInterval(this.categoryTimer);
    this.categoryTimer = undefined;
    if (!this.config.twitch.channel || !this.config.twitch.clientId || !this.config.twitch.clientSecret) {
      this.logger.warn('Twitch category auto-refresh disabled; channel and Twitch client credentials are required');
      return;
    }
    const helix = new TwitchHelixClient(this.config.twitch.clientId, this.config.twitch.clientSecret, this.logger);
    const refresh = async (): Promise<void> => {
      try {
        const info = await helix.getStream(this.config.twitch.channel);
        const previous = this.contextStore.snapshot();
        this.contextStore.configure({ category: info.category, isLive: info.isLive });
        if (previous.category !== info.category) this.logger.info('Twitch category updated', { category: info.category || 'offline' });
        this.api.emitOverview();
      } catch (cause) {
        this.logger.warn('Twitch category refresh failed', { cause });
      }
    };
    void refresh();
    this.categoryTimer = setInterval(() => { void refresh(); }, this.config.twitch.categoryRefreshMs);
  }

  private async getSettings(): Promise<Record<string, unknown>> {
    return {
      channel: this.config.twitch.channel,
      streamContext: this.contextStore.snapshot().streamContext,
      visionFps: this.config.stream.visionFps,
      learnEnabled: this.config.learning.enabled,
    };
  }

  private async updateSettings(settings: Record<string, unknown>): Promise<{ restartRequired: string[] }> {
    const persisted: Record<string, unknown> = {};
    if (typeof settings.streamContext === 'string') {
      this.contextStore.configure({ streamContext: settings.streamContext });
      persisted.streamContext = settings.streamContext;
    }
    const nextChannel = typeof settings.channel === 'string' ? normalizeChannel(settings.channel) : this.config.twitch.channel;
    const nextVisionFps = typeof settings.visionFps === 'number' ? settings.visionFps : this.config.stream.visionFps;
    const mediaChanged = nextChannel !== this.config.twitch.channel || nextVisionFps !== this.config.stream.visionFps;
    if (mediaChanged) {
      const channelChanged = nextChannel !== this.config.twitch.channel;
      this.config.twitch.channel = nextChannel;
      this.config.stream.visionFps = nextVisionFps;
      this.contextStore.configure({ channel: nextChannel });
      await this.brain.reconfigureMedia(nextChannel, nextVisionFps);
      if (channelChanged) {
        await this.botManager.reconfigureChannel(nextChannel);
        this.startCategoryMonitor();
      }
      persisted.channel = nextChannel;
      persisted.visionFps = nextVisionFps;
    }
    this.runtimeSettings = { ...this.runtimeSettings, ...persisted };
    await this.repository.setSettings(persisted);
    return { restartRequired: [] };
  }

  private async persistUsage(): Promise<void> {
    if (!this.databaseReady) return;
    try { await this.repository.saveUsageSnapshot(this.usage.snapshot()); }
    catch (cause) { this.logger.warn('Usage snapshot persistence failed', { cause }); }
  }

  private async refreshDatabaseHealth(): Promise<void> {
    this.databaseReady = Boolean(this.config.database.url && await this.repository.healthCheck());
  }
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function stringSetting(value: unknown, fallback: string): string { return typeof value === 'string' ? value : fallback; }
function boundedNumberSetting(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && value >= minimum && value <= maximum ? value : fallback;
}
