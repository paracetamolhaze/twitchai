import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiServer, ApiServer } from '../src/api/server';
import { Logger } from '../src/logger';
import { generatePersonaV3 } from '../src/personas/generator-v3';
import { auditPersonas } from '../src/personas/persona-quality';
import { personaSummary } from '../src/personas/schema';
import { StreamEvent } from '../src/stream-brain/types';
import { StreamerMemory } from '../src/global-memory/types';

const token = 'a-secure-test-token';
const event: StreamEvent = {
  id: '4cd428b2-65d8-4359-891f-f020ec39ad2b', timestamp: 1000, type: 'funny', summary: 'unexpected moment',
  importance: 0.8, confidence: 0.9, source: 'gemini-live', directMentions: [],
};
const streamerMemory: StreamerMemory = {
  id: 'memory-thailand', channel: 'channel', type: 'plan', summary: 'Стример завтра летит в Таиланд',
  entities: ['Таиланд'], tags: ['поездка', 'план'], importance: 0.82, confidence: 0.96,
  createdAt: 1000, updatedAt: 1000, lastSeenAt: 1000, confirmationCount: 1, status: 'active', dedupeKey: 'plan|thailand',
};
let servers: ApiServer[] = [];
const testPersona = generatePersonaV3('karlbekner', { id: 'account-karlbekner' });
const alternatePersona = generatePersonaV3('gigantiuz', { id: 'account-gigantiuz' });
const testPersonas = [testPersona, alternatePersona];
const testAudit = auditPersonas(testPersonas.map((persona) => ({ username: persona.generatedFromUsername, persona })));

function server(twitchOAuth?: {
  status: () => Promise<{ configured: boolean; callbackUrl: string; accounts: never[] }>;
  startAuthorization: () => Promise<string>;
  launchAuthorization: (ticket: string) => Promise<{ authorizationUrl: string; browserState: string }>;
  abandonAuthorization: (state: string, browserState: string) => Promise<void>;
  completeAuthorization: (code: string, state: string, browserState: string) => Promise<{ username: string }>;
}, extraDependencies: Partial<Parameters<typeof createApiServer>[0]> = {}): ApiServer {
  let streamerMemories = [structuredClone(streamerMemory)];
  const api = createApiServer({
    port: 0, frontendUrls: ['http://localhost:5173'], dashboardToken: token, logger: new Logger('TEST', 'error'),
    health: () => ({ status: 'ok', twitch: true, streamBrain: true, gemini: true, database: true }),
    overview: () => ({ channel: 'channel', category: 'Dota 2', isLive: true, twitchConnected: true,
      streamBrain: {
        state: 'CONNECTED', mediaState: 'STREAMING', geminiState: 'CONNECTED',
        mediaConnected: true, geminiConnected: true, geminiStable: true,
        geminiSessionActive: true, geminiSessionReason: 'twitch_live',
      }, activeBots: 1, totalBots: 1, uptimeSeconds: 5 }),
    bots: () => [{ username: 'bot', personaId: testPersona.id, enabled: true, connectionState: 'CONNECTED', chatConnected: true, messagesSent: 2 }],
    setBotEnabled: async () => 'updated',
    assignBotPersona: async () => 'updated',
    events: async () => [event],
    chat: () => [],
    usage: () => ({ startedAt: 0, uptimeSeconds: 1, streamMinutes: 0, audioMinutes: 0, videoMinutes: 0,
      capturedAudioMinutes: 0, capturedVideoMinutes: 0, geminiAudioSentMinutes: 0, geminiVideoSentMinutes: 0,
      geminiReconnects: 0, geminiInputTokens: 0, geminiOutputTokens: 0, geminiToolCalls: 0,
      preparedReactionContexts: 0, reactionBatches: 0, emptyReactionBatches: 0, guardRejections: 0,
      eventsDetected: 0, generatedResponses: 0, sentResponses: 0, skippedResponses: 0,
      memoryToolCalls: 0, memoriesCreated: 0, memoriesMerged: 0, memoriesSuperseded: 0, memoryRetrievals: 0,
      currentStream: {
        active: true, startedAt: 0, durationMinutes: 0, capturedAudioMinutes: 0, capturedVideoMinutes: 0,
        geminiAudioSentMinutes: 0, geminiVideoSentMinutes: 0, geminiReconnects: 0,
        geminiInputTokens: 0, geminiOutputTokens: 0, sentResponses: 0,
      } }),
    settings: async () => ({}), updateSettings: async () => ({ restartRequired: [] }),
    personas: () => testPersonas,
    personaSummaries: () => testPersonas.map((persona) => personaSummary(persona)),
    personaAudit: () => testAudit,
    persona: (id) => testPersonas.find((persona) => persona.id === id),
    createPersona: async (persona) => persona,
    createBlankPersona: async () => testPersona,
    createPersonaTemplate: async () => alternatePersona,
    duplicatePersona: async () => alternatePersona,
    updatePersona: async (persona) => persona,
    previewPersonaRegeneration: async () => ({
      personaId: testPersona.id, username: 'karlbekner', current: testPersona, proposed: testPersona,
      previewHash: 'a'.repeat(64), preservedManualOverrides: [], legacyManualReviewRequired: false,
    }),
    previewAllPersonaRegenerations: async () => [{
      personaId: testPersona.id, username: 'karlbekner', current: testPersona, proposed: testPersona,
      previewHash: 'a'.repeat(64), preservedManualOverrides: [], legacyManualReviewRequired: false,
    }],
    regeneratePersona: async () => testPersona,
    regenerateAllPersonas: async () => [testPersona],
    deletePersona: async () => true,
    personaMemories: async () => [],
    deletePersonaMemory: async () => false,
    previewPersonaContext: async () => { throw new Error('not used'); },
    streamerMemories: async (input) => streamerMemories.filter((memory) =>
      (!input.type || memory.type === input.type)
      && (!input.status || memory.status === input.status)
      && (!input.search || memory.summary.toLowerCase().includes(input.search.toLowerCase()))),
    streamerMemoryStats: async () => ({
      channel: 'channel', total: streamerMemories.length,
      active: streamerMemories.filter((memory) => memory.status === 'active').length,
      resolved: streamerMemories.filter((memory) => memory.status === 'resolved').length,
      superseded: streamerMemories.filter((memory) => memory.status === 'superseded').length,
      expired: streamerMemories.filter((memory) => memory.status === 'expired').length,
      duplicateMerges: 0, averageImportance: 0.82, averageConfidence: 0.96,
    }),
    updateStreamerMemory: async (input) => {
      const index = streamerMemories.findIndex((memory) => memory.id === input.id);
      if (index < 0) return undefined;
      const updated = { ...streamerMemories[index]!, ...input, updatedAt: 2_000 } as StreamerMemory;
      streamerMemories[index] = updated;
      return updated;
    },
    deleteStreamerMemory: async (id) => {
      const before = streamerMemories.length;
      streamerMemories = streamerMemories.filter((memory) => memory.id !== id);
      return streamerMemories.length < before;
    },
    previewStreamerMemoryContext: async () => streamerMemories,
    twitchOAuth,
    ...extraDependencies,
  });
  servers.push(api);
  return api;
}

afterEach(async () => { await Promise.all(servers.map((api) => api.stop())); servers = []; });

describe('dashboard API', () => {
  it('exposes a secret-free public health payload', async () => {
    const response = await request(server().app).get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok', twitch: true, streamBrain: true, gemini: true, database: true });
    expect(JSON.stringify(response.body)).not.toContain(token);
  });

  it('protects dashboard endpoints', async () => {
    await request(server().app).get('/api/bots').expect(401);
  });

  it('exchanges the dashboard token for a persistent HttpOnly session cookie', async () => {
    const api = server();
    const login = await request(api.app).post('/api/auth/login').send({ token }).expect(200);
    const setCookie = login.headers['set-cookie']?.[0];
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).not.toContain(token);
    const cookie = setCookie?.split(';')[0];
    expect(cookie).toBeTruthy();
    await request(api.app).get('/api/bots').set('Cookie', cookie!).expect(200);
    await request(api.app).post('/api/auth/logout').set('Cookie', cookie!).expect(200);
  });

  it('returns bot status and normalized stream events when authorized', async () => {
    const api = server();
    const bots = await request(api.app).get('/api/bots').set('Authorization', `Bearer ${token}`).expect(200);
    const events = await request(api.app).get('/api/events').set('Authorization', `Bearer ${token}`).expect(200);
    const traces = await request(api.app).get('/api/reaction-traces').set('Authorization', `Bearer ${token}`).expect(200);
    expect(bots.body[0]).toMatchObject({ username: 'bot', connectionState: 'CONNECTED', chatConnected: true });
    expect(events.body[0]).toMatchObject({ id: event.id, summary: event.summary });
    expect(traces.body).toEqual([]);
  });

  it('protects, edits and previews global streamer memories', async () => {
    const api = server();
    await request(api.app).get('/api/streamer-memories').expect(401);
    const memories = await request(api.app).get('/api/streamer-memories?type=plan').set('Authorization', `Bearer ${token}`).expect(200);
    expect(memories.body).toEqual([expect.objectContaining({ id: streamerMemory.id, type: 'plan' })]);
    const preview = await request(api.app)
      .post('/api/streamer-memories/context-preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ query: 'Таиланд' })
      .expect(200);
    expect(preview.body[0]).toMatchObject({ id: streamerMemory.id });
    const updated = await request(api.app)
      .patch(`/api/streamer-memories/${streamerMemory.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'resolved' })
      .expect(200);
    expect(updated.body).toMatchObject({ id: streamerMemory.id, status: 'resolved' });
    await request(api.app)
      .delete(`/api/streamer-memories/${streamerMemory.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
  });

  it('exposes deep persona CRUD and blocks deletion while assigned', async () => {
    const api = server();
    const persona = await request(api.app).get(`/api/personas/${testPersona.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(persona.body).toMatchObject({ schemaVersion: 2, generationVersion: 3, fictionalPersona: true, id: testPersona.id });
    expect(persona.body.identity).toHaveProperty('birthDate');
    const summaries = await request(api.app).get('/api/persona-summaries').set('Authorization', `Bearer ${token}`).expect(200);
    expect(summaries.body[0]).toMatchObject({ completeness: expect.any(Number), uniqueness: 100, consistency: 100 });
    const audit = await request(api.app).get('/api/persona-audit').set('Authorization', `Bearer ${token}`).expect(200);
    expect(audit.body).toMatchObject({
      personaCount: 2,
      uniquePersonaCount: 2,
      genderDistribution: {
        male: 2,
        female: 0,
        malePercentage: 100,
        femalePercentage: 0,
        femaleUsernames: [],
      },
      identityChanges: expect.arrayContaining([
        expect.objectContaining({ username: '404notf0und404', status: 'missing' }),
      ]),
    });
    const preview = await request(api.app)
      .post(`/api/personas/${testPersona.id}/regeneration-preview`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(preview.body).toMatchObject({ username: 'karlbekner', previewHash: 'a'.repeat(64) });
    await request(api.app)
      .post('/api/personas')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'template', username: 'new-bot' })
      .expect(201);
    await request(api.app)
      .post('/api/personas')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'manual', id: 'manual-persona', name: 'Новая личность' })
      .expect(201);
    await request(api.app)
      .patch('/api/bots/bot')
      .set('Authorization', `Bearer ${token}`)
      .send({ personaId: alternatePersona.id })
      .expect(200);
    const deletion = await request(api.app)
      .delete(`/api/personas/${testPersona.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect(deletion.body.error).toContain('назначена');
  });

  it('starts OAuth behind dashboard auth and completes the public Twitch callback without exposing tokens', async () => {
    const completed: Array<{ code: string; state: string; browserState: string }> = [];
    const abandoned: Array<{ state: string; browserState: string }> = [];
    const api = server({
      status: async () => ({ configured: true, callbackUrl: 'https://backend.example/api/twitch/oauth/callback', accounts: [] }),
      startAuthorization: async () => 'http://backend.test/api/twitch/oauth/launch?ticket=one-time-ticket',
      launchAuthorization: async () => ({
        authorizationUrl: 'https://id.twitch.tv/oauth2/authorize?state=browser-bound-state',
        browserState: 'browser-bound-state',
      }),
      abandonAuthorization: async (state, browserState) => { abandoned.push({ state, browserState }); },
      completeAuthorization: async (code, state, browserState) => {
        completed.push({ code, state, browserState });
        return { username: 'refreshable_bot' };
      },
    });

    await request(api.app).post('/api/twitch/oauth/start').expect(401);
    const started = await request(api.app)
      .post('/api/twitch/oauth/start')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(started.body).toEqual({ authorizationUrl: 'http://backend.test/api/twitch/oauth/launch?ticket=one-time-ticket' });

    const launched = await request(api.app)
      .get('/api/twitch/oauth/launch?ticket=one-time-ticket')
      .expect(302);
    expect(launched.headers.location).toBe('https://id.twitch.tv/oauth2/authorize?state=browser-bound-state');
    const oauthCookie = launched.headers['set-cookie']?.[0]?.split(';')[0];
    expect(oauthCookie).toContain('twitchai_oauth_state=browser-bound-state');

    const callback = await request(api.app)
      .get('/api/twitch/oauth/callback?code=one-time-code&state=browser-bound-state')
      .set('Cookie', oauthCookie!)
      .expect(302);
    expect(callback.headers.location).toBe('http://localhost:5173/?twitchOAuth=success&username=refreshable_bot');
    expect(completed).toEqual([{ code: 'one-time-code', state: 'browser-bound-state', browserState: 'browser-bound-state' }]);
    expect(callback.text).not.toContain('access_token');

    const denied = await request(api.app)
      .get('/api/twitch/oauth/callback?error=access_denied&state=browser-bound-state')
      .set('Cookie', oauthCookie!)
      .expect(302);
    const deniedRedirect = new URL(denied.headers.location);
    expect(deniedRedirect.origin + deniedRedirect.pathname).toBe('http://localhost:5173/');
    expect(Object.fromEntries(deniedRedirect.searchParams)).toEqual({
      twitchOAuth: 'error',
      reason: 'access_denied',
    });
    expect(abandoned).toEqual([{ state: 'browser-bound-state', browserState: 'browser-bound-state' }]);
  });
});

describe('motive analytics and rejected reactions', () => {
  it('answers 503 when neither dependency is wired, instead of pretending an empty result', async () => {
    const app = server().app;
    await request(app).get('/api/motive-analytics').set('Authorization', `Bearer ${token}`).expect(503);
    await request(app).get('/api/rejected-reactions').set('Authorization', `Bearer ${token}`).expect(503);
  });

  it('serves the verdict x motive join when wired', async () => {
    const app = server(undefined, {
      motiveAnalytics: async () => ({
        totalSent: 3, totalJudged: 2,
        bySourceType: [{ sourceType: 'curiosity', sent: 2, judged: 2, approved: 2, approvalRate: 1 }],
        personalSourceApprovalRate: 1, genericEventOnlyApprovalRate: null,
      }),
    }).app;
    const response = await request(app).get('/api/motive-analytics').set('Authorization', `Bearer ${token}`).expect(200);
    expect(response.body.personalSourceApprovalRate).toBe(1);
    expect(response.body.bySourceType).toHaveLength(1);
  });

  it('lists rejected reactions and lets the operator mark a false positive', async () => {
    const records = [{
      id: 'rej-1', at: 1_000, eventId: 'event-1', username: 'bot',
      message: 'ну и моменты пошли', reason: 'generic_evaluator',
    }];
    let marked: { id: string; falsePositive: boolean } | undefined;
    const app = server(undefined, {
      rejectedReactions: () => records,
      markRejectedReactionFalsePositive: (id: string, falsePositive: boolean) => {
        if (id !== 'rej-1') return false;
        marked = { id, falsePositive };
        return true;
      },
    }).app;
    const list = await request(app).get('/api/rejected-reactions').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body).toEqual(records);
    await request(app).post('/api/rejected-reactions/rej-1/false-positive')
      .set('Authorization', `Bearer ${token}`).send({ falsePositive: true }).expect(204);
    expect(marked).toEqual({ id: 'rej-1', falsePositive: true });
    await request(app).post('/api/rejected-reactions/rej-missing/false-positive')
      .set('Authorization', `Bearer ${token}`).send({}).expect(404);
  });
});

describe('message verdicts carry the reaction id', () => {
  it('passes reactionId through to the verdict sink, and still accepts a client that sends none', async () => {
    const received: Array<Record<string, unknown>> = [];
    const app = server(undefined, { rateMessage: async (verdict) => { received.push({ ...verdict }); } }).app;
    await request(app).post('/api/message-verdicts').set('Authorization', `Bearer ${token}`)
      .send({ username: 'bot', message: 'ахахах', verdict: 'good', reactionId: 'reaction-1' }).expect(204);
    await request(app).post('/api/message-verdicts').set('Authorization', `Bearer ${token}`)
      .send({ username: 'bot', message: 'ахахах', verdict: 'bad' }).expect(204);
    expect(received[0]).toMatchObject({ username: 'bot', verdict: 'good', reactionId: 'reaction-1' });
    expect(received[1]).not.toHaveProperty('reactionId');
  });

  it('exposes the link-quality fields the dashboard reads', async () => {
    const app = server(undefined, {
      motiveAnalytics: async () => ({
        totalSent: 2, totalJudged: 1,
        bySourceType: [],
        personalSourceApprovalRate: 1, genericEventOnlyApprovalRate: null,
        includingLegacy: { personalSourceApprovalRate: 1, genericEventOnlyApprovalRate: 0, totalJudged: 2 },
        linkQuality: { exactIdMatches: 1, legacyFallbackMatches: 1, legacyAmbiguous: 0, unmatchedVerdicts: 0, lostIdVerdicts: 0 },
      }),
    }).app;
    const response = await request(app).get('/api/motive-analytics').set('Authorization', `Bearer ${token}`).expect(200);
    expect(response.body.linkQuality.exactIdMatches).toBe(1);
    expect(response.body.includingLegacy.totalJudged).toBe(2);
  });
});
