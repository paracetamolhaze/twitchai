import { randomUUID } from 'node:crypto';
import { ApiServer, createApiServer } from './api/server';
import { GeminiBrainService } from './brain/gemini-brain.service';
import { GoogleInteractionsClient } from './brain/google-interactions.client';
import { BrainBootstrap, BrainDecision, BrainDynamicDelta, GeminiBrainStatus } from './brain/types';
import { AppConfig, normalizeChannel } from './config';
import { GlobalStreamerMemory } from './global-memory/global-streamer-memory';
import { StreamerMemory } from './global-memory/types';
import { ReactionMemory } from './learning/reaction-memory';
import { Logger } from './logger';
import { BotHistory } from './personas/bot-history';
import { PersonaContextBuilder } from './personas/persona-context-builder';
import { PersonaMemory } from './personas/persona-memory';
import { PersonaRuntimeStore } from './personas/persona-runtime-store';
import { PersonaStore } from './personas/persona-store';
import { BotPersona } from './personas/types';
import { AppRepository, BotAccountRecord } from './persistence/repository';
import { MemoryRepository } from './persistence/memory-repository';
import { PostgresRepository } from './persistence/postgres-repository';
import { ReactionCoordinator } from './reaction/reaction-coordinator';
import { ReactionPolicyGuard } from './reaction/reaction-policy-guard';
import { ReactionDecisionRecord, ReactionTraceRecord } from './reaction/types';
import { ContextStore } from './stream-brain/context-store';
import { EventDetector } from './stream-brain/event-detector';
import { GeminiLiveClient } from './stream-brain/gemini-live.client';
import { MediaPipeline } from './stream-brain/media-pipeline';
import { StreamBrainService } from './stream-brain/stream-brain.service';
import { ChatMessage, StreamEvent, StreamEventCandidate } from './stream-brain/types';
import { GroqWhisperFallback } from './transcription/groq-whisper-fallback';
import { TwitchBotManager } from './twitch/bot-manager';
import { TwitchHelixClient } from './twitch/helix-client';
import { OfficialTwitchOAuthGateway } from './twitch/oauth-client';
import { AuthorizedTwitchAccount, TwitchOAuthService } from './twitch/oauth-service';
import { OfficialTwitchTokenValidator } from './twitch/oauth-validator';
import { UsageTracker } from './usage/usage-tracker';
import { isAccountClassificationQuestion } from './shared/account-classification';

import { detectSpokenReactionSignal } from './shared/bot-mention-matcher';

const TWITCH_OAUTH_REFRESH_INTERVAL_MS = 60_000;
const TWITCH_OAUTH_REFRESH_LEAD_MS = 5 * 60_000;
/**
 * How long a MediaPipeline drop (streamlink/ffmpeg process restart, brief CDN hiccup) is treated
 * as a transient flap rather than the real end of the Twitch stream. Keeps the paid Brain session
 * (previousInteractionId) and the global-memory session alive across a short blip instead of
 * tearing down and re-bootstrapping 30 personas + memory on every reconnect.
 */
const MEDIA_OFFLINE_GRACE_MS = 20_000;

export class Application {
  private readonly logger: Logger;
  private readonly usage = new UsageTracker();
  private readonly repository: AppRepository;
  private readonly contextStore: ContextStore;
  private readonly personas: PersonaStore;
  private readonly policy: ReactionPolicyGuard;
  private readonly memory: ReactionMemory;
  private readonly globalMemory: GlobalStreamerMemory;
  private readonly history: BotHistory;
  private readonly personaMemory: PersonaMemory;
  private readonly personaRuntime: PersonaRuntimeStore;
  private readonly personaContext: PersonaContextBuilder;
  private readonly decisions: ReactionDecisionRecord[] = [];
  private readonly reactionTraces: ReactionTraceRecord[] = [];
  private botManager!: TwitchBotManager;
  private perception!: StreamBrainService;
  private coordinator!: ReactionCoordinator;
  private api!: ApiServer;
  private gemini?: GeminiLiveClient;
  private geminiBrain?: GeminiBrainService;
  private transcriber?: GroqWhisperFallback;
  private twitchOAuth?: TwitchOAuthService;
  private categoryTimer?: NodeJS.Timeout;
  private usageTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private oauthRefreshTimer?: NodeJS.Timeout;
  private sessionHeartbeatTimer?: NodeJS.Timeout;
  private databaseReady = false;
  private stopping = false;
  private runtimeSettings: Record<string, unknown> = {};
  /** Serializes STREAMING/OFFLINE/reconfigure/heartbeat transitions. */
  private globalMemoryLifecycle: Promise<void> = Promise.resolve();
  /** Gates initial StreamEvents until both persistent memory and Brain bootstrap are ready. */
  private brainSessionReady: Promise<void> = Promise.resolve();

  private transcriptAccumulator = '';
  private transcriptTimer?: NodeJS.Timeout;
  private mediaStreaming = false;
  private mediaOfflineGraceTimer?: NodeJS.Timeout;
  private mediaOfflineGraceState?: string;
  private streamGeneration = 0;
  private greetedStreamGeneration = 0;
  private lastBotAvailability = new Map<string, string>();

  constructor(private readonly config: AppConfig) {
    this.logger = new Logger('APP', config.app.logLevel);
    this.repository = config.database.url
      ? new PostgresRepository(config.database.url, config.database.ssl)
      : new MemoryRepository();
    this.contextStore = new ContextStore({ chatWindowMs: 120_000, maxChatMessages: 200, maxEvents: 100 });
    this.personas = new PersonaStore(this.repository);
    this.policy = new ReactionPolicyGuard({
      globalMessagesPer30Seconds: config.reaction.globalMessagesPer30Seconds,
      maxReactionsPerEvent: config.reaction.maxReactionsPerEvent,
    });
    this.memory = new ReactionMemory({
      enabled: config.learning.enabled,
      reactionWindowMs: config.learning.reactionWindowSeconds * 1000,
      repository: this.repository,
      logger: this.logger,
    });
    this.globalMemory = new GlobalStreamerMemory({
      repository: this.repository,
      usage: this.usage,
      logger: this.logger,
      retrievalLimit: config.globalMemory.retrievalLimit,
      startupLimit: config.globalMemory.snapshotLimit,
      staleSessionMs: config.globalMemory.sessionStaleMinutes * 60_000,
    });
    this.history = new BotHistory(this.repository, 50);
    this.personaMemory = new PersonaMemory(this.repository);
    this.personaRuntime = new PersonaRuntimeStore();
    this.personaContext = new PersonaContextBuilder(this.personaMemory, this.personaRuntime);
  }

  async start(): Promise<void> {
    await this.repository.initialize();
    this.databaseReady = true;
    if (!this.config.database.url) this.logger.warn('DATABASE_URL is not configured; using non-persistent in-memory storage');
    await this.personas.initialize();
    this.configureTwitchOAuth();
    await this.mergeStoredTwitchAccounts();
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
      credentialProvider: this.twitchOAuth,
    });
    await this.botManager.initialize();

    this.coordinator = new ReactionCoordinator({
      policy: this.policy,
      sender: this.botManager,
      history: this.history,
      memory: this.memory,
      globalMemory: this.globalMemory,
      personaContext: this.personaContext,
      personaMemory: this.personaMemory,
      personaRuntime: this.personaRuntime,
      contextStore: this.contextStore,
      usage: this.usage,
      logger: this.logger,
      retrievalLimit: this.config.learning.retrievalLimit,
      candidates: () => this.botManager.candidates(),
    });

    if (this.config.gemini.apiKey) {
      this.geminiBrain = new GeminiBrainService({
        client: new GoogleInteractionsClient(this.config.gemini.apiKey),
        model: this.config.gemini.brainModel,
        thinkingLevel: this.config.gemini.brainThinkingLevel,
        bootstrap: (reason) => this.buildBrainBootstrap(reason),
        prepareEvent: (event, chatAfter, emittedAt) =>
          this.coordinator.prepareBrainEvent(event, chatAfter, emittedAt),
        onDecision: (event, decision, latencyMs, interactionId, previousInteractionId) =>
          this.applyBrainDecision(event, decision, latencyMs, interactionId, previousInteractionId),
        usage: this.usage,
        logger: this.logger,
        eventMergeWindowMs: this.config.gemini.brainEventMergeWindowMs,
        contextRolloverTokens: this.config.gemini.brainContextRolloverTokens,
      });
      this.gemini = new GeminiLiveClient({
        apiKey: this.config.gemini.apiKey,
        model: this.config.gemini.liveModel,
        logger: this.logger,
        usage: this.usage,
        handlers: {
          onStreamEvent: async (candidate) => {
            const event = await this.perception.acceptCandidate(candidate);
            return event ? { accepted: true, eventId: event.id } : { accepted: false, reason: 'invalid_event' };
          },
          onTranscript: (text) => {
            this.logger.debug('Gemini input transcription received', { characters: text.length });
            this.handleSpokenTranscript(text);
          },
          onStatus: (connected, error, diagnostics) => {
            this.perception.onGeminiStatus(connected, error, diagnostics);
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
            type: 'speech', summary: `Стример сказал: ${text}`, speech: text, importance: 0.5, confidence: 0.8,
          };
          void this.perception.acceptCandidate(candidate, 'fallback-transcription');
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
              this.perception.sendAudio(pcm, durationMs);
              const useWhisper = this.config.transcription.provider === 'groq-whisper'
                || (this.config.transcription.fallback === 'groq-whisper' && !this.gemini?.isConnected());
              if (useWhisper) this.transcriber?.acceptPcm(pcm);
            },
            onVideo: (jpeg, durationMs) => this.perception.sendVideo(jpeg, durationMs),
            onState: (state, error) => this.perception.onMediaState(state, error),
          },
        })
      : undefined;

    this.perception = new StreamBrainService({
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
        streamBrain: this.perception.getStatus().state === 'CONNECTED',
        gemini: this.perception.getStatus().geminiConnected,
        brain: ['READY', 'THINKING'].includes(this.getGeminiBrainStatus().state),
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
          streamBrain: this.perception.getStatus(),
          geminiBrain: this.getGeminiBrainStatus(),
          activeBots: bots.filter((bot) => bot.enabled && bot.chatConnected).length,
          totalBots: bots.length,
          uptimeSeconds: this.usage.snapshot().uptimeSeconds,
        };
      },
      bots: () => this.botManager.listStatuses(),
      setBotEnabled: (username, enabled) => this.botManager.setEnabled(username, enabled),
      assignBotPersona: async (username, personaId) => {
        const result = await this.botManager.assignPersona(username, personaId);
        const candidate = this.botManager.candidates().find((item) => item.username === username);
        if (result === 'updated' && candidate) this.queuePersonaSnapshot(candidate.persona);
        return result;
      },
      events: (limit) => this.repository.listStreamEvents(limit),
      chat: () => this.contextStore.snapshot().recentChat,
      usage: () => this.usage.snapshot(),
      decisions: () => [...this.decisions].reverse(),
      reactionTraces: () => [...this.reactionTraces].reverse(),
      settings: () => this.getSettings(),
      updateSettings: (settings) => this.updateSettings(settings),
      personas: () => this.personas.list(),
      personaSummaries: () => this.personas.summaries(),
      personaAudit: () => this.personas.audit(),
      persona: (id) => this.personas.getOptional(id),
      createPersona: (persona) => this.personas.create(persona),
      createBlankPersona: (id, name) => this.personas.createBlank(id, name),
      createPersonaTemplate: (username, id) => this.personas.createTemplate(username, id),
      duplicatePersona: (sourceId, id, name) => this.personas.duplicate(sourceId, id, name),
      updatePersona: async (persona) => {
        const updated = await this.personas.update(persona);
        await this.botManager.revalidatePersona(updated.id);
        this.queuePersonaSnapshot(updated);
        return updated;
      },
      previewPersonaRegeneration: (id) => this.personas.previewRegeneration(id),
      previewAllPersonaRegenerations: () => this.personas.previewAllRegenerations(),
      regeneratePersona: async (id, previewHash) => {
        const updated = await this.personas.regenerate(id, previewHash);
        await this.botManager.revalidatePersona(updated.id);
        this.queuePersonaSnapshot(updated);
        return updated;
      },
      regenerateAllPersonas: async (previews) => {
        const updated = await this.personas.regenerateAll(previews);
        await Promise.all(updated.map((persona) => this.botManager.revalidatePersona(persona.id)));
        updated.forEach((persona) => this.queuePersonaSnapshot(persona));
        return updated;
      },
      deletePersona: (id) => this.personas.delete(id),
      personaMemories: (personaId, limit) => this.personaMemory.list(personaId, limit),
      deletePersonaMemory: (personaId, memoryId) => this.personaMemory.delete(personaId, memoryId),
      previewPersonaContext: (personaId, query, username) => this.previewPersonaContext(personaId, query, username),
      streamerMemories: (input) => this.globalMemory.list({ channel: this.config.twitch.channel, ...input }),
      streamerMemoryStats: () => this.globalMemory.stats(this.config.twitch.channel),
      updateStreamerMemory: (input) => this.globalMemory.updateMemory({ channel: this.config.twitch.channel, ...input }),
      deleteStreamerMemory: async (id) => {
        const deleted = await this.globalMemory.deleteMemory(id, this.config.twitch.channel);
        if (deleted) {
          await this.emitGlobalMemorySnapshot();
        }
        return deleted;
      },
      previewStreamerMemoryContext: (input) => this.globalMemory.retrieve({ channel: this.config.twitch.channel, ...input }),
      ...(this.twitchOAuth ? {
        twitchOAuth: {
          status: () => this.twitchOAuth!.status(),
          startAuthorization: () => this.twitchOAuth!.startAuthorization(),
          launchAuthorization: (ticket: string) => this.twitchOAuth!.launchAuthorization(ticket),
          abandonAuthorization: (state: string, browserState: string) =>
            this.twitchOAuth!.abandonAuthorization(state, browserState),
          completeAuthorization: (code: string, state: string, browserState: string) =>
            this.completeTwitchAuthorization(code, state, browserState),
        },
      } : {}),
    });

    this.wireEvents();
    await this.api.start();
    if (!this.config.app.dashboardToken) this.logger.warn('DASHBOARD_TOKEN is missing; protected dashboard API and realtime connections are unavailable');
    await Promise.allSettled([this.perception.start(), this.botManager.start()]);
    this.startCategoryMonitor();
    this.usageTimer = setInterval(() => { void this.persistUsage(); }, 60_000);
    this.healthTimer = setInterval(() => { void this.refreshDatabaseHealth(); }, 30_000);
    this.sessionHeartbeatTimer = setInterval(() => {
      if (!this.perception.getStatus().mediaConnected) return;
      void this.enqueueGlobalMemoryLifecycle(async () => {
        try { await this.globalMemory.touchCurrentSession(); }
        catch (cause) { this.logger.warn('Stream session heartbeat failed', { cause }); }
      });
    }, 60_000);
    if (this.twitchOAuth) {
      void this.refreshExpiringTwitchCredentials();
      this.oauthRefreshTimer = setInterval(() => {
        void this.refreshExpiringTwitchCredentials();
      }, TWITCH_OAUTH_REFRESH_INTERVAL_MS);
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.categoryTimer) clearInterval(this.categoryTimer);
    if (this.usageTimer) clearInterval(this.usageTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.oauthRefreshTimer) clearInterval(this.oauthRefreshTimer);
    if (this.sessionHeartbeatTimer) clearInterval(this.sessionHeartbeatTimer);
    if (this.mediaOfflineGraceTimer) clearTimeout(this.mediaOfflineGraceTimer);
    this.clearTranscriptAccumulator();
    this.categoryTimer = undefined;
    this.usageTimer = undefined;
    this.healthTimer = undefined;
    this.oauthRefreshTimer = undefined;
    this.sessionHeartbeatTimer = undefined;
    this.mediaOfflineGraceTimer = undefined;
    this.mediaOfflineGraceState = undefined;
    await this.api?.stop();
    await this.coordinator?.stop();
    await this.memory.stop();
    await this.transcriber?.flush();
    await this.geminiBrain?.stopStream();
    await this.enqueueGlobalMemoryLifecycle(() => this.closeGlobalMemorySession('interrupted'));
    await this.perception?.stop();
    await this.botManager?.stop();
    await this.persistUsage();
    this.databaseReady = false;
    await this.repository.close();
    this.logger.info('Application stopped');
  }

  private wireEvents(): void {
    this.perception.on('event', (event: StreamEvent) => {
      const emittedAt = Date.now();
      this.api.emitEvent(event);
      this.api.emitOverview();
      if (this.mediaStreaming && this.geminiBrain) {
        const generation = this.streamGeneration;
        this.brainSessionReady = this.brainSessionReady.catch(async () => {
          if (!this.mediaStreaming || generation !== this.streamGeneration) return;
          await this.enqueueGlobalMemoryLifecycle(async () => {
            await this.startGlobalMemorySession();
            await this.geminiBrain?.startStream();
          });
        });
        void this.brainSessionReady.then(async () => {
          if (!this.mediaStreaming || generation !== this.streamGeneration) return;
          await this.geminiBrain?.enqueueEvent(event, emittedAt);
        }).catch((cause: unknown) => {
          this.logger.warn('Stream event skipped because Gemini Brain failed', { eventId: event.id, cause });
        });
      }
    });
    this.perception.on('status', (status) => {
      this.api.emitBrain(status);
      this.api.emitOverview();
    });
    this.perception.on('media', ({ state, mediaConnected }: { state: string; mediaConnected: boolean }) => {
      if (mediaConnected) {
        if (this.mediaOfflineGraceTimer) {
          clearTimeout(this.mediaOfflineGraceTimer);
          this.mediaOfflineGraceTimer = undefined;
          this.mediaOfflineGraceState = undefined;
          this.logger.info('Media recovered within grace period; kept Brain session and bootstrap', {
            streamGeneration: this.streamGeneration,
          });
        }
        if (!this.mediaStreaming) {
          this.mediaStreaming = true;
          this.streamGeneration += 1;
          const brainStart = this.geminiBrain?.startStream() ?? Promise.resolve();
          this.brainSessionReady = this.enqueueGlobalMemoryLifecycle(async () => {
            await this.startGlobalMemorySession();
            await brainStart;
          });
          void this.brainSessionReady.catch((cause: unknown) => {
            this.logger.warn('Stream AI session start failed', { cause });
          });
        }
      } else {
        // A single streamlink/ffmpeg restart or short CDN hiccup reports OFFLINE/ERROR/CONNECTING
        // here too. Don't tear down the paid Brain session (and re-bootstrap 30 personas + global
        // memory) for a blip that recovers on its own; only commit to "stream ended" after it
        // stays down for MEDIA_OFFLINE_GRACE_MS.
        if (!this.mediaStreaming) return;
        this.mediaOfflineGraceState = state;
        if (this.mediaOfflineGraceTimer) return;
        this.mediaOfflineGraceTimer = setTimeout(() => {
          this.mediaOfflineGraceTimer = undefined;
          const finalState = this.mediaOfflineGraceState;
          this.mediaOfflineGraceState = undefined;
          this.clearTranscriptAccumulator();
          this.mediaStreaming = false;
          this.brainSessionReady = Promise.resolve();
          this.coordinator.clearPendingContexts();
          void this.geminiBrain?.stopStream();
          if (finalState === 'OFFLINE') void this.enqueueGlobalMemoryLifecycle(() => this.closeGlobalMemorySession('ended'));
          else if (finalState === 'ERROR') void this.enqueueGlobalMemoryLifecycle(() => this.closeGlobalMemorySession('interrupted'));
        }, MEDIA_OFFLINE_GRACE_MS);
      }
    });
    this.geminiBrain?.on('status', () => this.api.emitOverview());
    this.globalMemory.on('memory', ({ memory }: { memory: StreamerMemory }) => {
      this.api.emitStreamerMemory(memory);
      void this.emitGlobalMemorySnapshot();
      this.queueBrainDelta({
        type: 'MEMORY_ADDED',
        summary: memory.summary,
        payload: { memoryId: memory.id, memoryType: memory.type, status: memory.status },
      });
    });
    this.coordinator.on('decision', (decision: ReactionDecisionRecord) => {
      this.decisions.push(decision);
      if (this.decisions.length > 100) this.decisions.shift();
      this.api.emitDecision(decision);
    });
    this.coordinator.on('trace', (trace: ReactionTraceRecord) => {
      const existing = this.reactionTraces.findIndex((item) => item.eventId === trace.eventId);
      if (existing >= 0) this.reactionTraces.splice(existing, 1);
      this.reactionTraces.push(trace);
      if (this.reactionTraces.length > 100) this.reactionTraces.shift();
      this.api.emitReactionTrace(trace);
    });
    this.botManager.on('status', (bots: BotAccountRecord[]) => {
      this.contextStore.configure({ botUsernames: bots.map((bot) => bot.username) });
      for (const bot of bots) {
        const signature = `${bot.enabled}:${bot.connectionState}:${bot.chatConnected}:${bot.personaId}`;
        if (this.lastBotAvailability.get(bot.username) !== signature) {
          this.lastBotAvailability.set(bot.username, signature);
          this.queueBrainDelta({
            type: 'BOT_STATUS_UPDATE',
            summary: `${bot.username}: enabled=${bot.enabled}, connected=${bot.chatConnected}, state=${bot.connectionState}`,
            payload: {
              username: bot.username, enabled: bot.enabled, chatConnected: bot.chatConnected,
              connectionState: bot.connectionState, personaId: bot.personaId,
            },
          });
        }
      }
      this.api.emitBots(bots);
      this.api.emitOverview();
    });
    this.botManager.on('chat', (message: ChatMessage) => {
      void this.handleChat(message).catch((cause: unknown) => this.logger.warn('Chat context handling failed', { cause }));
    });
  }

  private async buildBrainBootstrap(reason: 'stream_start' | 'recovery' | 'rollover'): Promise<BrainBootstrap> {
    const snapshot = this.contextStore.snapshot();
    const candidates = this.botManager.candidates();
    const [globalMemories, recentEvents] = await Promise.all([
      this.globalMemory.startupSnapshot(snapshot.channel, this.config.globalMemory.snapshotLimit),
      this.repository.listStreamEvents(50),
    ]);
    const bootstrap: BrainBootstrap = {
      channel: snapshot.channel,
      category: snapshot.category,
      streamContext: snapshot.streamContext,
      startedAt: this.usage.snapshot().currentStream.startedAt ?? Date.now(),
      availableBots: candidates
        .filter((candidate) => candidate.enabled && candidate.connectionState === 'CONNECTED' && candidate.chatConnected)
        .map((candidate) => candidate.username),
      personas: candidates.map((candidate) => this.personaContext.buildBrainSnapshot(candidate.username, candidate.persona)),
      globalMemories: globalMemories.map((memory) => ({
        type: memory.type,
        summary: memory.summary,
        importance: memory.importance,
        confidence: memory.confidence,
        entities: memory.entities,
      })),
      recentMeaningfulEvents: recentEvents
        .filter((event) => event.importance >= 0.6)
        .slice(0, 25)
        .reverse()
        .map(({ id, timestamp, type, summary, importance }) => ({ id, timestamp, type, summary, importance })),
      recentChat: snapshot.recentChat.slice(-40)
        .map(({ timestamp, username, message, kind }) => ({ timestamp, username, message, kind })),
    };
    this.logger.info('Gemini Brain bootstrap prepared', {
      reason,
      personas: bootstrap.personas.length,
      availableBots: bootstrap.availableBots.length,
      globalMemories: bootstrap.globalMemories.length,
      recentEvents: bootstrap.recentMeaningfulEvents.length,
      characters: JSON.stringify(bootstrap).length,
    });
    return bootstrap;
  }

  private async applyBrainDecision(
    event: StreamEvent,
    decision: BrainDecision,
    latencyMs: number,
    interactionId: string,
    previousInteractionId: string,
  ): Promise<void> {
    this.coordinator.recordBrainDecision(event.id, { interactionId, previousInteractionId, latencyMs });
    await this.coordinator.submitBatch({
      eventId: event.id,
      reactions: decision.reactions.map(({ username, message }) => ({ username, message })),
    });
    if (decision.memoryUpdates.length > 0) {
      void this.persistBrainMemoryUpdates(event, decision).catch((cause: unknown) => {
        this.logger.warn('Brain memory updates failed after decision', { eventId: event.id, cause });
      });
    }
  }

  private async persistBrainMemoryUpdates(event: StreamEvent, decision: BrainDecision): Promise<void> {
    const globalUpdates = decision.memoryUpdates.filter((update) => update.scope === 'global');
    if (globalUpdates.length > 0) {
      const result = await this.globalMemory.recordFromBrain({
        memories: globalUpdates.map((update) => ({
          type: update.type,
          summary: update.summary,
          importance: update.importance,
          confidence: update.confidence,
          entities: update.entities ?? [],
          tags: update.tags ?? [],
          sourceEventId: event.id,
          occurredAt: event.timestamp,
        })),
      });
      if (result.rejected.length > 0) {
        this.logger.warn('Brain global memory proposals rejected', {
          eventId: event.id,
          reasons: result.rejected.map(({ reason }) => reason),
        });
      }
    }

    const candidates = new Map(this.botManager.candidates().map((candidate) => [candidate.username, candidate]));
    for (const update of decision.memoryUpdates) {
      if (update.scope !== 'persona') continue;
      const candidate = candidates.get(update.username);
      if (!candidate || update.confidence < 0.5) {
        this.logger.warn('Brain persona memory proposal rejected', {
          eventId: event.id, username: update.username, reason: candidate ? 'low_confidence' : 'unknown_candidate',
        });
        continue;
      }
      const summary = update.summary.replace(/\s+/g, ' ').trim();
      const existing = await this.personaMemory.list(candidate.persona.id, 200);
      if (existing.some((memory) => memory.summary.toLocaleLowerCase() === summary.toLocaleLowerCase())) continue;
      await this.personaMemory.remember({
        personaId: candidate.persona.id,
        type: update.type,
        summary,
        importance: update.importance,
        tags: update.tags ?? [event.type],
        ...(update.viewerUsername ? { viewerUsername: update.viewerUsername } : {}),
        eventId: event.id,
      });
    }
  }

  private queueBrainDelta(delta: BrainDynamicDelta): void {
    if (!this.mediaStreaming) return;
    this.geminiBrain?.queueDelta(delta);
  }

  private queuePersonaSnapshot(persona: BotPersona): void {
    this.botManager.candidates()
      .filter((candidate) => candidate.persona.id === persona.id)
      .forEach((candidate) => this.queueBrainDelta({
        type: 'PERSONA_UPDATED',
        summary: `Профиль ${candidate.username} обновлён.`,
        payload: { persona: this.personaContext.buildBrainSnapshot(candidate.username, persona) },
      }));
  }

  private getGeminiBrainStatus(): GeminiBrainStatus {
    return this.geminiBrain?.getStatus() ?? {
      state: 'OFFLINE',
      model: this.config.gemini.brainModel,
      thinkingLevel: this.config.gemini.brainThinkingLevel,
      interactions: 0,
      decisions: 0,
      silentDecisions: 0,
      generatedReactions: 0,
      averageLatencyMs: 0,
      rebuiltSessions: 0,
      rollovers: 0,
      contextTokens: 0,
      bootstrapChars: 0,
      bootstrapInputTokens: 0,
    };
  }

  private getEligibleBotAccounts(): BotAccountRecord[] {
    return this.botManager.listStatuses().filter((bot) => bot.enabled && bot.connectionState === 'CONNECTED' && bot.chatConnected);
  }

  private handleSpokenTranscript(text: string): void {
    if (!text.trim()) return;
    this.transcriptAccumulator = (this.transcriptAccumulator + ' ' + text).trim();
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = setTimeout(() => {
      const accumulated = this.transcriptAccumulator;
      this.transcriptAccumulator = '';
      this.processAccumulatedTranscript(accumulated);
    }, 2000);
  }

  private processAccumulatedTranscript(text: string): void {
    if (!this.mediaStreaming || !this.perception.getStatus().geminiConnected) return;
    const eligible = this.getEligibleBotAccounts();
    const candidates = this.botManager.listStatuses().map(bot => {
      const persona = this.personas.getOptional(bot.personaId);
      return { username: bot.username, aliases: persona?.spokenAliases ?? [] };
    });
    const signal = detectSpokenReactionSignal(
      text,
      candidates,
      this.greetedStreamGeneration !== this.streamGeneration,
    );
    if (!signal) return;
    if (signal.kind === 'greeting') this.greetedStreamGeneration = this.streamGeneration;
    if (signal.kind === 'direct_mention') this.perception.recordSpokenMention(eligible.length);
    const queued = this.mediaStreaming;
    if (queued) void this.perception.acceptCandidate(signal.candidate);
    this.logger.info('Spoken reaction signal detected', {
      kind: signal.kind,
      directMentions: signal.candidate.directMentions,
      eligibleBots: eligible.length,
      queued,
      streamGeneration: this.streamGeneration,
    });
  }

  private clearTranscriptAccumulator(): void {
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = undefined;
    this.transcriptAccumulator = '';
  }

  private async handleChat(message: ChatMessage): Promise<void> {
    this.contextStore.addChat(message);
    this.api.emitChat(message);
    if (message.kind !== 'viewer') {
      this.memory.recordChat(message);
      return;
    }
    const statuses = this.botManager.listStatuses();
    const explicitMentions = statuses
      .map((account) => account.username)
      .filter((username) => new RegExp(`@${escapeRegex(username)}\\b`, 'i').test(message.message));
    const recentPersonaIds = explicitMentions.length === 0
      ? await this.personaMemory.recentConversationPersonaIds(message.username, 3)
      : [];
    const targets = resolveViewerConversationTargets(statuses, explicitMentions, recentPersonaIds);
    if (targets.length === 0) {
      this.memory.recordChat(message);
      return;
    }
    const accountClassificationQuestion = isAccountClassificationQuestion(message.message);
    if (accountClassificationQuestion) {
      this.logger.info('Skipped account-classification question', {
        viewer: message.username,
        targets: targets.map(({ username }) => username),
      });
      return;
    }
    this.memory.recordChat(message);
    await Promise.all(targets.map(async (account) => {
      await this.personaMemory.addConversation({
        personaId: account.personaId,
        viewerUsername: message.username,
        role: 'viewer',
        message: message.message,
        createdAt: message.timestamp,
      });
      const importance = viewerMemoryImportance(message.message);
      if (shouldPersistViewerMemory(message.message, importance)) {
        await this.personaMemory.remember({
          personaId: account.personaId,
          type: 'viewer',
          summary: `${message.username} сказал(а): ${message.message}`,
          importance,
          tags: ['viewer', message.username],
          viewerUsername: message.username,
          createdAt: message.timestamp,
        });
      }
    }));
    await this.perception.acceptCandidate({
      timestamp: message.timestamp,
      type: 'conversation',
      summary: viewerConversationSummary(
        message.username,
        targets.map(({ username }) => username),
        message.message,
        explicitMentions.length > 0,
      ),
      speech: message.message,
      importance: 0.85,
      confidence: 1,
      directMentions: targets.map(({ username }) => username),
      viewerUsername: message.username.toLowerCase(),
    }, 'chat');
  }

  private async previewPersonaContext(personaId: string, query: string, requestedUsername?: string) {
    const persona = this.personas.get(personaId);
    const assigned = this.botManager.listStatuses().find((bot) =>
      bot.personaId === personaId && (!requestedUsername || bot.username === requestedUsername.toLowerCase()));
    const username = assigned?.username ?? requestedUsername?.toLowerCase() ?? `preview-${personaId}`;
    const recentMessages = assigned
      ? (await this.history.recent(assigned.username)).map((message) => message.message)
      : [];
    return this.personaContext.build({
      username,
      persona,
      event: {
        id: randomUUID(),
        timestamp: Date.now(),
        type: 'conversation',
        summary: query,
        speech: query,
        importance: 1,
        confidence: 1,
        source: 'chat',
        directMentions: [username],
      },
      recentMessages,
      directMention: true,
      viewerUsername: 'dashboard-preview',
      recentChat: this.contextStore.snapshot().recentChat,
      observeRuntime: false,
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
        // Helix enriches category metadata only. MediaPipeline STREAMING/OFFLINE is the
        // sole lifecycle authority for isLive and the Gemini Live session.
        this.contextStore.configure({ category: info.category });
        if (previous.category !== info.category) {
          this.logger.info('Twitch category updated', { category: info.category || 'offline' });
          this.queueBrainDelta({
            type: 'CATEGORY_CHANGED',
            summary: `${previous.category || 'без категории'} → ${info.category || 'без категории'}`,
            payload: { previousCategory: previous.category, category: info.category },
          });
        }
        this.logger.debug('Twitch Helix liveness observed (informational only)', { helixLive: info.isLive });
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
      this.queueBrainDelta({ type: 'CONTEXT_UPDATED', summary: settings.streamContext.slice(0, 500) });
    }
    const nextChannel = typeof settings.channel === 'string' ? normalizeChannel(settings.channel) : this.config.twitch.channel;
    const nextVisionFps = typeof settings.visionFps === 'number' ? settings.visionFps : this.config.stream.visionFps;
    const mediaChanged = nextChannel !== this.config.twitch.channel || nextVisionFps !== this.config.stream.visionFps;
    if (mediaChanged) {
      const channelChanged = nextChannel !== this.config.twitch.channel;
      if (channelChanged) await this.enqueueGlobalMemoryLifecycle(() => this.closeGlobalMemorySession('interrupted'));
      this.config.twitch.channel = nextChannel;
      this.config.stream.visionFps = nextVisionFps;
      this.contextStore.configure({ channel: nextChannel });
      await this.perception.reconfigureMedia(nextChannel, nextVisionFps);
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

  private async startGlobalMemorySession(): Promise<void> {
    const snapshot = this.contextStore.snapshot();
    if (!snapshot.channel) return;
    try {
      await this.globalMemory.startOrResumeSession({
        channel: snapshot.channel,
        ...(snapshot.category ? { initialCategory: snapshot.category } : {}),
        ...(snapshot.streamContext ? { initialStreamContext: snapshot.streamContext } : {}),
      });
    } catch (cause) {
      this.logger.warn('Stream session start failed', { cause });
    }
  }

  private async closeGlobalMemorySession(status: 'ended' | 'interrupted'): Promise<void> {
    try { await this.globalMemory.endCurrentSession(status); }
    catch (cause) { this.logger.warn('Stream session close failed', { cause, status }); }
  }

  private enqueueGlobalMemoryLifecycle(operation: () => Promise<void>): Promise<void> {
    const queued = this.globalMemoryLifecycle.then(operation, operation);
    this.globalMemoryLifecycle = queued.catch(() => undefined);
    return queued;
  }

  private async emitGlobalMemorySnapshot(): Promise<void> {
    try {
      const [memories, stats] = await Promise.all([
        this.globalMemory.list({ channel: this.config.twitch.channel, limit: 100 }),
        this.globalMemory.stats(this.config.twitch.channel),
      ]);
      this.api.emitStreamerMemories(memories);
      this.api.emitStreamerMemoryStats(stats);
    } catch (cause) {
      this.logger.warn('Global memory dashboard update failed', { cause });
    }
  }

  private async persistUsage(): Promise<void> {
    if (!this.databaseReady) return;
    try { await this.repository.saveUsageSnapshot(this.usage.snapshot()); }
    catch (cause) { this.logger.warn('Usage snapshot persistence failed', { cause }); }
  }

  private async refreshDatabaseHealth(): Promise<void> {
    this.databaseReady = Boolean(this.config.database.url && await this.repository.healthCheck());
  }

  private configureTwitchOAuth(): void {
    const { clientId, clientSecret, oauthRedirectUri, tokenEncryptionKey } = this.config.twitch;
    if (!clientId || !clientSecret || !oauthRedirectUri || !tokenEncryptionKey) {
      this.logger.warn('Refreshable Twitch OAuth is disabled; client credentials, redirect URI and encryption key are required');
      return;
    }
    this.twitchOAuth = new TwitchOAuthService({
      repository: this.repository,
      gateway: new OfficialTwitchOAuthGateway(clientId, clientSecret, oauthRedirectUri),
      validator: new OfficialTwitchTokenValidator(),
      encryptionKey: tokenEncryptionKey,
      callbackUrl: oauthRedirectUri,
    });
  }

  private async mergeStoredTwitchAccounts(): Promise<void> {
    if (!this.twitchOAuth) return;
    const storedBots = new Map((await this.repository.listBots()).map((bot) => [bot.username, bot]));
    const configured = new Map(this.config.twitch.accounts.map((account) => [account.username, account]));
    const statuses = await this.twitchOAuth.listAuthorizedAccounts();
    const outcomes = await settledInBatches(statuses, 10, (status) => this.twitchOAuth!.loadAuthorizedAccount(status.username));
    outcomes.forEach((outcome, index) => {
      const status = statuses[index]!;
      if (outcome.status === 'rejected') {
        this.logger.warn('Stored Twitch authorization could not be loaded', { bot: status.username, cause: outcome.reason });
        return;
      }
      const authorized = outcome.value;
      if (!authorized) return;
      const priorUsername = authorized.previousUsername ?? status.username;
      const priorConfig = configured.get(authorized.username) ?? configured.get(priorUsername);
      const priorStatus = storedBots.get(authorized.username) ?? storedBots.get(priorUsername);
      if (priorUsername !== authorized.username) configured.delete(priorUsername);
      configured.set(authorized.username, {
        username: authorized.username,
        oauthToken: authorized.accessToken,
        personaId: priorStatus?.personaId ?? priorConfig?.personaId ?? '',
        // A validated refreshable credential is safe to enable; persisted dashboard state remains authoritative.
        enabled: true,
      });
    });
    this.config.twitch.accounts = [...configured.values()];
  }

  private async completeTwitchAuthorization(code: string, state: string, browserState: string): Promise<{ username: string }> {
    if (!this.twitchOAuth) throw new Error('Refreshable Twitch OAuth is not configured');
    const authorized = await this.twitchOAuth.completeAuthorization(code, state, browserState);
    const priorUsername = authorized.previousUsername ?? authorized.username;
    const previous = this.botManager.listStatuses().find((bot) =>
      bot.username === authorized.username || bot.username === priorUsername);
    await this.botManager.upsertAuthorizedAccount({
      username: authorized.username,
      oauthToken: authorized.accessToken,
      personaId: previous?.personaId ?? '',
      enabled: previous?.enabled ?? true,
    }, authorized.previousUsername);
    const existingIndex = this.config.twitch.accounts.findIndex((account) =>
      account.username === authorized.username || account.username === priorUsername);
    const runtimeAccount = {
      username: authorized.username,
      oauthToken: authorized.accessToken,
      personaId: previous?.personaId ?? '',
      enabled: previous?.enabled ?? true,
    };
    if (existingIndex >= 0) this.config.twitch.accounts[existingIndex] = runtimeAccount;
    else this.config.twitch.accounts.push(runtimeAccount);
    this.contextStore.configure({ botUsernames: this.botManager.listStatuses().map((bot) => bot.username) });
    return { username: authorized.username };
  }

  private async refreshExpiringTwitchCredentials(): Promise<void> {
    if (!this.twitchOAuth) return;
    try {
      const refreshBefore = Date.now() + TWITCH_OAUTH_REFRESH_LEAD_MS;
      const accounts = (await this.twitchOAuth.listAuthorizedAccounts()).filter((account) =>
        account.expiresAt <= refreshBefore && account.refreshState !== 'RECONNECT_REQUIRED');
      const outcomes = await Promise.allSettled(accounts.map(async (account): Promise<AuthorizedTwitchAccount> => {
        const refreshed = await this.twitchOAuth!.refreshAccount(account.username);
        const priorUsername = refreshed.previousUsername ?? account.username;
        const current = this.botManager.listStatuses().find((bot) =>
          bot.username === refreshed.username || bot.username === priorUsername);
        await this.botManager.upsertAuthorizedAccount({
          username: refreshed.username,
          oauthToken: refreshed.accessToken,
          personaId: current?.personaId ?? '',
          enabled: current?.enabled ?? true,
        }, refreshed.previousUsername);
        return refreshed;
      }));
      outcomes.forEach((outcome, index) => {
        if (outcome.status === 'rejected') {
          this.logger.warn('Twitch token refresh failed', { bot: accounts[index]?.username, cause: outcome.reason });
        }
      });
    } catch (cause) {
      this.logger.warn('Twitch token refresh cycle failed', { cause });
    }
  }
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function resolveViewerConversationTargets<T extends { username: string; personaId: string }>(
  accounts: T[],
  explicitMentions: string[],
  recentPersonaIds: string[],
): T[] {
  if (explicitMentions.length > 0) {
    const mentioned = new Set(explicitMentions.map((username) => username.toLowerCase()));
    return accounts.filter((account) => mentioned.has(account.username.toLowerCase()));
  }
  for (const personaId of recentPersonaIds) {
    const account = accounts.find((candidate) => candidate.personaId === personaId);
    if (account) return [account];
  }
  return [];
}

export function viewerConversationSummary(
  viewerUsername: string,
  targetUsernames: string[],
  message: string,
  direct: boolean,
): string {
  const targets = targetUsernames.map((username) => `@${username}`).join(', ');
  return direct
    ? `${viewerUsername} напрямую обратился(ась) к ${targets}: ${message}`
    : `${viewerUsername} продолжил(а) недавний разговор с ${targets}: ${message}`;
}

export function viewerMemoryImportance(message: string): number {
  const normalized = message.toLowerCase();
  if (/(запомни|обещаю|напомни)/u.test(normalized)) return 0.9;
  if (/(я\s+(живу|работаю|учусь|еду|лечу|собираюсь|люблю|ненавижу)|у\s+меня)/u.test(normalized)) return 0.75;
  if (normalized.length >= 80) return 0.45;
  return 0.2;
}

/** Account-classification accusations stay in the short follow-up thread only. */
export function shouldPersistViewerMemory(message: string, importance = viewerMemoryImportance(message)): boolean {
  return !isAccountClassificationQuestion(message) && importance >= 0.4;
}
function stringSetting(value: unknown, fallback: string): string { return typeof value === 'string' ? value : fallback; }
function boundedNumberSetting(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && value >= minimum && value <= maximum ? value : fallback;
}

async function settledInBatches<T, R>(
  values: T[],
  batchSize: number,
  operation: (value: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const outcomes: Array<PromiseSettledResult<R>> = [];
  for (let index = 0; index < values.length; index += batchSize) {
    outcomes.push(...await Promise.allSettled(values.slice(index, index + batchSize).map(operation)));
  }
  return outcomes;
}
