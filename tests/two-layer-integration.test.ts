import { describe, expect, it, vi } from 'vitest';
import { GeminiBrainService, BrainInteractionRequest } from '../src/brain/gemini-brain.service';
import { GlobalStreamerMemory } from '../src/global-memory/global-streamer-memory';
import { ReactionMemory } from '../src/learning/reaction-memory';
import { Logger } from '../src/logger';
import { BotHistory } from '../src/personas/bot-history';
import { generatePersonaV3 } from '../src/personas/generator-v3';
import { PersonaContextBuilder } from '../src/personas/persona-context-builder';
import { PersonaMemory } from '../src/personas/persona-memory';
import { PersonaRuntimeStore } from '../src/personas/persona-runtime-store';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { ReactionCoordinator } from '../src/reaction/reaction-coordinator';
import { ReactionPolicyGuard } from '../src/reaction/reaction-policy-guard';
import { ContextStore } from '../src/stream-brain/context-store';
import { EventDetector } from '../src/stream-brain/event-detector';
import { StreamBrainService } from '../src/stream-brain/stream-brain.service';
import { StreamEvent } from '../src/stream-brain/types';
import { UsageTracker } from '../src/usage/usage-tracker';

describe('Live perception → stateful Brain → Twitch integration', () => {
  it('schedules a selected greeting reaction and sends nothing for Brain silence', async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository();
    await repository.initialize();
    const usage = new UsageTracker();
    const logger = new Logger('TEST', 'error');
    const contextStore = new ContextStore({ chatWindowMs: 120_000, maxChatMessages: 100, maxEvents: 100 });
    contextStore.configure({ channel: 'streamer', category: 'Dota 2', streamContext: 'ranked', isLive: true });
    const persona = generatePersonaV3('gigantiuz');
    const candidate = {
      username: 'gigantiuz', persona, enabled: true,
      connectionState: 'CONNECTED' as const, chatConnected: true,
    };
    const personaMemory = new PersonaMemory(repository);
    const personaRuntime = new PersonaRuntimeStore();
    const personaContext = new PersonaContextBuilder(personaMemory, personaRuntime);
    const globalMemory = new GlobalStreamerMemory({ repository, usage });
    await globalMemory.startOrResumeSession({ channel: 'streamer', initialCategory: 'Dota 2' });
    const sent: Array<{ username: string; message: string }> = [];
    const coordinator = new ReactionCoordinator({
      policy: new ReactionPolicyGuard({ globalMessagesPer30Seconds: 10, maxReactionsPerEvent: 3 }),
      sender: { send: async (username, message) => {
        sent.push({ username, message });
        return { submitted: true, submittedAt: Date.now() };
      } },
      history: new BotHistory(repository),
      memory: new ReactionMemory({ enabled: true, reactionWindowMs: 1_000, repository }),
      globalMemory, personaContext, personaMemory, personaRuntime, contextStore, usage, logger,
      retrievalLimit: 3,
      candidates: () => [candidate],
    });
    const requests: BrainInteractionRequest[] = [];
    const brain = new GeminiBrainService({
      client: { create: async (request) => {
        requests.push(structuredClone(request));
        const greeting = request.kind === 'decision'
          && (JSON.parse(request.input) as { event: StreamEvent }).event.type === 'greeting';
        return {
          id: `I${requests.length}`, status: 'completed',
          outputText: request.kind === 'bootstrap'
            ? '{"ready":true}'
            : greeting
              ? '{"reactions":[{"username":"gigantiuz","message":"привет"}],"memoryUpdates":[]}'
              : '{"reactions":[],"memoryUpdates":[]}',
          usage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 5, thoughtTokens: 5, totalTokens: 110 },
        };
      } },
      model: 'gemini-3.7-flash', thinkingLevel: 'low', usage, logger,
      bootstrap: async () => ({
        channel: 'streamer', category: 'Dota 2', streamContext: 'ranked', startedAt: Date.now(),
        availableBots: ['gigantiuz'], personas: [personaContext.buildBrainSnapshot('gigantiuz', persona)],
        globalMemories: [], currentSessionEvents: [], earlierStreamEvents: [], recentChat: [],
      }),
      prepareEvent: (streamEvent, chatAfter, emittedAt) =>
        coordinator.prepareBrainEvent(streamEvent, chatAfter, emittedAt),
      onDecision: async (streamEvent, decision, latencyMs, interactionId, previousInteractionId) => {
        coordinator.recordBrainDecision(streamEvent.id, { interactionId, previousInteractionId, latencyMs });
        await coordinator.submitBatch({ eventId: streamEvent.id, reactions: decision.reactions.map(({ username, message }) => ({ username, message })) });
      },
      eventMergeWindowMs: 0,
      contextRolloverTokens: 800_000,
    });
    const perception = new StreamBrainService({
      channel: 'streamer', contextStore, eventDetector: new EventDetector({ minimumConfidence: 0.4 }),
      eventSink: repository, usage, logger, contextRefreshMs: 30_000, enabled: false,
      eventDeduplicationWindowMs: 0,
    });
    perception.on('event', (streamEvent: StreamEvent) => { void brain.enqueueEvent(streamEvent); });
    await brain.startStream();

    await perception.acceptCandidate({ type: 'greeting', summary: 'Стример сказал всем привет.', speech: 'всем привет', importance: .8, confidence: .99 });
    await vi.waitFor(() => expect(requests.filter(({ kind }) => kind === 'decision')).toHaveLength(1));
    await vi.runAllTimersAsync();
    expect(sent).toEqual([{ username: 'gigantiuz', message: 'привет' }]);

    await perception.acceptCandidate({ type: 'other', summary: 'Незначительный обычный момент.', importance: .5, confidence: .9 });
    await vi.waitFor(() => expect(requests.filter(({ kind }) => kind === 'decision')).toHaveLength(2));
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(1);
    expect(requests.filter(({ kind }) => kind === 'bootstrap')).toHaveLength(1);

    await brain.stopStream();
    await coordinator.stop();
    vi.useRealTimers();
  });
});
