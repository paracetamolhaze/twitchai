import { randomUUID } from 'node:crypto';
import { ApiServer, createApiServer } from './api/server';
import { AppConfig, normalizeChannel } from './config';
import { ReactionMemory } from './learning/reaction-memory';
import { Logger } from './logger';
import { BotHistory } from './personas/bot-history';
import { PersonaContextBuilder } from './personas/persona-context-builder';
import { PersonaMemory } from './personas/persona-memory';
import { PersonaRuntimeStore } from './personas/persona-runtime-store';
import { PersonaStore } from './personas/persona-store';
import { AppRepository, BotAccountRecord } from './persistence/repository';
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
import { OfficialTwitchOAuthGateway } from './twitch/oauth-client';
import { AuthorizedTwitchAccount, TwitchOAuthService } from './twitch/oauth-service';
import { OfficialTwitchTokenValidator } from './twitch/oauth-validator';
import { UsageTracker } from './usage/usage-tracker';

const TWITCH_OAUTH_REFRESH_INTERVAL_MS = 60_000;
const TWITCH_OAUTH_REFRESH_LEAD_MS = 5 * 60_000;

export class Application {
  private readonly logger: Logger;
  private readonly usage = new UsageTracker();
  private readonly repository: AppRepository;
  private readonly contextStore: ContextStore;
  private readonly personas: PersonaStore;
  private readonly policy: ReactionPolicyGuard;
  private readonly memory: ReactionMemory;
  private readonly history: BotHistory;
  private readonly personaMemory: PersonaMemory;
  private readonly personaRuntime: PersonaRuntimeStore;
  private readonly personaContext: PersonaContextBuilder;
  private readonly decisions: ReactionDecisionRecord[] = [];
  private botManager!: TwitchBotManager;
  private brain!: StreamBrainService;
  private coordinator!: ReactionCoordinator;
  private api!: ApiServer;
  private gemini?: GeminiLiveClient;
  private transcriber?: GroqWhisperFallback;
  private twitchOAuth?: TwitchOAuthService;
  private categoryTimer?: NodeJS.Timeout;
  private usageTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private oauthRefreshTimer?: NodeJS.Timeout;
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
      assignBotPersona: (username, personaId) => this.botManager.assignPersona(username, personaId),
      events: (limit) => this.repository.listStreamEvents(limit),
      chat: () => this.contextStore.snapshot().recentChat,
      usage: () => this.usage.snapshot(),
      decisions: () => [...this.decisions].reverse(),
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
        return updated;
      },
      previewPersonaRegeneration: (id) => this.personas.previewRegeneration(id),
      previewAllPersonaRegenerations: () => this.personas.previewAllRegenerations(),
      regeneratePersona: async (id, previewHash) => {
        const updated = await this.personas.regenerate(id, previewHash);
        await this.botManager.revalidatePersona(updated.id);
        return updated;
      },
      regenerateAllPersonas: async (previews) => {
        const updated = await this.personas.regenerateAll(previews);
        await Promise.all(updated.map((persona) => this.botManager.revalidatePersona(persona.id)));
        return updated;
      },
      deletePersona: (id) => this.personas.delete(id),
      personaMemories: (personaId, limit) => this.personaMemory.list(personaId, limit),
      deletePersonaMemory: (personaId, memoryId) => this.personaMemory.delete(personaId, memoryId),
      previewPersonaContext: (personaId, query, username) => this.previewPersonaContext(personaId, query, username),
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
    await Promise.allSettled([this.brain.start(), this.botManager.start()]);
    this.startCategoryMonitor();
    this.usageTimer = setInterval(() => { void this.persistUsage(); }, 60_000);
    this.healthTimer = setInterval(() => { void this.refreshDatabaseHealth(); }, 30_000);
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
    this.categoryTimer = undefined;
    this.usageTimer = undefined;
    this.healthTimer = undefined;
    this.oauthRefreshTimer = undefined;
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
    this.botManager.on('status', (bots: BotAccountRecord[]) => {
      this.contextStore.configure({ botUsernames: bots.map((bot) => bot.username) });
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
    const statuses = this.botManager.listStatuses();
    const explicitMentions = statuses
      .map((account) => account.username)
      .filter((username) => new RegExp(`@${escapeRegex(username)}\\b`, 'i').test(message.message));
    const recentPersonaIds = explicitMentions.length === 0
      ? await this.personaMemory.recentConversationPersonaIds(message.username, 3)
      : [];
    const targets = resolveViewerConversationTargets(statuses, explicitMentions, recentPersonaIds);
    if (targets.length === 0) return;
    await Promise.all(targets.map(async (account) => {
      await this.personaMemory.addConversation({
        personaId: account.personaId,
        viewerUsername: message.username,
        role: 'viewer',
        message: message.message,
        createdAt: message.timestamp,
      });
      const importance = viewerMemoryImportance(message.message);
      if (importance >= 0.4) {
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
    this.brain.requestReaction({
      timestamp: message.timestamp,
      type: 'conversation',
      summary: explicitMentions.length > 0
        ? `${message.username} directly addressed ${targets.map(({ username }) => `@${username}`).join(', ')}: ${message.message}`
        : `${message.username} continued a recent conversation with @${targets[0]!.username}: ${message.message}`,
      speech: message.message,
      importance: 0.85,
      confidence: 1,
      directMentions: targets.map(({ username }) => username),
      viewerUsername: message.username.toLowerCase(),
    });
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

function viewerMemoryImportance(message: string): number {
  const normalized = message.toLowerCase();
  if (/(запомни|обещаю|напомни)/u.test(normalized)) return 0.9;
  if (/(я\s+(живу|работаю|учусь|еду|лечу|собираюсь|люблю|ненавижу)|у\s+меня)/u.test(normalized)) return 0.75;
  if (normalized.length >= 80) return 0.45;
  return 0.2;
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
