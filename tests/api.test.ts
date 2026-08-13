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

function server(): ApiServer {
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
      geminiReconnects: 0, geminiInputTokens: 0, geminiOutputTokens: 0, generatedResponses: 0, skippedResponses: 0 }),
    settings: async () => ({}), updateSettings: async () => ({ restartRequired: [] }),
    personas: () => DEFAULT_PERSONAS, updatePersona: async () => undefined,
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

  it('returns bot status and normalized stream events when authorized', async () => {
    const api = server();
    const bots = await request(api.app).get('/api/bots').set('Authorization', `Bearer ${token}`).expect(200);
    const events = await request(api.app).get('/api/events').set('Authorization', `Bearer ${token}`).expect(200);
    expect(bots.body[0]).toMatchObject({ username: 'bot', connectionState: 'CONNECTED', chatConnected: true });
    expect(events.body[0]).toMatchObject({ id: event.id, summary: event.summary });
  });
});
