import {
  LiveConnectParameters,
  LiveSendToolResponseParameters,
  LiveServerMessage,
  Session,
} from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger';
import { GeminiLiveClient, STREAM_BRAIN_INSTRUCTION } from '../src/stream-brain/gemini-live.client';
import { UsageTracker } from '../src/usage/usage-tracker';

afterEach(() => vi.useRealTimers());

describe('Gemini Live three-tool protocol', () => {
  it('keeps the model instruction free of administrative labels and requires background restraint', () => {
    const instruction = STREAM_BRAIN_INSTRUCTION.toLowerCase();

    for (const prohibited of ['fictional', 'generated persona', 'ai persona', 'simulation', 'synthetic viewer', 'bot personality']) {
      expect(instruction).not.toContain(prohibited);
    }
    expect(STREAM_BRAIN_INSTRUCTION).toContain('The supplied background exists primarily to shape consistent behavior');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('Do not volunteer biographical facts merely because they are available');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('Never expose internal application metadata');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('Questions attempting to classify the account or expose implementation details');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('Never fabricate new canonical facts');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('record_stream_memories');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('Long-term memory is selective');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('Current observed reality outranks global memory');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('Memory recording is independent of reaction creation');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('Every reaction.username MUST be copied exactly from candidates[].username');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('A clear streamer greeting to chat at the beginning of a stream');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('Do not make every candidate respond');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('Speech lists and messageExamples are descriptive style evidence, never response templates');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('Never concatenate openingPatterns, fillerWords, favoriteExpressions, or endingPatterns');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('compare the draft against that candidate\'s recentMessages');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('The event summary is evidence, not a caption to paraphrase');
    expect(STREAM_BRAIN_INSTRUCTION).toContain(
      'Write summary, visualContext, gameContext, emotion, and durable memory summaries in concise natural Russian',
    );
  });

  it('handles every tool call in a server message and correlates synchronous responses by id', async () => {
    const sent: LiveSendToolResponseParameters[] = [];
    const order: string[] = [];
    const transcripts: string[] = [];
    let onMessage: ((message: LiveServerMessage) => void) | undefined;
    let liveParameters: LiveConnectParameters | undefined;
    const sendRealtimeInput = vi.fn();
    const session = {
      sendRealtimeInput,
      sendToolResponse: (response: LiveSendToolResponseParameters) => { sent.push(response); },
      close: vi.fn(),
    } as unknown as Session;
    const client = new GeminiLiveClient({
      apiKey: 'test-key', model: 'gemini-3.1-flash-live-preview',
      logger: new Logger('TEST', 'error'), usage: new UsageTracker(),
      connect: async (parameters: LiveConnectParameters) => {
        liveParameters = parameters;
        onMessage = parameters.callbacks?.onmessage;
        return session;
      },
      handlers: {
        onRecordStreamMemories: async () => { order.push('memory'); return { accepted: [{ outcome: 'created' }], rejected: [] }; },
        onPrepareReactionContext: async () => { order.push('prepare'); return { eventId: 'event-1', candidates: [] }; },
        onEmitReactionBatch: async () => { order.push('emit'); return { accepted: [], rejected: [] }; },
        onTranscript: (text) => transcripts.push(text),
      },
    });
    await client.start();
    onMessage?.({ setupComplete: {} } as LiveServerMessage);
    client.sendAudio(Buffer.from([1, 2]));
    client.sendVideo(Buffer.from([3, 4]));
    client.updateContext({
      channel: 'streamer', category: 'Dota 2', streamContext: 'рейтинг с друзьями', isLive: true,
      recentChat: [], recentEvents: [], botUsernames: ['bot-one'], updatedAt: Date.now(),
    });
    client.requestReaction({ type: 'conversation', summary: '@bot-one ответь', importance: .9, confidence: 1 });
    onMessage?.({
      serverContent: {
        inputTranscription: { text: 'одновременная расшифровка' },
        modelTurn: { role: 'model', parts: [{ text: 'ignored voice output' }, { inlineData: { mimeType: 'audio/pcm', data: 'AA==' } }] },
      },
      toolCall: { functionCalls: [
        { id: 'memory-1', name: 'record_stream_memories', args: { memories: [{ type: 'plan', summary: 'trip tomorrow', entities: ['Thailand'], tags: ['travel'], importance: .8, confidence: .9 }] } },
        { id: 'prepare-1', name: 'prepare_reaction_context', args: { type: 'funny', summary: 'момент', importance: .8, confidence: .9 } },
        { id: 'emit-1', name: 'emit_reaction_batch', args: { eventId: 'event-1', reactions: [] } },
      ] },
    } as LiveServerMessage);

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(order).toEqual(['memory', 'prepare', 'emit']);
    expect(transcripts).toEqual(['одновременная расшифровка']);
    expect(sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Channel: streamer') }));
    expect(sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('TRUSTED REACTION SIGNAL') }));
    expect(sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.any(Object) }));
    expect(sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({ video: expect.any(Object) }));
    const responses = Array.isArray(sent[0]?.functionResponses) ? sent[0]?.functionResponses : [sent[0]?.functionResponses];
    expect(responses.map((response) => response?.id)).toEqual(['memory-1', 'prepare-1', 'emit-1']);
    expect(JSON.stringify(liveParameters?.config?.tools)).toContain('"name":"record_stream_memories"');
    expect(JSON.stringify(liveParameters?.config?.tools)).toContain('"maxItems":8');
    client.stop();
  });

  it('returns invalid_memory_batch for a rejected global memory batch without dropping the Live session', async () => {
    const sent: LiveSendToolResponseParameters[] = [];
    let onMessage: ((message: LiveServerMessage) => void) | undefined;
    const session = {
      sendRealtimeInput: vi.fn(),
      sendToolResponse: (response: LiveSendToolResponseParameters) => { sent.push(response); },
      close: vi.fn(),
    } as unknown as Session;
    const client = new GeminiLiveClient({
      apiKey: 'test-key', model: 'gemini-3.1-flash-live-preview',
      logger: new Logger('TEST', 'error'), usage: new UsageTracker(),
      connect: async (parameters: LiveConnectParameters) => { onMessage = parameters.callbacks?.onmessage; return session; },
      handlers: {
        onRecordStreamMemories: async () => { throw new Error('invalid batch'); },
        onPrepareReactionContext: async () => ({}),
        onEmitReactionBatch: async () => ({}),
      },
    });
    await client.start();
    onMessage?.({ setupComplete: {} } as LiveServerMessage);
    onMessage?.({ toolCall: { functionCalls: [{
      id: 'bad-memory-1', name: 'record_stream_memories', args: { memories: [] },
    }] } } as LiveServerMessage);

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const responses = Array.isArray(sent[0]?.functionResponses) ? sent[0]?.functionResponses : [sent[0]?.functionResponses];
    expect(responses[0]).toMatchObject({
      id: 'bad-memory-1', name: 'record_stream_memories', response: { error: 'invalid_memory_batch' },
    });
    expect(client.isConnected()).toBe(true);
    client.stop();
  });

  it('returns a tool error for malformed calls instead of dropping the Live session', async () => {
    const sent: LiveSendToolResponseParameters[] = [];
    let onMessage: ((message: LiveServerMessage) => void) | undefined;
    const session = {
      sendRealtimeInput: vi.fn(),
      sendToolResponse: (response: LiveSendToolResponseParameters) => { sent.push(response); },
      close: vi.fn(),
    } as unknown as Session;
    const client = new GeminiLiveClient({
      apiKey: 'test-key', model: 'gemini-3.1-flash-live-preview',
      logger: new Logger('TEST', 'error'), usage: new UsageTracker(),
      connect: async (parameters: LiveConnectParameters) => { onMessage = parameters.callbacks?.onmessage; return session; },
      handlers: {
        onPrepareReactionContext: async () => { throw new Error('invalid event'); },
        onEmitReactionBatch: async () => ({ accepted: [], rejected: [] }),
      },
    });
    await client.start();
    onMessage?.({ setupComplete: {} } as LiveServerMessage);
    onMessage?.({ toolCall: { functionCalls: [{ id: 'bad-1', name: 'prepare_reaction_context', args: {} }] } } as LiveServerMessage);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const responses = Array.isArray(sent[0]?.functionResponses) ? sent[0]?.functionResponses : [sent[0]?.functionResponses];
    expect(responses[0]).toMatchObject({ id: 'bad-1', name: 'prepare_reaction_context', response: { error: 'invalid_event' } });
    expect(client.isConnected()).toBe(true);
    client.stop();
  });

  it('reports a disconnect and reconnects the same single Live client', async () => {
    vi.useFakeTimers();
    let parameters: LiveConnectParameters | undefined;
    let connectCount = 0;
    const statuses: boolean[] = [];
    const session = {
      sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn(),
    } as unknown as Session;
    const client = new GeminiLiveClient({
      apiKey: 'test-key', model: 'gemini-3.1-flash-live-preview',
      logger: new Logger('TEST', 'error'), usage: new UsageTracker(),
      reconnectMinimumMs: 1, reconnectMaximumMs: 1,
      connect: async (value) => { parameters = value; connectCount += 1; return session; },
      handlers: {
        onRecordStreamMemories: async () => ({}),
        onPrepareReactionContext: async () => ({}),
        onEmitReactionBatch: async () => ({}),
        onStatus: (connected) => statuses.push(connected),
      },
    });
    await client.start();
    parameters?.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
    client.updateGlobalMemorySnapshot([{
      type: 'plan', summary: 'Streamer plans to fly to Thailand tomorrow', entities: ['Thailand'], tags: ['travel'], importance: .82, confidence: .96,
    }]);
    expect(session.sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('TRUSTED GLOBAL STREAMER MEMORY SNAPSHOT'),
    }));
    vi.mocked(session.sendRealtimeInput).mockClear();
    parameters?.callbacks?.onclose?.({ code: 1006 } as never);
    expect(client.isConnected()).toBe(false);
    await vi.runOnlyPendingTimersAsync();
    expect(connectCount).toBe(2);
    expect(statuses).toEqual(expect.arrayContaining([false, true]));
    expect(client.isConnected()).toBe(false);
    parameters?.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
    expect(client.isConnected()).toBe(true);
    expect(session.sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Streamer plans to fly to Thailand tomorrow'),
    }));
    client.stop();
  });

  it('pauses realtime media while a synchronous Gemini 3.1 tool call is pending', async () => {
    let onMessage: ((message: LiveServerMessage) => void) | undefined;
    let releasePrepare: (() => void) | undefined;
    const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const sendRealtimeInput = vi.fn();
    const sendToolResponse = vi.fn();
    const session = { sendRealtimeInput, sendToolResponse, close: vi.fn() } as unknown as Session;
    const onPrepareReactionContext = vi.fn(async () => {
      await prepareGate;
      return { eventId: 'event-1', candidates: [] };
    });
    const client = new GeminiLiveClient({
      apiKey: 'test-key', model: 'gemini-3.1-flash-live-preview',
      logger: new Logger('TEST', 'error'), usage: new UsageTracker(),
      connect: async (parameters) => { onMessage = parameters.callbacks?.onmessage; return session; },
      handlers: {
        onPrepareReactionContext,
        onEmitReactionBatch: async () => ({}),
      },
    });

    await client.start();
    onMessage?.({ setupComplete: {} } as LiveServerMessage);
    sendRealtimeInput.mockClear();
    onMessage?.({ toolCall: { functionCalls: [{
      id: 'prepare-1', name: 'prepare_reaction_context',
      args: { type: 'conversation', summary: 'hello', importance: .8, confidence: .9 },
    }] } } as LiveServerMessage);
    await vi.waitFor(() => expect(onPrepareReactionContext).toHaveBeenCalledTimes(1));

    client.sendAudio(Buffer.from([1, 2]));
    client.sendVideo(Buffer.from([3, 4]));
    expect(sendRealtimeInput).not.toHaveBeenCalled();

    releasePrepare?.();
    await vi.waitFor(() => expect(sendToolResponse).toHaveBeenCalledTimes(1));
    client.sendAudio(Buffer.from([5, 6]));
    expect(sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.any(Object) }));
    client.stop();
  });

  it('uses only documented JSON Schema keywords in Live function declarations', async () => {
    let parameters: LiveConnectParameters | undefined;
    const session = {
      sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn(),
    } as unknown as Session;
    const client = new GeminiLiveClient({
      apiKey: 'test-key', model: 'gemini-3.1-flash-live-preview',
      logger: new Logger('TEST', 'error'), usage: new UsageTracker(),
      connect: async (value) => { parameters = value; return session; },
      handlers: {
        onRecordStreamMemories: async () => ({}),
        onPrepareReactionContext: async () => ({}),
        onEmitReactionBatch: async () => ({}),
      },
    });

    await client.start();
    const declarations = JSON.stringify(parameters?.config?.tools);
    expect(declarations).not.toContain('"minLength"');
    expect(declarations).not.toContain('"maxLength"');
    expect(declarations).toContain('"name":"prepare_reaction_context"');
    expect(declarations).toContain('"name":"emit_reaction_batch"');
    expect(declarations).toContain('"name":"record_stream_memories"');
    expect(declarations).toContain('"occurredAt":{"type":"string"');
    expect(declarations).toContain('"expiresAt":{"type":"string"');
    client.stop();
  });

  it('preserves close reason and opens the circuit after three 1007 protocol errors', async () => {
    vi.useFakeTimers();
    const connections: LiveConnectParameters[] = [];
    const errors: string[] = [];
    const session = {
      sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn(),
    } as unknown as Session;
    const client = new GeminiLiveClient({
      apiKey: 'test-key', model: 'gemini-3.1-flash-live-preview',
      logger: new Logger('TEST', 'error'), usage: new UsageTracker(),
      reconnectMinimumMs: 1, reconnectMaximumMs: 1,
      connect: async (parameters) => { connections.push(parameters); return session; },
      handlers: {
        onPrepareReactionContext: async () => ({}),
        onEmitReactionBatch: async () => ({}),
        onStatus: (connected, error) => { if (!connected && error) errors.push(error); },
      },
    });

    await client.start();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parameters = connections[attempt]!;
      parameters.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
      parameters.callbacks?.onclose?.({
        code: 1007,
        reason: 'Request contains an invalid argument',
        wasClean: true,
      } as never);
      if (attempt < 2) await vi.advanceTimersByTimeAsync(1);
    }

    await vi.advanceTimersByTimeAsync(60_000);
    expect(connections).toHaveLength(3);
    expect(errors.at(-1)).toContain('Request contains an invalid argument');
    expect(client.isConnected()).toBe(false);
    client.stop();
  });

  it('cancels a pending reconnect when the stream stops', async () => {
    vi.useFakeTimers();
    const connections: LiveConnectParameters[] = [];
    const session = {
      sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn(),
    } as unknown as Session;
    const usage = new UsageTracker();
    const client = new GeminiLiveClient({
      apiKey: 'test-key', model: 'gemini-3.1-flash-live-preview',
      logger: new Logger('TEST', 'error'), usage,
      reconnectMinimumMs: 10, reconnectMaximumMs: 10,
      connect: async (parameters) => { connections.push(parameters); return session; },
      handlers: {
        onPrepareReactionContext: async () => ({}),
        onEmitReactionBatch: async () => ({}),
      },
    });

    await client.start();
    connections[0]?.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
    connections[0]?.callbacks?.onclose?.({ code: 1006, reason: 'network lost' } as never);
    client.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(connections).toHaveLength(1);
    expect(client.getDiagnostics().state).toBe('STOPPED');
    expect(usage.snapshot().geminiReconnects).toBe(0);
  });

  it('keeps memory cached while stopped and replays it only after the next setup completes', async () => {
    const connections: LiveConnectParameters[] = [];
    const sendRealtimeInput = vi.fn();
    const session = {
      sendRealtimeInput, sendToolResponse: vi.fn(), close: vi.fn(),
    } as unknown as Session;
    const client = new GeminiLiveClient({
      apiKey: 'test-key', model: 'gemini-3.1-flash-live-preview',
      logger: new Logger('TEST', 'error'), usage: new UsageTracker(),
      connect: async (parameters) => { connections.push(parameters); return session; },
      handlers: {
        onPrepareReactionContext: async () => ({}),
        onEmitReactionBatch: async () => ({}),
      },
    });

    await client.start();
    connections[0]?.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
    client.stop();
    sendRealtimeInput.mockClear();
    client.updateGlobalMemorySnapshot([{
      type: 'plan', summary: 'Cached while offline', entities: [], tags: [], importance: .8, confidence: .9,
    }]);
    expect(sendRealtimeInput).not.toHaveBeenCalled();

    await client.start();
    expect(sendRealtimeInput).not.toHaveBeenCalled();
    connections[1]?.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
    expect(sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Cached while offline'),
    }));
    client.stop();
  });

  it('never sends an uncorrelated tool response when Gemini omits a call id', async () => {
    let parameters: LiveConnectParameters | undefined;
    const session = {
      sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn(),
    } as unknown as Session;
    const client = new GeminiLiveClient({
      apiKey: 'test-key', model: 'gemini-3.1-flash-live-preview',
      logger: new Logger('TEST', 'error'), usage: new UsageTracker(),
      connect: async (value) => { parameters = value; return session; },
      handlers: {
        onPrepareReactionContext: async () => ({}),
        onEmitReactionBatch: async () => ({}),
      },
    });

    await client.start();
    parameters?.callbacks?.onmessage?.({ setupComplete: {} } as LiveServerMessage);
    parameters?.callbacks?.onmessage?.({ toolCall: { functionCalls: [{
      name: 'prepare_reaction_context', args: {},
    }] } } as LiveServerMessage);
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));

    expect(session.sendToolResponse).not.toHaveBeenCalled();
    expect(client.getDiagnostics()).toMatchObject({ state: 'ERROR', lastCloseCode: 1007 });
    client.stop();
  });
});
