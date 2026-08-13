import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiServer, ApiServer } from '../src/api/server';
import { Logger } from '../src/logger';
import { DEFAULT_PERSONAS } from '../src/personas/defaults';
import { StreamEvent } from '../src/stream-brain/types';

const token = 'a-secure-test-token';
const event: StreamEvent = {
  id: '4cd428b2-65d8-4359-891f-f020ec39ad2b', timestamp: 1000, type: 'funny', summary: 'unexpected moment',
  importance: 0.8, confidence: 0.9, source: 'gemini-live', directMentions: [],
};
let servers: ApiServer[] = [];

function server(twitchOAuth?: {
  status: () => Promise<{ configured: boolean; callbackUrl: string; accounts: never[] }>;
  startAuthorization: () => Promise<string>;
  launchAuthorization: (ticket: string) => Promise<{ authorizationUrl: string; browserState: string }>;
  abandonAuthorization: (state: string, browserState: string) => Promise<void>;
  completeAuthorization: (code: string, state: string, browserState: string) => Promise<{ username: string }>;
}): ApiServer {
  const api = createApiServer({
    port: 0, frontendUrls: ['http://localhost:5173'], dashboardToken: token, logger: new Logger('TEST', 'error'),
    health: () => ({ status: 'ok', twitch: true, streamBrain: true, gemini: true, database: true }),
    overview: () => ({ channel: 'channel', category: 'Dota 2', isLive: true, twitchConnected: true,
      streamBrain: { state: 'CONNECTED', mediaConnected: true, geminiConnected: true }, activeBots: 1, totalBots: 1, uptimeSeconds: 5 }),
    bots: () => [{ username: 'bot', personaId: 'analyst', enabled: true, connectionState: 'CONNECTED', chatConnected: true, messagesSent: 2 }],
    setBotEnabled: async () => true,
    events: async () => [event],
    chat: () => [],
    usage: () => ({ startedAt: 0, uptimeSeconds: 1, streamMinutes: 0, audioMinutes: 0, videoMinutes: 0,
      geminiReconnects: 0, geminiInputTokens: 0, geminiOutputTokens: 0, geminiToolCalls: 0,
      preparedReactionContexts: 0, reactionBatches: 0, emptyReactionBatches: 0, guardRejections: 0,
      eventsDetected: 0, generatedResponses: 0, sentResponses: 0, skippedResponses: 0 }),
    settings: async () => ({}), updateSettings: async () => ({ restartRequired: [] }),
    personas: () => DEFAULT_PERSONAS, updatePersona: async () => undefined,
    twitchOAuth,
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
    expect(bots.body[0]).toMatchObject({ username: 'bot', connectionState: 'CONNECTED', chatConnected: true });
    expect(events.body[0]).toMatchObject({ id: event.id, summary: event.summary });
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
