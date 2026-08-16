import {
  LiveConnectParameters,
  LiveSendToolResponseParameters,
  LiveServerMessage,
  Session,
} from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger';
import {
  EMIT_STREAM_EVENT_TOOL,
  GeminiLiveClient,
  STREAM_BRAIN_INSTRUCTION,
} from '../src/stream-brain/gemini-live.client';
import { UsageTracker } from '../src/usage/usage-tracker';

describe('Gemini Live perception-only protocol', () => {
  it('declares only emit_stream_event and contains no reaction, memory, or persona reasoning', async () => {
    let parameters: LiveConnectParameters | undefined;
    const session = {
      sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn(),
    } as unknown as Session;
    const client = new GeminiLiveClient({
      minFramesBeforeEvents: 0,
      apiKey: 'test-key',
      model: 'gemini-3.1-flash-live-preview',
      logger: new Logger('TEST', 'error'),
      usage: new UsageTracker(),
      connect: async (value) => { parameters = value; return session; },
      handlers: { onStreamEvent: async () => ({ accepted: true }) },
    });

    await client.start();

    const setup = JSON.stringify(parameters?.config ?? {});
    const declarations = setup.match(/"name":"[^"]+"/g) ?? [];
    expect(declarations).toEqual([`"name":"${EMIT_STREAM_EVENT_TOOL}"`]);
    for (const forbidden of [
      'prepare_reaction_context', 'emit_reaction_batch', 'record_stream_memories',
      'persona', 'biography', 'memory snapshot', 'reaction.username',
    ]) {
      expect(`${setup}\n${STREAM_BRAIN_INSTRUCTION}`.toLowerCase()).not.toContain(forbidden);
    }
    expect(setup).toContain('direct_mention');
    expect(setup).toContain('greeting');
    expect(setup).toContain('visual');
    expect(STREAM_BRAIN_INSTRUCTION).toContain('perception only');
    client.stop();
  });

  it('forwards one meaningful event and correlates the acknowledgement by tool-call id', async () => {
    const sent: LiveSendToolResponseParameters[] = [];
    const observed: unknown[] = [];
    let onMessage: ((message: LiveServerMessage) => void) | undefined;
    const session = {
      sendRealtimeInput: vi.fn(),
      sendToolResponse: (response: LiveSendToolResponseParameters) => { sent.push(response); },
      close: vi.fn(),
    } as unknown as Session;
    const client = new GeminiLiveClient({
      minFramesBeforeEvents: 0,
      apiKey: 'test-key',
      model: 'gemini-3.1-flash-live-preview',
      logger: new Logger('TEST', 'error'),
      usage: new UsageTracker(),
      connect: async (parameters) => { onMessage = parameters.callbacks?.onmessage; return session; },
      handlers: {
        onStreamEvent: async (event) => { observed.push(event); return { accepted: true, eventId: 'event-1' }; },
      },
    });

    await client.start();
    onMessage?.({ setupComplete: {} } as LiveServerMessage);
    onMessage?.({ toolCall: { functionCalls: [{
      id: 'event-call-1',
      name: EMIT_STREAM_EVENT_TOOL,
      args: {
        type: 'direct_mention',
        summary: 'Стример спросил, здесь ли karlbekner.',
        speech: 'karlbekner ты тут?',
        directMentions: ['karlbekner'],
        importance: 0.95,
        confidence: 0.99,
      },
    }] } } as LiveServerMessage);

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(observed).toEqual([expect.objectContaining({
      type: 'direct_mention', directMentions: ['karlbekner'],
    })]);
    const responses = Array.isArray(sent[0]?.functionResponses)
      ? sent[0]?.functionResponses
      : [sent[0]?.functionResponses];
    expect(responses[0]).toMatchObject({
      id: 'event-call-1', name: EMIT_STREAM_EVENT_TOOL,
      response: { accepted: true, eventId: 'event-1' },
    });
    client.stop();
  });
});
