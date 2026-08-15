import { describe, expect, it, vi } from 'vitest';
import {
  BrainInteractionClient,
  BrainInteractionRequest,
  GeminiBrainService,
} from '../src/brain/gemini-brain.service';
import { BrainBootstrap, BrainDecision } from '../src/brain/types';
import { Logger } from '../src/logger';
import { StreamEvent } from '../src/stream-brain/types';
import { UsageTracker } from '../src/usage/usage-tracker';

const firstEvent: StreamEvent = {
  id: 'event-1', timestamp: 1_700_000_000_000, type: 'greeting',
  summary: 'Стример поприветствовал чат.', speech: 'всем привет',
  importance: 0.8, confidence: 0.99, source: 'gemini-live', directMentions: [],
};

function bootstrap(): BrainBootstrap {
  return {
    channel: 'streamer',
    category: 'Counter-Strike 2',
    streamContext: 'рейтинговая игра',
    startedAt: firstEvent.timestamp,
    availableBots: Array.from({ length: 30 }, (_, index) => `bot-${index + 1}`),
    personas: Array.from({ length: 30 }, (_, index) => ({
      username: `bot-${index + 1}`,
      preferredName: `Имя ${index + 1}`,
      shortIdentity: `Постоянный зритель ${index + 1}`,
      character: `Характер ${index + 1}`,
      flaws: ['слишком долго терпит неудобные процессы'],
      activityPattern: { chatFrequency: 'low', directReplyLikelihood: 0.8, eventSelectivity: 0.7 },
      speechFingerprint: `Стиль речи ${index + 1}`,
      expertise: ['игры'],
      weakTopics: ['актуальная мета'],
      unknownTopics: ['медицина'],
      avoidedExpressions: ['имба имбовая'],
      opinions: ['компьютеры: надёжная скучная система лучше модной'],
      emotionalTriggers: ['опоздания'],
      interests: ['Counter-Strike 2'],
      relationshipToStreamer: 'знаком со стримером',
      disclosureBoundaries: 'личное не раскрывать без прямого вопроса',
    })),
    globalMemories: [],
    recentMeaningfulEvents: [],
    recentChat: [],
  };
}

describe('Gemini 3.7 stateful Brain', () => {
  it('bootstraps once and chains small event turns through previous_interaction_id', async () => {
    const requests: BrainInteractionRequest[] = [];
    const decisions: Array<{ event: StreamEvent; decision: BrainDecision }> = [];
    const client: BrainInteractionClient = {
      create: vi.fn(async (request) => {
        requests.push(structuredClone(request));
        const sequence = requests.length;
        return {
          id: String.fromCharCode(64 + sequence),
          status: 'completed',
          outputText: request.kind === 'bootstrap'
            ? '{"ready":true}'
            : '{"reactions":[],"memoryUpdates":[]}',
          usage: {
            inputTokens: request.kind === 'bootstrap' ? 4_000 : 180,
            cachedInputTokens: request.kind === 'bootstrap' ? 0 : 3_800,
            outputTokens: 12,
            thoughtTokens: 20,
            totalTokens: request.kind === 'bootstrap' ? 4_032 : 4_012,
          },
        };
      }),
    };
    const service = new GeminiBrainService({
      client,
      model: 'gemini-3.7-flash',
      thinkingLevel: 'low',
      bootstrap: async () => bootstrap(),
      prepareEvent: async (event) => ({
        event,
        availableBots: bootstrap().availableBots,
        recentChatDelta: [],
        targetedPersonaContext: [],
        reactionExamples: [],
        deltas: [],
        constraints: { maxReactions: 3, maxMessageBytes: 500, globalSlotsAvailable: 3, expiresAt: 9e15 },
      }),
      onDecision: async (event, decision) => { decisions.push({ event, decision }); },
      usage: new UsageTracker(),
      logger: new Logger('TEST', 'error'),
      eventMergeWindowMs: 0,
      contextRolloverTokens: 800_000,
    });

    await service.startStream();
    await service.enqueueEvent(firstEvent);
    await service.enqueueEvent({ ...firstEvent, id: 'event-2', timestamp: firstEvent.timestamp + 5_000, summary: 'Стример выиграл раунд.', type: 'win' });

    expect(requests.map((request) => request.kind)).toEqual(['bootstrap', 'decision', 'decision']);
    expect(requests.map((request) => request.previousInteractionId)).toEqual([undefined, 'A', 'B']);
    expect(requests[0]!.maxOutputTokens).toBe(512);
    expect(JSON.parse(requests[0]!.input)).toMatchObject({ personas: expect.arrayContaining([expect.objectContaining({ username: 'bot-1' })]) });
    for (const request of requests.slice(1)) {
      const payload = JSON.parse(request.input) as Record<string, unknown>;
      expect(payload).not.toHaveProperty('personas');
      expect(request.input).not.toContain('shortIdentity');
    }
    expect(decisions).toHaveLength(2);
    expect(service.getStatus()).toMatchObject({
      state: 'READY', interactions: 3, decisions: 2, previousInteractionId: 'C',
    });
  });

  it('serializes simultaneous events so each turn receives the preceding interaction id', async () => {
    const requests: BrainInteractionRequest[] = [];
    let releaseFirstDecision: (() => void) | undefined;
    const firstDecisionGate = new Promise<void>((resolve) => { releaseFirstDecision = resolve; });
    const client: BrainInteractionClient = {
      create: async (request) => {
        requests.push(structuredClone(request));
        if (request.kind === 'decision' && requests.filter((item) => item.kind === 'decision').length === 1) {
          await firstDecisionGate;
        }
        return {
          id: String.fromCharCode(64 + requests.length), status: 'completed',
          outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
          usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5, thoughtTokens: 5, totalTokens: 110 },
        };
      },
    };
    const service = brainService(client);
    await service.startStream();

    const first = service.enqueueEvent(firstEvent);
    const second = service.enqueueEvent({ ...firstEvent, id: 'event-2', timestamp: firstEvent.timestamp + 1 });
    await vi.waitFor(() => expect(requests.filter((request) => request.kind === 'decision')).toHaveLength(1));
    expect(requests).toHaveLength(2);
    releaseFirstDecision?.();
    await Promise.all([first, second]);

    expect(requests.map((request) => request.previousInteractionId)).toEqual([undefined, 'A', 'B']);
  });

  it('rebuilds an invalid interaction chain and then continues processing the event', async () => {
    const requests: BrainInteractionRequest[] = [];
    const bootstrapReasons: string[] = [];
    let rejected = false;
    const client: BrainInteractionClient = {
      create: async (request) => {
        requests.push(structuredClone(request));
        if (request.kind === 'decision' && !rejected) {
          rejected = true;
          throw new Error('400 invalid previous_interaction_id');
        }
        const id = request.kind === 'bootstrap' && requests.length > 1 ? 'B' : request.kind === 'bootstrap' ? 'A' : 'C';
        return {
          id, status: 'completed',
          outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
          usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5, thoughtTokens: 5, totalTokens: 110 },
        };
      },
    };
    const decisions = vi.fn(async () => undefined);
    const service = brainService(client, {
      bootstrap: async (reason) => { bootstrapReasons.push(reason); return bootstrap(); },
      onDecision: decisions,
    });
    await service.startStream();

    await service.enqueueEvent(firstEvent);

    expect(bootstrapReasons).toEqual(['stream_start', 'recovery']);
    expect(requests.map((request) => [request.kind, request.previousInteractionId])).toEqual([
      ['bootstrap', undefined],
      ['decision', 'A'],
      ['bootstrap', undefined],
      ['decision', 'B'],
    ]);
    expect(decisions).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({ state: 'READY', previousInteractionId: 'C', rebuiltSessions: 1 });
  });

  it('merges a short event burst into one semantic decision while direct mentions bypass the window', async () => {
    const requests: BrainInteractionRequest[] = [];
    const client: BrainInteractionClient = {
      create: async (request) => {
        requests.push(structuredClone(request));
        return {
          id: `I${requests.length}`, status: 'completed',
          outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
          usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5, thoughtTokens: 5, totalTokens: 110 },
        };
      },
    };
    const service = brainService(client, { eventMergeWindowMs: 20 });
    await service.startStream();
    const burst = [
      { ...firstEvent, id: 'burst-1', type: 'gameplay' as const, summary: 'Стример промахнулся способностью.' },
      { ...firstEvent, id: 'burst-2', type: 'reaction' as const, summary: 'Стример вскрикнул после промаха.' },
      { ...firstEvent, id: 'burst-3', type: 'loss' as const, summary: 'Противник убил стримера.' },
    ];

    await Promise.all(burst.map((event) => service.enqueueEvent(event)));
    expect(requests.filter((request) => request.kind === 'decision')).toHaveLength(1);
    const merged = JSON.parse(requests.at(-1)!.input) as { event: StreamEvent; mergedEventIds: string[] };
    expect(merged.mergedEventIds).toEqual(['burst-1', 'burst-2', 'burst-3']);
    expect(merged.event.summary).toContain('Противник убил стримера');

    const direct = service.enqueueEvent({
      ...firstEvent, id: 'direct-1', type: 'direct_mention',
      summary: 'Стример обратился к bot-1.', speech: 'bot-1 ты тут?', directMentions: ['bot-1'],
    });
    await vi.waitFor(() => expect(requests.filter((request) => request.kind === 'decision')).toHaveLength(2));
    await direct;
  });

  it('rolls over before the next event when the reported interaction context reaches the configured limit', async () => {
    const requests: BrainInteractionRequest[] = [];
    const reasons: string[] = [];
    const client: BrainInteractionClient = {
      create: async (request) => {
        requests.push(structuredClone(request));
        return {
          id: `R${requests.length}`, status: 'completed',
          outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
          usage: {
            inputTokens: request.kind === 'decision' ? 800 : 100,
            cachedInputTokens: 50, outputTokens: 5, thoughtTokens: 5, totalTokens: 810,
          },
        };
      },
    };
    const service = brainService(client, {
      contextRolloverTokens: 750,
      bootstrap: async (reason) => { reasons.push(reason); return bootstrap(); },
    });
    await service.startStream();
    await service.enqueueEvent(firstEvent);
    await service.enqueueEvent({ ...firstEvent, id: 'after-rollover' });

    expect(reasons).toEqual(['stream_start', 'rollover']);
    expect(requests.map(({ kind, previousInteractionId }) => [kind, previousInteractionId])).toEqual([
      ['bootstrap', undefined], ['decision', 'R1'], ['bootstrap', undefined], ['decision', 'R3'],
    ]);
    expect(service.getStatus().rollovers).toBe(1);
  });

  it('queues an initial event that arrives while the one-time bootstrap is still running', async () => {
    let releaseBootstrap: (() => void) | undefined;
    const bootstrapGate = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
    const requests: BrainInteractionRequest[] = [];
    const client: BrainInteractionClient = {
      create: async (request) => {
        requests.push(structuredClone(request));
        if (request.kind === 'bootstrap') await bootstrapGate;
        return {
          id: request.kind === 'bootstrap' ? 'A' : 'B', status: 'completed',
          outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
          usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5, thoughtTokens: 5, totalTokens: 110 },
        };
      },
    };
    const service = brainService(client);

    const starting = service.startStream();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const initialEvent = service.enqueueEvent(firstEvent);
    expect(requests.filter(({ kind }) => kind === 'decision')).toHaveLength(0);
    releaseBootstrap?.();
    await Promise.all([starting, initialEvent]);

    expect(requests.map(({ kind }) => kind)).toEqual(['bootstrap', 'decision']);
    expect(requests[1]?.previousInteractionId).toBe('A');
  });

  it('starts a fresh Brain session during a rapid offline to live transition', async () => {
    let releaseOldDecision: (() => void) | undefined;
    const oldDecisionGate = new Promise<void>((resolve) => { releaseOldDecision = resolve; });
    const requests: BrainInteractionRequest[] = [];
    let sequence = 0;
    const client: BrainInteractionClient = {
      create: async (request) => {
        requests.push(structuredClone(request));
        const id = `I${++sequence}`;
        if (request.kind === 'decision' && request.previousInteractionId === 'I1') await oldDecisionGate;
        return {
          id, status: 'completed',
          outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
          usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5, thoughtTokens: 5, totalTokens: 110 },
        };
      },
    };
    const service = brainService(client);
    await service.startStream();
    const oldEvent = service.enqueueEvent(firstEvent);
    await vi.waitFor(() => expect(requests.filter(({ kind }) => kind === 'decision')).toHaveLength(1));

    const stopping = service.stopStream();
    const restarting = service.startStream();
    await restarting;
    releaseOldDecision?.();
    await Promise.all([stopping, oldEvent]);

    expect(requests.filter(({ kind }) => kind === 'bootstrap')).toHaveLength(2);
    expect(service.getStatus()).toMatchObject({ state: 'READY', previousInteractionId: 'I3' });
  });

  it('restores dynamic deltas after a failed turn and rebuilds before the next event', async () => {
    const requests: BrainInteractionRequest[] = [];
    let failDecision = true;
    const client: BrainInteractionClient = {
      create: async (request) => {
        requests.push(structuredClone(request));
        if (request.kind === 'decision' && failDecision) {
          failDecision = false;
          throw new Error('API error after ambiguous submission');
        }
        return {
          id: `I${requests.length}`, status: 'completed',
          outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
          usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5, thoughtTokens: 5, totalTokens: 110 },
        };
      },
    };
    const reasons: string[] = [];
    const service = brainService(client, {
      bootstrap: async (reason) => { reasons.push(reason); return bootstrap(); },
    });
    await service.startStream();
    service.queueDelta({ type: 'CATEGORY_CHANGED', summary: 'Dota 2 → IRL' });

    await expect(service.enqueueEvent(firstEvent)).rejects.toThrow('API error');
    await service.enqueueEvent({ ...firstEvent, id: 'event-after-api-error' });

    const decisions = requests.filter(({ kind }) => kind === 'decision');
    expect(reasons).toEqual(['stream_start', 'recovery']);
    expect(decisions).toHaveLength(2);
    expect(decisions.map(({ input }) => JSON.parse(input).deltas)).toEqual([
      [{ type: 'CATEGORY_CHANGED', summary: 'Dota 2 → IRL' }],
      [{ type: 'CATEGORY_CHANGED', summary: 'Dota 2 → IRL' }],
    ]);
  });

  it('measures Brain latency from event enqueue through context preparation and API completion', async () => {
    let now = 1_000;
    const onDecision = vi.fn(async () => undefined);
    const client: BrainInteractionClient = {
      create: async (request) => {
        if (request.kind === 'decision') now += 700;
        return {
          id: request.kind === 'bootstrap' ? 'A' : 'B', status: 'completed',
          outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
          usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5, thoughtTokens: 5, totalTokens: 110 },
        };
      },
    };
    const service = brainService(client, {
      now: () => now,
      prepareEvent: async (event) => {
        now += 300;
        return {
          event, availableBots: bootstrap().availableBots, recentChatDelta: [],
          targetedPersonaContext: [], reactionExamples: [], deltas: [],
          constraints: { maxReactions: 3, maxMessageBytes: 500, globalSlotsAvailable: 3, expiresAt: 9e15 },
        };
      },
      onDecision,
    });
    await service.startStream();

    await service.enqueueEvent(firstEvent);

    // 300ms preparing context + 700ms in the API. The total is what the operator waited; the API
    // figure is reported separately so a queue backed up behind a slow event is not misread as the
    // model itself being slow.
    expect(onDecision).toHaveBeenCalledWith(firstEvent, expect.anything(), 1_000, 'B', 'A', 700);
    expect(service.getStatus().lastLatencyMs).toBe(1_000);
  });

  it('abandons an interaction that outlives its deadline instead of holding the queue', async () => {
    vi.useFakeTimers();
    const onDecision = vi.fn(async () => undefined);
    let decisionCalls = 0;
    const client: BrainInteractionClient = {
      create: async (request) => {
        if (request.kind === 'bootstrap') {
          return {
            id: 'A', status: 'completed', outputText: '{"ready":true}',
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, thoughtTokens: 0, totalTokens: 11 },
          };
        }
        decisionCalls += 1;
        // The production failure was one call running 97s: its own reaction context expired at 45s
        // and the two events behind it waited 87s and 73s just to have their context prepared.
        if (decisionCalls === 1) return new Promise(() => {});
        return {
          id: 'B', status: 'completed', outputText: '{"reactions":[],"memoryUpdates":[]}',
          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, thoughtTokens: 0, totalTokens: 11 },
        };
      },
    };
    const service = brainService(client, { onDecision, interactionTimeoutMs: 1_000 });
    await service.startStream();

    const stuck = service.enqueueEvent(firstEvent);
    const stuckSettled = stuck.then(() => 'resolved', () => 'rejected');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await stuckSettled).toBe('rejected');

    // The queue must be usable again immediately; the deadline exists to release it, and a second
    // deadline's worth of retrying would defeat that, so a timeout is never retried.
    const next = service.enqueueEvent({ ...firstEvent, id: 'event-2' });
    await vi.advanceTimersByTimeAsync(500);
    await expect(next).resolves.toMatchObject({ reactions: [] });
    expect(decisionCalls).toBe(2);
    vi.useRealTimers();
  });

  it('makes no Interactions API call for events received while the stream session is offline', async () => {
    const client: BrainInteractionClient = { create: vi.fn() };
    const service = brainService(client);

    const result = await service.enqueueEvent(firstEvent);

    expect(result).toBeUndefined();
    expect(client.create).not.toHaveBeenCalled();
  });

  it('forwards greeting, visual-only, and exact direct-mention events as semantic turns', async () => {
    const requests: BrainInteractionRequest[] = [];
    const client: BrainInteractionClient = {
      create: async (request) => {
        requests.push(structuredClone(request));
        return {
          id: `S${requests.length}`, status: 'completed',
          outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
          usage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 5, thoughtTokens: 5, totalTokens: 110 },
        };
      },
    };
    const service = brainService(client);
    await service.startStream();
    await service.enqueueEvent(firstEvent);
    await service.enqueueEvent({
      ...firstEvent, id: 'visual-only', type: 'visual', speech: undefined,
      summary: 'Друг стримера упал со стула.', visualContext: 'В кадре человек падает со стула.',
    });
    await service.enqueueEvent({
      ...firstEvent, id: 'direct', type: 'direct_mention',
      speech: 'bot-1 ты тут?', summary: 'Стример обратился к bot-1.', directMentions: ['bot-1'],
    });

    const events = requests.filter(({ kind }) => kind === 'decision')
      .map((request) => (JSON.parse(request.input) as { event: StreamEvent }).event);
    expect(events.map(({ type }) => type)).toEqual(['greeting', 'visual', 'direct_mention']);
    expect(events[1]?.speech).toBeUndefined();
    expect(events[2]?.directMentions).toEqual(['bot-1']);
  });

  it('sends a 30-persona bootstrap once across 100 event turns instead of resending it 100 times', async () => {
    const requests: BrainInteractionRequest[] = [];
    const client: BrainInteractionClient = {
      create: async (request) => {
        requests.push(structuredClone(request));
        return {
          id: `C${requests.length}`, status: 'completed',
          outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
          usage: { inputTokens: 150, cachedInputTokens: 4_000, outputTokens: 5, thoughtTokens: 5, totalTokens: 4_160 },
        };
      },
    };
    const service = brainService(client, { contextRolloverTokens: 900_000 });
    await service.startStream();
    for (let index = 0; index < 100; index += 1) {
      await service.enqueueEvent({ ...firstEvent, id: `cost-${index}`, timestamp: firstEvent.timestamp + index });
    }

    expect(requests.filter(({ kind }) => kind === 'bootstrap')).toHaveLength(1);
    expect(requests.filter(({ kind }) => kind === 'decision')).toHaveLength(100);
    expect(requests[0]?.input).toContain('shortIdentity');
    expect(requests.slice(1).every((request) => !request.input.includes('shortIdentity'))).toBe(true);
    expect(requests.slice(1).every((request) => !request.input.includes('personas'))).toBe(true);
  });

  describe('Persona Drive opportunities', () => {
    it('never calls the Interactions API and never bootstraps before the stream session is ready', async () => {
      const client: BrainInteractionClient = { create: vi.fn() };
      const service = brainService(client);

      const result = await service.evaluateDriveOpportunity(driveInput());

      expect(result).toBeUndefined();
      expect(client.create).not.toHaveBeenCalled();
    });

    it('evaluates an opportunity once the Brain is READY, even with zero prior external StreamEvents', async () => {
      const requests: BrainInteractionRequest[] = [];
      const client: BrainInteractionClient = {
        create: async (request) => {
          requests.push(structuredClone(request));
          return {
            id: `D${requests.length}`, status: 'completed',
            outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
            usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5, thoughtTokens: 5, totalTokens: 110 },
          };
        },
      };
      const service = brainService(client);
      await service.startStream();
      expect(requests.filter(({ kind }) => kind === 'decision')).toHaveLength(0);

      const decision = await service.evaluateDriveOpportunity(driveInput());

      expect(decision).toEqual({ reactions: [], memoryUpdates: [] });
      expect(requests.map(({ kind }) => kind)).toEqual(['bootstrap', 'decision']);
      expect(requests[1]?.previousInteractionId).toBe('D1');
    });

    it('caps reactions to exactly one regardless of what the model returns', async () => {
      const client: BrainInteractionClient = {
        create: async (request) => ({
          id: 'E1', status: 'completed',
          outputText: request.kind === 'bootstrap'
            ? '{"ready":true}'
            : JSON.stringify({
              reactions: [
                { username: 'bot-1', message: 'первое' },
                { username: 'bot-2', message: 'второе' },
                { username: 'bot-3', message: 'третье' },
              ],
              memoryUpdates: [],
            }),
          usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5, thoughtTokens: 5, totalTokens: 110 },
        }),
      };
      const service = brainService(client);
      await service.startStream();

      const decision = await service.evaluateDriveOpportunity(driveInput());

      expect(decision?.reactions).toEqual([{ username: 'bot-1', message: 'первое' }]);
    });

    it('serializes drive opportunities on the same queue as external events so they never race previous_interaction_id', async () => {
      const requests: BrainInteractionRequest[] = [];
      const client: BrainInteractionClient = {
        create: async (request) => {
          requests.push(structuredClone(request));
          return {
            id: `F${requests.length}`, status: 'completed',
            outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
            usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5, thoughtTokens: 5, totalTokens: 110 },
          };
        },
      };
      const service = brainService(client);
      await service.startStream();

      const event = service.enqueueEvent(firstEvent);
      const drive = service.evaluateDriveOpportunity(driveInput());
      await Promise.all([event, drive]);

      const decisionIds = requests.filter(({ kind }) => kind === 'decision').map(({ previousInteractionId }) => previousInteractionId);
      expect(decisionIds).toEqual(['F1', 'F2']);
    });

    it('sets rolloverRequired from a drive call without rolling over itself; the next external event picks it up', async () => {
      const requests: BrainInteractionRequest[] = [];
      const reasons: string[] = [];
      const client: BrainInteractionClient = {
        create: async (request) => {
          requests.push(structuredClone(request));
          return {
            id: `G${requests.length}`, status: 'completed',
            outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
            usage: {
              inputTokens: request.kind === 'decision' ? 800 : 100,
              cachedInputTokens: 50, outputTokens: 5, thoughtTokens: 5, totalTokens: 810,
            },
          };
        },
      };
      const service = brainService(client, {
        contextRolloverTokens: 750,
        bootstrap: async (reason) => { reasons.push(reason); return bootstrap(); },
      });
      await service.startStream();

      await service.evaluateDriveOpportunity(driveInput());
      expect(requests.filter(({ kind }) => kind === 'bootstrap')).toHaveLength(1);
      expect(reasons).toEqual(['stream_start']);

      await service.enqueueEvent(firstEvent);
      expect(reasons).toEqual(['stream_start', 'rollover']);
    });

    it('does not advance chatCursor — the next external event still receives chat since the last real cursor position', async () => {
      const client: BrainInteractionClient = {
        create: async (request) => ({
          id: request.kind === 'bootstrap' ? 'H0' : `H${Math.random()}`, status: 'completed',
          outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
          usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5, thoughtTokens: 5, totalTokens: 110 },
        }),
      };
      const seenChatAfter: number[] = [];
      const service = brainService(client, {
        prepareEvent: async (event, chatAfter) => {
          seenChatAfter.push(chatAfter);
          return {
            triggerKind: 'external_stream_event', event, availableBots: bootstrap().availableBots,
            recentChatDelta: [], targetedPersonaContext: [], reactionExamples: [], deltas: [],
            constraints: { maxReactions: 3, maxMessageBytes: 500, globalSlotsAvailable: 3, expiresAt: 9e15 },
          };
        },
      });
      await service.startStream();
      await service.evaluateDriveOpportunity(driveInput());
      await service.enqueueEvent(firstEvent);

      // Bootstrap seeds chatCursor from bootstrap().startedAt (= firstEvent.timestamp here, since the
      // fixture's recentChat is empty). If the drive call had advanced it, this would differ.
      expect(seenChatAfter).toEqual([firstEvent.timestamp]);
    });

    it('uses the exact same system instruction for bootstrap, external decisions, and drive opportunities', async () => {
      const requests: BrainInteractionRequest[] = [];
      const client: BrainInteractionClient = {
        create: async (request) => {
          requests.push(structuredClone(request));
          return {
            id: `I${requests.length}`, status: 'completed',
            outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
            usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5, thoughtTokens: 5, totalTokens: 110 },
          };
        },
      };
      const service = brainService(client);
      await service.startStream();
      await service.enqueueEvent(firstEvent);
      await service.evaluateDriveOpportunity(driveInput());

      const instructions = new Set(requests.map((request) => request.systemInstruction));
      expect(instructions.size).toBe(1);
      expect(requests[0]?.systemInstruction).toContain('external_stream_event');
      expect(requests[0]?.systemInstruction).toContain('persona_drive');
    });

    it('tags each request body with the correct triggerKind', async () => {
      const requests: BrainInteractionRequest[] = [];
      const client: BrainInteractionClient = {
        create: async (request) => {
          requests.push(structuredClone(request));
          return {
            id: `J${requests.length}`, status: 'completed',
            outputText: request.kind === 'bootstrap' ? '{"ready":true}' : '{"reactions":[],"memoryUpdates":[]}',
            usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5, thoughtTokens: 5, totalTokens: 110 },
          };
        },
      };
      const service = brainService(client);
      await service.startStream();
      await service.enqueueEvent(firstEvent);
      await service.evaluateDriveOpportunity(driveInput());

      const decisions = requests.filter(({ kind }) => kind === 'decision').map(({ input }) => JSON.parse(input) as { triggerKind: string });
      expect(decisions.map((decision) => decision.triggerKind)).toEqual(['external_stream_event', 'persona_drive']);
    });
  });
});

function driveInput(overrides: Partial<import('../src/brain/types').BrainDriveOpportunityInput> = {}): import('../src/brain/types').BrainDriveOpportunityInput {
  return {
    triggerKind: 'persona_drive',
    channel: 'streamer',
    category: 'Dota 2',
    streamContext: '',
    candidates: [{
      username: 'bot-1',
      mood: 'neutral', engagement: 0.5, sessionMessageCount: 0,
      recalledMemories: [], recentOwnMessages: [],
    }],
    recentChat: [],
    deltas: [],
    ...overrides,
  };
}

function brainService(
  client: BrainInteractionClient,
  overrides: Partial<ConstructorParameters<typeof GeminiBrainService>[0]> = {},
): GeminiBrainService {
  return new GeminiBrainService({
    client,
    model: 'gemini-3.7-flash',
    thinkingLevel: 'low',
    bootstrap: async () => bootstrap(),
    prepareEvent: async (event) => ({
      triggerKind: 'external_stream_event', event, availableBots: bootstrap().availableBots, recentChatDelta: [],
      targetedPersonaContext: [], reactionExamples: [], deltas: [],
      constraints: { maxReactions: 3, maxMessageBytes: 500, globalSlotsAvailable: 3, expiresAt: 9e15 },
    }),
    onDecision: async () => undefined,
    usage: new UsageTracker(),
    logger: new Logger('TEST', 'error'),
    eventMergeWindowMs: 0,
    contextRolloverTokens: 800_000,
    ...overrides,
  });
}
