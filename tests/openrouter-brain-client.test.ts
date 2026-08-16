import { describe, expect, it, vi } from 'vitest';
import { BrainInteractionRequest } from '../src/brain/gemini-brain.service';
import { OpenRouterBrainClient } from '../src/brain/openrouter-brain.client';
import { Logger } from '../src/logger';

interface CapturedBody {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  response_format: { type: string; json_schema: { strict: boolean; schema: Record<string, unknown> } };
  reasoning: { effort: string };
  provider: { require_parameters: boolean };
}

function client(reply: (body: CapturedBody, call: number) => unknown) {
  const sent: CapturedBody[] = [];
  let call = 0;
  const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as CapturedBody;
    sent.push(body);
    call += 1;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => reply(body, call),
    } as unknown as Response;
  });
  const instance = new OpenRouterBrainClient({
    apiKey: 'test-key',
    logger: new Logger('TEST', 'error'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { instance, sent, fetchImpl };
}

const bootstrap: BrainInteractionRequest = {
  kind: 'bootstrap',
  model: 'google/gemini-3.7-flash',
  input: '{"personas":[]}',
  systemInstruction: 'You are the decision brain.',
  responseSchema: { type: 'object' },
  thinkingLevel: 'low',
  maxOutputTokens: 512,
  store: true,
};

function completion(id: string, content: string, usage: Record<string, unknown> = {}) {
  return {
    id,
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, ...usage },
  };
}

describe('OpenRouterBrainClient', () => {
  it('continues the exact conversation an id refers to, the way the stateful API did', async () => {
    // Everything above this client passes an opaque id around and never sees a message array.
    // Chat Completions has no server-side conversation, so the id has to mean the same thing here.
    const { instance, sent } = client((_body, call) => completion(`turn-${call}`, '{"ready":true}'));
    const first = await instance.create(bootstrap);
    const second = await instance.create({
      ...bootstrap, kind: 'decision', input: '{"event":"first"}', previousInteractionId: first.id,
    });
    await instance.create({
      ...bootstrap, kind: 'decision', input: '{"event":"second"}', previousInteractionId: second.id,
    });

    expect(sent[2]?.messages.map((message) => message.role)).toEqual([
      'system', 'user', 'assistant', 'user', 'assistant', 'user',
    ]);
    const lastUser = sent[2]?.messages.at(-1);
    expect(lastUser?.content).toBe('{"event":"second"}');
  });

  it('branches from the id it was given rather than from the newest turn', async () => {
    // After a rollover or a repaired chain the service deliberately continues from an older
    // interaction. Appending to whatever happened last instead would silently rewrite history.
    const { instance, sent } = client((_body, call) => completion(`turn-${call}`, '{"ready":true}'));
    const root = await instance.create(bootstrap);
    await instance.create({ ...bootstrap, kind: 'decision', input: '{"event":"a"}', previousInteractionId: root.id });
    await instance.create({ ...bootstrap, kind: 'decision', input: '{"event":"b"}', previousInteractionId: root.id });

    // The opening turn and its answer, then the new event — and no trace of the branch not taken.
    expect(sent[2]?.messages).toHaveLength(4);
    expect(sent[2]?.messages.at(-1)?.content).toBe('{"event":"b"}');
    expect(JSON.stringify(sent[2]?.messages)).not.toContain('{"event":"a"}');
  });

  it('marks the opening turn for caching, which is what makes per-event decisions affordable', async () => {
    const { instance, sent } = client(() => completion('turn-1', '{"ready":true}'));
    await instance.create(bootstrap);
    const opening = sent[0]?.messages[1]?.content as Array<{ cache_control?: { type: string } }>;
    expect(opening[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('asks for a strictly enforced schema and refuses endpoints that would ignore it', async () => {
    // A decision that does not parse is a decision lost after it was already paid for.
    const { instance, sent } = client(() => completion('turn-1', '{"ready":true}'));
    await instance.create(bootstrap);
    expect(sent[0]?.response_format.type).toBe('json_schema');
    expect(sent[0]?.response_format.json_schema.strict).toBe(true);
    expect(sent[0]?.provider.require_parameters).toBe(true);
    expect(sent[0]?.reasoning.effort).toBe('low');
  });

  it('reports reasoning tokens separately, so thinking is never counted as written output', async () => {
    const { instance } = client(() => completion('turn-1', '{"ready":true}', {
      prompt_tokens: 8_000,
      completion_tokens: 500,
      prompt_tokens_details: { cached_tokens: 6_000 },
      completion_tokens_details: { reasoning_tokens: 380 },
    }));
    const response = await instance.create(bootstrap);
    expect(response.usage).toMatchObject({
      inputTokens: 8_000, cachedInputTokens: 6_000, outputTokens: 120, thoughtTokens: 380,
    });
  });

  it('calls a truncated answer incomplete instead of handing back unparseable JSON', async () => {
    const { instance } = client(() => ({
      id: 'turn-1',
      choices: [{ finish_reason: 'length', message: { content: '{"reactions":[{"user' } }],
      usage: { prompt_tokens: 10, completion_tokens: 512 },
    }));
    const response = await instance.create(bootstrap);
    expect(response.status).toBe('incomplete');
  });

  it('surfaces an API error in the shape the service already classifies', async () => {
    // The service tells an empty balance, a rate limit and a refused prompt apart by reading the
    // message, and each one has different handling. A generic failure would lose all three.
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({ error: { message: 'Insufficient credits' } }),
    } as unknown as Response));
    const instance = new OpenRouterBrainClient({
      apiKey: 'test-key',
      logger: new Logger('TEST', 'error'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(instance.create(bootstrap)).rejects.toThrow(/429 Insufficient credits/);
  });

  it('repeats what the provider itself said, since the gateway wording is useless alone', async () => {
    // "400 Provider returned error" was all that reached the logs while every decision on a live
    // stream failed, and the reason it hid was one unsupported keyword in a schema.
    const raw = JSON.stringify({
      error: { code: 400, message: "schema at top-level requires unspecified property 'ready'" },
    });
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({
        error: {
          message: 'Provider returned error',
          metadata: { provider_name: 'Google AI Studio', raw },
        },
      }),
    } as unknown as Response));
    const instance = new OpenRouterBrainClient({
      apiKey: 'test-key',
      logger: new Logger('TEST', 'error'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(instance.create(bootstrap)).rejects.toThrow(/Google AI Studio: schema at top-level/);
  });

  it('refuses to answer from a conversation it no longer holds, so the session is rebuilt', async () => {
    const { instance } = client(() => completion('turn-1', '{"ready":true}'));
    await expect(instance.create({
      ...bootstrap, kind: 'decision', previousInteractionId: 'forgotten-turn',
    })).rejects.toThrow(/previous interaction not found/);
  });
});
