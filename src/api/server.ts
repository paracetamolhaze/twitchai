import { createServer, Server as HttpServer } from 'node:http';
import cors from 'cors';
import express, { Express } from 'express';
import helmet from 'helmet';
import { Server as SocketServer } from 'socket.io';
import { z } from 'zod';
import { Logger } from '../logger';
import {
  GlobalMemoryRetrievalInput,
  GlobalStreamerMemoryStats,
  StreamerMemory,
  StreamerMemoryStatus,
  StreamerMemoryType,
  UpdateStreamerMemoryInput,
} from '../global-memory/types';
import { PersonaReactionContext } from '../personas/persona-context-builder';
import { auditPersonas } from '../personas/persona-quality';
import { PersonaRegenerationPreview } from '../personas/persona-store';
import { personaSchema } from '../personas/schema';
import { BotPersona, PersonaAuditReport, PersonaMemoryItem, PersonaSummary } from '../personas/types';
import { BotAccountRecord } from '../persistence/repository';
import { ReactionDecisionRecord } from '../reaction/types';
import { ChatMessage, StreamBrainStatus, StreamEvent } from '../stream-brain/types';
import { UsageSnapshot } from '../usage/usage-tracker';
import { LaunchedTwitchAuthorization, TwitchOAuthStatus } from '../twitch/oauth-service';
import type { BotEnabledResult, PersonaAssignmentResult } from '../twitch/bot-manager';
import { createDashboardAuth } from './auth';

export interface HealthPayload {
  status: 'ok' | 'degraded';
  twitch: boolean;
  streamBrain: boolean;
  gemini: boolean;
  database: boolean;
}

export interface OverviewPayload {
  channel: string;
  category: string;
  isLive: boolean;
  twitchConnected: boolean;
  streamBrain: StreamBrainStatus;
  activeBots: number;
  totalBots: number;
  uptimeSeconds: number;
}

export interface ApiServerDependencies {
  port: number;
  frontendUrls: string[];
  dashboardToken?: string;
  dashboardSessionDays?: number;
  secureCookies?: boolean;
  logger: Logger;
  health: () => HealthPayload;
  overview: () => OverviewPayload;
  bots: () => BotAccountRecord[];
  setBotEnabled: (username: string, enabled: boolean) => Promise<BotEnabledResult>;
  assignBotPersona: (username: string, personaId: string) => Promise<PersonaAssignmentResult>;
  events: (limit: number) => Promise<StreamEvent[]>;
  chat: () => ChatMessage[];
  usage: () => UsageSnapshot;
  decisions?: () => ReactionDecisionRecord[];
  settings: () => Promise<Record<string, unknown>>;
  updateSettings: (settings: Record<string, unknown>) => Promise<{ restartRequired: string[] }>;
  personas: () => BotPersona[];
  personaSummaries: () => PersonaSummary[];
  personaAudit: () => PersonaAuditReport;
  persona: (id: string) => BotPersona | undefined;
  createPersona: (persona: BotPersona) => Promise<BotPersona>;
  createBlankPersona: (id: string, name: string) => Promise<BotPersona>;
  createPersonaTemplate: (username: string, id?: string) => Promise<BotPersona>;
  duplicatePersona: (sourceId: string, id: string, name: string) => Promise<BotPersona>;
  updatePersona: (persona: BotPersona) => Promise<BotPersona>;
  previewPersonaRegeneration: (id: string) => Promise<PersonaRegenerationPreview>;
  previewAllPersonaRegenerations: () => Promise<PersonaRegenerationPreview[]>;
  regeneratePersona: (id: string, previewHash: string) => Promise<BotPersona>;
  regenerateAllPersonas: (previews: Array<{ personaId: string; previewHash: string }>) => Promise<BotPersona[]>;
  deletePersona: (id: string) => Promise<boolean>;
  personaMemories: (personaId: string, limit: number) => Promise<PersonaMemoryItem[]>;
  deletePersonaMemory: (personaId: string, memoryId: string) => Promise<boolean>;
  previewPersonaContext: (personaId: string, query: string, username?: string) => Promise<PersonaReactionContext>;
  streamerMemories: (input: {
    type?: StreamerMemoryType;
    status?: StreamerMemoryStatus;
    search?: string;
    limit?: number;
  }) => Promise<StreamerMemory[]>;
  streamerMemoryStats: () => Promise<GlobalStreamerMemoryStats>;
  updateStreamerMemory: (input: Omit<UpdateStreamerMemoryInput, 'channel'>) => Promise<StreamerMemory | undefined>;
  deleteStreamerMemory: (id: string) => Promise<boolean>;
  previewStreamerMemoryContext: (input: Omit<GlobalMemoryRetrievalInput, 'channel'>) => Promise<StreamerMemory[]>;
  twitchOAuth?: {
    status: () => Promise<TwitchOAuthStatus>;
    startAuthorization: () => Promise<string>;
    launchAuthorization: (ticket: string) => Promise<LaunchedTwitchAuthorization>;
    abandonAuthorization: (state: string, browserState: string) => Promise<void>;
    completeAuthorization: (code: string, state: string, browserState: string) => Promise<{ username: string }>;
  };
}

export interface ApiServer {
  app: Express;
  http: HttpServer;
  io: SocketServer;
  start(): Promise<void>;
  stop(): Promise<void>;
  emitChat(message: ChatMessage): void;
  emitEvent(event: StreamEvent): void;
  emitBots(bots: BotAccountRecord[]): void;
  emitBrain(status: StreamBrainStatus): void;
  emitDecision(decision: ReactionDecisionRecord): void;
  emitStreamerMemories(memories: StreamerMemory[]): void;
  emitStreamerMemory(memory: StreamerMemory): void;
  emitStreamerMemoryStats(stats: GlobalStreamerMemoryStats): void;
  emitOverview(): void;
}

const settingsSchema = z.object({
  channel: z.string().trim().min(1).max(50).optional(),
  streamContext: z.string().max(2_000).optional(),
  visionFps: z.number().min(0.05).max(1).optional(),
}).strict();

const streamerMemoryListSchema = z.object({
  type: z.enum(['fact', 'preference', 'person', 'relationship', 'plan', 'promise', 'result', 'place', 'trip', 'running_joke', 'important_event', 'recurring_context', 'other']).optional(),
  status: z.enum(['active', 'resolved', 'superseded', 'expired']).optional(),
  search: z.string().trim().min(1).max(300).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();

const streamerMemoryUpdateSchema = z.object({
  summary: z.string().trim().min(1).max(600).optional(),
  details: z.record(z.unknown()).optional(),
  entities: z.array(z.string().trim().min(1).max(120)).max(16).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(16).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  occurredAt: z.number().int().positive().nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  status: z.enum(['active', 'resolved', 'expired']).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'Нужно передать хотя бы одно поле памяти');

const streamerMemoryPreviewSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  entities: z.array(z.string().trim().min(1).max(120)).max(16).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(16).optional(),
  limit: z.number().int().min(1).max(15).optional(),
}).strict();

export function createApiServer(dependencies: ApiServerDependencies): ApiServer {
  const logger = dependencies.logger.child('API');
  const app = express();
  const http = createServer(app);
  const allowedOrigins = new Set(dependencies.frontendUrls.map((url) => url.replace(/\/$/, '')));
  const originAllowed = (origin?: string): boolean => !origin || allowedOrigins.has(origin.replace(/\/$/, ''));
  const corsOptions: cors.CorsOptions = {
    origin(origin, callback) {
      if (originAllowed(origin)) callback(null, true);
      else callback(new Error('Origin is not allowed'));
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Dashboard-Token'],
  };
  const auth = createDashboardAuth({
    token: dependencies.dashboardToken,
    sessionDays: dependencies.dashboardSessionDays ?? 30,
    secureCookies: dependencies.secureCookies ?? false,
  });
  const io = new SocketServer(http, {
    cors: corsOptions,
    transports: ['websocket', 'polling'],
  });

  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors(corsOptions));
  app.use(express.json({ limit: '512kb' }));
  app.get('/', (_request, response) => response.json({ name: 'Twitch AI Viewers backend', version: 2 }));
  app.get('/health', (_request, response) => {
    const health = dependencies.health();
    response.status(health.status === 'ok' ? 200 : 503).json(health);
  });
  app.post('/api/auth/login', (request, response) => {
    if (!auth.configured()) return response.status(503).json({ error: 'Авторизация панели не настроена на сервере' });
    const body = z.object({ token: z.string().min(1).max(1_000) }).safeParse(request.body);
    if (!body.success || !auth.authenticate(request, body.data.token)) return response.status(401).json({ error: 'Неверный токен' });
    auth.issueSession(response);
    return response.json({ authenticated: true });
  });
  app.get('/api/auth/session', (request, response) => {
    if (!auth.configured()) return response.status(503).json({ error: 'Авторизация панели не настроена на сервере' });
    return auth.authenticate(request)
      ? response.json({ authenticated: true })
      : response.status(401).json({ authenticated: false });
  });
  app.post('/api/auth/logout', (_request, response) => {
    auth.clearSession(response);
    response.json({ authenticated: false });
  });
  app.get('/api/twitch/oauth/launch', async (request, response) => {
    const redirect = dashboardRedirect(dependencies.frontendUrls[0]);
    const ticket = typeof request.query.ticket === 'string' ? request.query.ticket : '';
    if (!dependencies.twitchOAuth || !ticket) {
      redirect.searchParams.set('twitchOAuth', 'error');
      redirect.searchParams.set('reason', dependencies.twitchOAuth ? 'invalid_launch' : 'not_configured');
      return response.redirect(302, redirect.toString());
    }
    try {
      const launched = await dependencies.twitchOAuth.launchAuthorization(ticket);
      response.append('Set-Cookie', serializeOAuthStateCookie(
        launched.browserState,
        10 * 60,
        dependencies.secureCookies ?? false,
      ));
      return response.redirect(302, launched.authorizationUrl);
    } catch (cause) {
      logger.warn('Twitch OAuth launch failed', { cause });
      redirect.searchParams.set('twitchOAuth', 'error');
      redirect.searchParams.set('reason', 'invalid_launch');
      return response.redirect(302, redirect.toString());
    }
  });
  app.get('/api/twitch/oauth/callback', async (request, response) => {
    const redirect = dashboardRedirect(dependencies.frontendUrls[0]);
    const browserState = parseCookie(request.headers.cookie, TWITCH_OAUTH_STATE_COOKIE) ?? '';
    response.append('Set-Cookie', serializeOAuthStateCookie('', 0, dependencies.secureCookies ?? false));
    if (!dependencies.twitchOAuth) {
      redirect.searchParams.set('twitchOAuth', 'error');
      redirect.searchParams.set('reason', 'not_configured');
      return response.redirect(302, redirect.toString());
    }
    if (typeof request.query.error === 'string') {
      const state = typeof request.query.state === 'string' ? request.query.state : '';
      try {
        await dependencies.twitchOAuth.abandonAuthorization(state, browserState);
        redirect.searchParams.set('reason', 'access_denied');
      } catch (cause) {
        logger.warn('Twitch OAuth denial had invalid state', { cause });
        redirect.searchParams.set('reason', 'invalid_state');
      }
      redirect.searchParams.set('twitchOAuth', 'error');
      return response.redirect(302, redirect.toString());
    }
    const query = z.object({ code: z.string().min(1).max(1_000), state: z.string().min(1).max(2_000) }).safeParse(request.query);
    if (!query.success) {
      const state = typeof request.query.state === 'string' ? request.query.state : '';
      if (state && browserState) {
        try { await dependencies.twitchOAuth.abandonAuthorization(state, browserState); }
        catch (cause) { logger.warn('Malformed Twitch OAuth callback had invalid state', { cause }); }
      }
      redirect.searchParams.set('twitchOAuth', 'error');
      redirect.searchParams.set('reason', 'invalid_callback');
      return response.redirect(302, redirect.toString());
    }
    try {
      const account = await dependencies.twitchOAuth.completeAuthorization(query.data.code, query.data.state, browserState);
      redirect.searchParams.set('twitchOAuth', 'success');
      redirect.searchParams.set('username', account.username);
    } catch (cause) {
      logger.warn('Twitch OAuth callback failed', { cause });
      redirect.searchParams.set('twitchOAuth', 'error');
      redirect.searchParams.set('reason', cause instanceof Error && cause.message.includes('OAuth state')
        ? 'invalid_state'
        : 'authorization_failed');
    }
    return response.redirect(302, redirect.toString());
  });
  app.use('/api', auth.middleware);
  app.get('/api/twitch/oauth/status', async (_request, response, next) => {
    try {
      response.json(dependencies.twitchOAuth
        ? await dependencies.twitchOAuth.status()
        : { configured: false, accounts: [] });
    } catch (error) { next(error); }
  });
  app.post('/api/twitch/oauth/start', async (_request, response, next) => {
    if (!dependencies.twitchOAuth) return response.status(503).json({ error: 'OAuth Twitch не настроен на сервере' });
    try {
      return response.json({ authorizationUrl: await dependencies.twitchOAuth.startAuthorization() });
    } catch (error) { return next(error); }
  });
  app.get('/api/overview', (_request, response) => response.json(dependencies.overview()));
  app.get('/api/bots', (_request, response) => response.json(dependencies.bots()));
  app.patch('/api/bots/:username', async (request, response, next) => {
    try {
      const body = z.object({ enabled: z.boolean().optional(), personaId: z.string().trim().min(1).max(80).optional() })
        .strict().refine((value) => value.enabled !== undefined || value.personaId !== undefined, 'Нужно передать enabled или personaId')
        .parse(request.body);
      if (body.personaId !== undefined) {
        const assignment = await dependencies.assignBotPersona(request.params.username, body.personaId);
        if (assignment === 'bot_not_found') return response.status(404).json({ error: 'Бот не найден' });
        if (assignment === 'persona_not_found') return response.status(400).json({ error: 'Личность не найдена' });
        if (assignment === 'persona_in_use') return response.status(409).json({ error: 'Эта личность уже назначена другому Twitch-аккаунту' });
        if (assignment === 'persona_username_mismatch') return response.status(409).json({ error: 'Эта личность создана для другого Twitch-аккаунта' });
        if (assignment === 'persona_incomplete') return response.status(409).json({ error: 'Сначала заполните и проверьте ручную личность' });
      }
      if (body.enabled !== undefined) {
        const updated = await dependencies.setBotEnabled(request.params.username, body.enabled);
        if (updated === 'bot_not_found') return response.status(404).json({ error: 'Бот не найден' });
        if (updated === 'persona_username_mismatch') return response.status(409).json({ error: 'Текущая личность создана для другого Twitch-аккаунта' });
        if (updated === 'persona_incomplete') return response.status(409).json({ error: 'Сначала заполните и проверьте ручную личность' });
      }
      return response.json({ ok: true });
    } catch (error) { return next(error); }
  });
  app.get('/api/events', async (request, response, next) => {
    try {
      const limit = z.coerce.number().int().min(1).max(200).default(50).parse(request.query.limit);
      response.json(await dependencies.events(limit));
    } catch (error) { next(error); }
  });
  app.get('/api/chat', (_request, response) => response.json(dependencies.chat()));
  app.get('/api/usage', (_request, response) => response.json(dependencies.usage()));
  app.get('/api/decisions', (_request, response) => response.json(dependencies.decisions?.() ?? []));
  app.get('/api/streamer-memories', async (request, response, next) => {
    try { return response.json(await dependencies.streamerMemories(streamerMemoryListSchema.parse(request.query))); }
    catch (error) { return next(error); }
  });
  app.get('/api/streamer-memories/stats', async (_request, response, next) => {
    try { return response.json(await dependencies.streamerMemoryStats()); }
    catch (error) { return next(error); }
  });
  app.post('/api/streamer-memories/context-preview', async (request, response, next) => {
    try {
      const body = streamerMemoryPreviewSchema.parse(request.body);
      return response.json(await dependencies.previewStreamerMemoryContext(body));
    } catch (error) { return next(error); }
  });
  app.patch('/api/streamer-memories/:id', async (request, response, next) => {
    try {
      const update = streamerMemoryUpdateSchema.parse(request.body);
      const memory = await dependencies.updateStreamerMemory({ id: request.params.id, ...update });
      return memory ? response.json(memory) : response.status(404).json({ error: 'Запись памяти не найдена' });
    } catch (error) { return next(error); }
  });
  app.delete('/api/streamer-memories/:id', async (request, response, next) => {
    try {
      const deleted = await dependencies.deleteStreamerMemory(request.params.id);
      return deleted ? response.status(204).send() : response.status(404).json({ error: 'Запись памяти не найдена' });
    } catch (error) { return next(error); }
  });
  app.get('/api/settings', async (_request, response, next) => {
    try { response.json(await dependencies.settings()); } catch (error) { next(error); }
  });
  app.patch('/api/settings', async (request, response, next) => {
    try {
      const settings = settingsSchema.parse(request.body);
      response.json({ ok: true, ...(await dependencies.updateSettings(settings)) });
    } catch (error) { next(error); }
  });
  app.get('/api/personas', (_request, response) => response.json(dependencies.personas()));
  app.get('/api/persona-summaries', (_request, response) => response.json(dependencies.personaSummaries()));
  app.get('/api/persona-audit', (_request, response) => response.json(dependencies.personaAudit()));
  app.post('/api/persona-regeneration/preview', async (_request, response, next) => {
    try {
      const items = await dependencies.previewAllPersonaRegenerations();
      return response.json({
        items,
        audit: auditPersonas(items.map((item) => ({ username: item.username, persona: item.proposed }))),
      });
    }
    catch (error) { return next(error); }
  });
  app.post('/api/persona-regeneration/apply', async (request, response, next) => {
    try {
      const body = z.object({ previews: z.array(z.object({ personaId: z.string().trim().min(1).max(80), previewHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(100) }).strict().parse(request.body);
      return response.json({ personas: await dependencies.regenerateAllPersonas(body.previews), audit: dependencies.personaAudit() });
    } catch (error) {
      if (error instanceof Error && error.message === 'persona_regeneration_preview_stale') return response.status(409).json({ error: 'Предпросмотр устарел. Обновите его перед сохранением.' });
      if (error instanceof Error && error.message === 'persona_regeneration_requires_individual_confirmation') {
        return response.status(409).json({ error: 'В массовом применении есть профиль с чувствительными ручными изменениями. Откройте его сравнение и подтвердите обновление отдельно.' });
      }
      return next(error);
    }
  });
  app.get('/api/personas/:id', (request, response) => {
    const persona = dependencies.persona(request.params.id);
    return persona ? response.json(persona) : response.status(404).json({ error: 'Личность не найдена' });
  });
  app.post('/api/personas', async (request, response, next) => {
    try {
      const manual = z.object({ mode: z.literal('manual'), id: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(120) }).strict().safeParse(request.body);
      if (manual.success) return response.status(201).json(await dependencies.createBlankPersona(manual.data.id, manual.data.name));
      const template = z.object({ mode: z.literal('template'), username: z.string().trim().min(1).max(50), id: z.string().trim().min(1).max(80).optional() }).strict().safeParse(request.body);
      if (template.success) return response.status(201).json(await dependencies.createPersonaTemplate(template.data.username, template.data.id));
      const duplicate = z.object({ mode: z.literal('duplicate'), sourceId: z.string().trim().min(1).max(80), id: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(120) }).strict().safeParse(request.body);
      if (duplicate.success) return response.status(201).json(await dependencies.duplicatePersona(duplicate.data.sourceId, duplicate.data.id, duplicate.data.name));
      const persona = personaSchema.parse(request.body);
      return response.status(201).json(await dependencies.createPersona(persona));
    } catch (error) {
      if (error instanceof Error && error.message === 'persona_already_exists') return response.status(409).json({ error: 'Личность с таким ID уже существует' });
      if (error instanceof Error && error.message === 'persona_blueprint_not_found') return response.status(422).json({ error: 'Для этого username ещё нет проверенной личности v3. Создайте её вручную.' });
      if (error instanceof Error && error.message.includes('not found')) return response.status(404).json({ error: 'Исходная личность не найдена' });
      if (error instanceof Error && error.message.startsWith('persona_relationship_')) return response.status(400).json({ error: 'Некорректная связь между личностями' });
      return next(error);
    }
  });
  app.put('/api/personas/:id', async (request, response, next) => {
    try {
      const persona = personaSchema.parse({ ...request.body, id: request.params.id });
      if (persona.behavior.verbosity.minWords > persona.behavior.verbosity.maxWords) {
        return response.status(400).json({ error: 'Минимальное число слов не может быть больше максимального' });
      }
      return response.json(await dependencies.updatePersona(persona));
    } catch (error) {
      if (error instanceof Error && error.message === 'persona_not_found') return response.status(404).json({ error: 'Личность не найдена' });
      if (error instanceof Error && error.message.startsWith('persona_relationship_')) return response.status(400).json({ error: 'Некорректная связь между личностями' });
      return next(error);
    }
  });
  app.post('/api/personas/:id/regeneration-preview', async (request, response, next) => {
    try { return response.json(await dependencies.previewPersonaRegeneration(request.params.id)); }
    catch (error) {
      if (error instanceof Error && error.message === 'persona_manual_regeneration_forbidden') return response.status(409).json({ error: 'Личность создана вручную и не может быть автоматически пересоздана' });
      if (error instanceof Error && error.message.includes('not found')) return response.status(404).json({ error: 'Личность не найдена' });
      return next(error);
    }
  });
  app.post('/api/personas/:id/regenerate', async (request, response, next) => {
    try {
      const body = z.object({ previewHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
      return response.json(await dependencies.regeneratePersona(request.params.id, body.previewHash));
    } catch (error) {
      if (error instanceof Error && error.message === 'persona_regeneration_preview_stale') return response.status(409).json({ error: 'Предпросмотр устарел. Обновите его перед сохранением.' });
      if (error instanceof Error && error.message === 'persona_manual_regeneration_forbidden') return response.status(409).json({ error: 'Личность создана вручную и не может быть автоматически пересоздана' });
      if (error instanceof Error && error.message.includes('not found')) return response.status(404).json({ error: 'Личность не найдена' });
      return next(error);
    }
  });
  app.delete('/api/personas/:id', async (request, response, next) => {
    try {
      if (dependencies.bots().some((bot) => bot.personaId === request.params.id)) {
        return response.status(409).json({ error: 'Нельзя удалить личность, пока она назначена Twitch-аккаунту' });
      }
      const deleted = await dependencies.deletePersona(request.params.id);
      return deleted ? response.status(204).send() : response.status(404).json({ error: 'Личность не найдена' });
    } catch (error) {
      if (error instanceof Error && error.message === 'persona_in_use') return response.status(409).json({ error: 'Нельзя удалить личность, пока она назначена Twitch-аккаунту' });
      if (error instanceof Error && error.message === 'persona_builtin') return response.status(409).json({ error: 'Встроенную демонстрационную личность нельзя удалить' });
      return next(error);
    }
  });
  app.get('/api/personas/:id/memories', async (request, response, next) => {
    try {
      if (!dependencies.persona(request.params.id)) return response.status(404).json({ error: 'Личность не найдена' });
      const limit = z.coerce.number().int().min(1).max(200).default(50).parse(request.query.limit);
      return response.json(await dependencies.personaMemories(request.params.id, limit));
    } catch (error) { return next(error); }
  });
  app.delete('/api/personas/:id/memories/:memoryId', async (request, response, next) => {
    try {
      const deleted = await dependencies.deletePersonaMemory(request.params.id, request.params.memoryId);
      return deleted ? response.status(204).send() : response.status(404).json({ error: 'Воспоминание не найдено' });
    } catch (error) { return next(error); }
  });
  app.post('/api/personas/:id/context-preview', async (request, response, next) => {
    try {
      const body = z.object({ query: z.string().trim().min(1).max(1_000), username: z.string().trim().min(1).max(50).optional() }).strict().parse(request.body);
      if (!dependencies.persona(request.params.id)) return response.status(404).json({ error: 'Личность не найдена' });
      return response.json(await dependencies.previewPersonaContext(request.params.id, body.query, body.username));
    } catch (error) { return next(error); }
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    void _next;
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: 'Некорректный запрос', issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) });
      return;
    }
    logger.warn('API request failed', { error });
    response.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  io.use((socket, next) => {
    if (!originAllowed(socket.handshake.headers.origin)) return next(new Error('Origin is not allowed'));
    const requestLike = {
      headers: { cookie: socket.handshake.headers.cookie },
      header: (name: string) => {
        const value = socket.handshake.headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] : value;
      },
    };
    return auth.authenticate(requestLike, socket.handshake.auth?.token) ? next() : next(new Error('Unauthorized'));
  });
  io.on('connection', (socket) => {
    socket.emit('overview', dependencies.overview());
    socket.emit('bots', dependencies.bots());
    socket.emit('chat:init', dependencies.chat());
    void dependencies.events(50)
      .then((events) => socket.emit('events:init', events))
      .catch((error: unknown) => logger.warn('Initial realtime event load failed', { error }));
    void Promise.all([dependencies.streamerMemories({ limit: 100 }), dependencies.streamerMemoryStats()])
      .then(([memories, stats]) => {
        socket.emit('streamer-memories:init', memories);
        socket.emit('streamer-memory-stats', stats);
      })
      .catch((error: unknown) => logger.warn('Initial realtime memory load failed', { error }));
  });

  return {
    app,
    http,
    io,
    start: () => new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(dependencies.port, () => {
        http.off('error', reject);
        logger.info('Backend listening', { port: dependencies.port });
        resolve();
      });
    }),
    stop: () => new Promise<void>((resolve) => {
      io.close();
      if (!http.listening) return resolve();
      return http.close(() => resolve());
    }),
    emitChat: (message) => io.emit('chat', message),
    emitEvent: (event) => io.emit('event', event),
    emitBots: (bots) => io.emit('bots', bots),
    emitBrain: (status) => io.emit('brain', status),
    emitDecision: (decision) => io.emit('decision', decision),
    emitStreamerMemories: (memories) => io.emit('streamer-memories:init', memories),
    emitStreamerMemory: (memory) => io.emit('streamer-memory', memory),
    emitStreamerMemoryStats: (stats) => io.emit('streamer-memory-stats', stats),
    emitOverview: () => io.emit('overview', dependencies.overview()),
  };
}

function dashboardRedirect(frontendUrl: string | undefined): URL {
  return new URL('/', frontendUrl || 'http://localhost:5173');
}

const TWITCH_OAUTH_STATE_COOKIE = 'twitchai_oauth_state';

function serializeOAuthStateCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${TWITCH_OAUTH_STATE_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/api/twitch/oauth',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  const raw = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!raw) return undefined;
  try { return decodeURIComponent(raw.slice(name.length + 1)); } catch { return undefined; }
}
