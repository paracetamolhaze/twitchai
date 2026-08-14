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

describe('Gemini Live two-tool protocol', () => {
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
  });

  it('handles every tool call in a server message and correlates synchronous responses by id', async () => {
    const sent: LiveSendToolResponseParameters[] = [];
    const order: string[] = [];
    const transcripts: string[] = [];
    let onMessage: ((message: LiveServerMessage) => void) | undefined;
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
        onMessage = parameters.callbacks?.onmessage;
        return session;
      },
      handlers: {
        onPrepareReactionContext: async () => { order.push('prepare'); return { eventId: 'event-1', candidates: [] }; },
        onEmitReactionBatch: async () => { order.push('emit'); return { accepted: [], rejected: [] }; },
        onTranscript: (text) => transcripts.push(text),
      },
    });
    await client.start();
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
        { id: 'prepare-1', name: 'prepare_reaction_context', args: { type: 'funny', summary: 'момент', importance: .8, confidence: .9 } },
        { id: 'emit-1', name: 'emit_reaction_batch', args: { eventId: 'event-1', reactions: [] } },
      ] },
    } as LiveServerMessage);

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(order).toEqual(['prepare', 'emit']);
    expect(transcripts).toEqual(['одновременная расшифровка']);
    expect(sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.any(Object) }));
    expect(sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({ video: expect.any(Object) }));
    expect(sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Channel: streamer') }));
    expect(sendRealtimeInput).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('TRUSTED REACTION SIGNAL') }));
    expect(sent.map((item) => {
      const responses = Array.isArray(item.functionResponses) ? item.functionResponses : [item.functionResponses];
      return responses[0]?.id;
    })).toEqual(['prepare-1', 'emit-1']);
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
        onPrepareReactionContext: async () => ({}),
        onEmitReactionBatch: async () => ({}),
        onStatus: (connected) => statuses.push(connected),
      },
    });
    await client.start();
    parameters?.callbacks?.onclose?.({ code: 1006 } as never);
    expect(client.isConnected()).toBe(false);
    await vi.runOnlyPendingTimersAsync();
    expect(connectCount).toBe(2);
    expect(statuses).toEqual(expect.arrayContaining([false, true]));
    expect(client.isConnected()).toBe(true);
    client.stop();
  });
});
