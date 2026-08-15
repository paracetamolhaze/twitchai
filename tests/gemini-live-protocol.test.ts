import {
  LiveConnectParameters,
  LiveSendToolResponseParameters,
  LiveServerMessage,
  Session,
} from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger';
import { EMIT_STREAM_EVENT_TOOL, GeminiLiveClient, STREAM_BRAIN_INSTRUCTION } from '../src/stream-brain/gemini-live.client';
import { UsageTracker } from '../src/usage/usage-tracker';

afterEach(() => vi.useRealTimers());

describe('Gemini Live perception protocol', () => {
  it('explicitly limits Live to multimodal perception and natural periods with zero events', () => {
    expect(STREAM_BRAIN_INSTRUCTION).toContain('perception only');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('Long periods with zero calls');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('Visual-only events are valid');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('Never decide who should answer');
    for (const prohibited of ['prepare_reaction_context', 'emit_reaction_batch', 'record_stream_memories', 'persona memory']) {
      expect(STREAM_BRAIN_INSTRUCTION).not.toContain(prohibited);
    }
  });

  it('handles every event tool call, preserves ids, transcript, media, and minimal context', async () => {
    const sent: LiveSendToolResponseParameters[] = [];
    const observed: string[] = [];
    const transcripts: string[] = [];
    let parameters: LiveConnectParameters | undefined;
    const sendRealtimeInput = vi.fn();
    const session = {
      sendRealtimeInput,
      sendToolResponse: (response: LiveSendToolResponseParameters) => sent.push(response),
      close: vi.fn(),
    } as unknown as Session;
    const client = createClient({
      connect: async (value) => { parameters = value; return session; },
      onStreamEvent: async (event) => { observed.push(event.summary); return { accepted: true }; },
      onTranscript: (text) => transcripts.push(text),
    });
    await client.start();
    parameters?.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
    client.updateContext({
      channel: 'streamer', category: 'Dota 2', streamContext: 'рейтинг', isLive: true,
      recentChat: [], recentEvents: [], botUsernames: ['bot-one'], updatedAt: Date.now(),
    });
    client.sendAudio(Buffer.from([1, 2]));
    client.sendVideo(Buffer.from([3, 4]));
    parameters?.callbacks?.onmessage?.({
      serverContent: { inputTranscription: { text: 'всем привет' } },
      toolCall: { functionCalls: [
        { id: 'event-1', name: EMIT_STREAM_EVENT_TOOL, args: { type: 'greeting', summary: 'Стример поздоровался.', importance: .8, confidence: .99 } },
        { id: 'event-2', name: EMIT_STREAM_EVENT_TOOL, args: { type: 'visual', summary: 'Друг упал со стула.', importance: .9, confidence: .95 } },
      ] },
    } as LiveServerMessage);

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(observed).toEqual(['Стример поздоровался.', 'Друг упал со стула.']);
    expect(transcripts).toEqual(['всем привет']);
    expect(sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Channel: streamer') }));
    expect(sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.any(Object) }));
    expect(sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({ video: expect.any(Object) }));
    const responses = Array.isArray(sent[0]?.functionResponses) ? sent[0].functionResponses : [sent[0]?.functionResponses];
    expect(responses.map((response) => response?.id)).toEqual(['event-1', 'event-2']);
    client.stop();
  });

  it('reaches READY when the SDK delivers setupComplete before connect() resolves', async () => {
    // @google/genai's real Live.connect() queues incoming messages until its own internal
    // setupComplete promise settles, then flushes them to callbacks.onmessage() BEFORE the
    // connect() promise itself resolves (dist/node/index.mjs, class Live#connect). That means
    // handleMessage() can run while GeminiLiveClient's state is still CONNECTING, not the
    // SETUP_PENDING the naive mocks below assume. This test reproduces that exact ordering.
    let parameters: LiveConnectParameters | undefined;
    const session = { sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn() } as unknown as Session;
    const client = createClient({
      connect: async (value) => {
        parameters = value;
        value.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
        return session;
      },
    });
    await client.start();
    expect(parameters).toBeDefined();
    expect(client.isConnected()).toBe(true);
    expect(client.getDiagnostics()).toMatchObject({ state: 'CONNECTED', stable: false, sessionActive: true });
    client.stop();
  });

  it('returns an event error without dropping a healthy Live session', async () => {
    const sent: LiveSendToolResponseParameters[] = [];
    let parameters: LiveConnectParameters | undefined;
    const session = {
      sendRealtimeInput: vi.fn(),
      sendToolResponse: (response: LiveSendToolResponseParameters) => sent.push(response),
      close: vi.fn(),
    } as unknown as Session;
    const client = createClient({
      connect: async (value) => { parameters = value; return session; },
      onStreamEvent: async () => { throw new Error('invalid event'); },
    });
    await client.start();
    parameters?.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
    parameters?.callbacks?.onmessage?.({ toolCall: { functionCalls: [{
      id: 'bad-event', name: EMIT_STREAM_EVENT_TOOL, args: {},
    }] } } as LiveServerMessage);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const responses = Array.isArray(sent[0]?.functionResponses) ? sent[0].functionResponses : [sent[0]?.functionResponses];
    expect(responses[0]).toMatchObject({ id: 'bad-event', response: { error: 'invalid_event' } });
    expect(client.isConnected()).toBe(true);
    client.stop();
  });

  it('reports a disconnect and reconnects the same Live client', async () => {
    vi.useFakeTimers();
    const connections: LiveConnectParameters[] = [];
    const session = { sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn() } as unknown as Session;
    const client = createClient({
      connect: async (parameters) => { connections.push(parameters); return session; },
      reconnectMinimumMs: 1, reconnectMaximumMs: 1,
    });
    await client.start();
    connections[0]?.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
    connections[0]?.callbacks?.onclose?.({ code: 1006, reason: 'network lost' } as never);
    await vi.runOnlyPendingTimersAsync();
    expect(connections).toHaveLength(2);
    connections[1]?.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
    expect(client.isConnected()).toBe(true);
    client.stop();
  });

  it('pauses realtime media while the event tool is being persisted', async () => {
    let parameters: LiveConnectParameters | undefined;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sendRealtimeInput = vi.fn();
    const sendToolResponse = vi.fn();
    const session = { sendRealtimeInput, sendToolResponse, close: vi.fn() } as unknown as Session;
    const handler = vi.fn(async () => { await gate; return { accepted: true }; });
    const client = createClient({
      connect: async (value) => { parameters = value; return session; },
      onStreamEvent: handler,
    });
    await client.start();
    parameters?.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
    sendRealtimeInput.mockClear();
    parameters?.callbacks?.onmessage?.({ toolCall: { functionCalls: [{
      id: 'event-1', name: EMIT_STREAM_EVENT_TOOL,
      args: { type: 'visual', summary: 'момент', importance: .8, confidence: .9 },
    }] } } as LiveServerMessage);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    client.sendAudio(Buffer.from([1, 2]));
    expect(sendRealtimeInput).not.toHaveBeenCalled();
    release?.();
    await vi.waitFor(() => expect(sendToolResponse).toHaveBeenCalledTimes(1));
    client.sendAudio(Buffer.from([3, 4]));
    expect(sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.any(Object) }));
    client.stop();
  });

  it('declares exactly one tool with supported Live JSON Schema keywords', async () => {
    let parameters: LiveConnectParameters | undefined;
    const session = { sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn() } as unknown as Session;
    const client = createClient({ connect: async (value) => { parameters = value; return session; } });
    await client.start();
    const declarations = JSON.stringify(parameters?.config?.tools);
    expect(declarations).toContain(`"name":"${EMIT_STREAM_EVENT_TOOL}"`);
    expect(declarations.match(/"name":/g)).toHaveLength(1);
    expect(declarations).not.toContain('"minLength"');
    expect(declarations).not.toContain('"maxLength"');
    expect(declarations).toContain('"direct_mention"');
    expect(declarations).toContain('"visual"');
    client.stop();
  });

  it('preserves close reason and opens the circuit after three 1007 protocol errors', async () => {
    vi.useFakeTimers();
    const connections: LiveConnectParameters[] = [];
    const session = { sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn() } as unknown as Session;
    const client = createClient({
      connect: async (parameters) => { connections.push(parameters); return session; },
      reconnectMinimumMs: 1, reconnectMaximumMs: 1,
    });
    await client.start();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parameters = connections[attempt]!;
      parameters.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
      parameters.callbacks?.onclose?.({ code: 1007, reason: 'Request contains an invalid argument', wasClean: true } as never);
      if (attempt < 2) await vi.advanceTimersByTimeAsync(1);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connections).toHaveLength(3);
    expect(client.getDiagnostics()).toMatchObject({ state: 'FATAL_CONFIG_ERROR', lastCloseCode: 1007 });
    expect(client.getDiagnostics().lastCloseReason).toContain('invalid argument');
    client.stop();
  });

  it('cancels a pending reconnect when the stream stops', async () => {
    vi.useFakeTimers();
    const connections: LiveConnectParameters[] = [];
    const usage = new UsageTracker();
    const session = { sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn() } as unknown as Session;
    const client = createClient({
      connect: async (parameters) => { connections.push(parameters); return session; },
      reconnectMinimumMs: 10, reconnectMaximumMs: 10,
      usage,
    });
    await client.start();
    connections[0]?.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
    connections[0]?.callbacks?.onclose?.({ code: 1006, reason: 'network lost' } as never);
    client.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connections).toHaveLength(1);
    expect(usage.snapshot().geminiReconnects).toBe(0);
  });

  it('never sends an uncorrelated tool response when Gemini omits a call id', async () => {
    let parameters: LiveConnectParameters | undefined;
    const session = { sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn() } as unknown as Session;
    const client = createClient({ connect: async (value) => { parameters = value; return session; } });
    await client.start();
    parameters?.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
    parameters?.callbacks?.onmessage?.({ toolCall: { functionCalls: [{
      name: EMIT_STREAM_EVENT_TOOL, args: {},
    }] } } as LiveServerMessage);
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));
    expect(session.sendToolResponse).not.toHaveBeenCalled();
    expect(client.getDiagnostics()).toMatchObject({ state: 'ERROR', lastCloseCode: 1007 });
    client.stop();
  });
});

interface ClientOverrides {
  connect?: (parameters: LiveConnectParameters) => Promise<Session>;
  onStreamEvent?: (event: { summary: string }) => Promise<unknown>;
  onTranscript?: (text: string) => void;
  reconnectMinimumMs?: number;
  reconnectMaximumMs?: number;
  usage?: UsageTracker;
}

function createClient(overrides: ClientOverrides): GeminiLiveClient {
  return new GeminiLiveClient({
    apiKey: 'test-key',
    model: 'gemini-3.1-flash-live-preview',
    logger: new Logger('TEST', 'error'),
    usage: overrides.usage ?? new UsageTracker(),
    ...(overrides.connect ? { connect: overrides.connect } : {}),
    ...(overrides.reconnectMinimumMs !== undefined ? { reconnectMinimumMs: overrides.reconnectMinimumMs } : {}),
    ...(overrides.reconnectMaximumMs !== undefined ? { reconnectMaximumMs: overrides.reconnectMaximumMs } : {}),
    handlers: {
      onStreamEvent: (event) => overrides.onStreamEvent?.(event) ?? Promise.resolve({ accepted: true }),
      ...(overrides.onTranscript ? { onTranscript: overrides.onTranscript } : {}),
    },
  });
}
