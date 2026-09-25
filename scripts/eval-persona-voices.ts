/** Paid, offline voice probe. Uses the production prompt, transport and snapshot builder.
 * No Twitch sender, database writes, or production session. Run only explicitly, never in CI.
 * This tests one candidate at a time; it does not measure live multi-account scheduling.
 */
import { writeFileSync } from 'node:fs';
import { BRAIN_DECISION_RESPONSE_SCHEMA, BRAIN_SYSTEM_INSTRUCTION, READY_RESPONSE_SCHEMA, BrainInteractionRequest } from '../src/brain/gemini-brain.service';
import { OpenRouterBrainClient } from '../src/brain/openrouter-brain.client';
import { Logger } from '../src/logger';
import { PersonaContextBuilder } from '../src/personas/persona-context-builder';
import { PersonaMemory } from '../src/personas/persona-memory';
import { PersonaRuntimeStore } from '../src/personas/persona-runtime-store';
import { BotPersona } from '../src/personas/types';
import { MemoryRepository } from '../src/persistence/memory-repository';

export async function runVoiceEval(options: { apiKey: string; model: string; personas: BotPersona[]; outputPath: string; scenarios?: string[] }) {
  const repository = new MemoryRepository();
  const builder = new PersonaContextBuilder(new PersonaMemory(repository), new PersonaRuntimeStore());
  const results: Array<Record<string, unknown>> = [];
  let costUsd = 0;
  let index = 0;
  const save = () => writeFileSync(options.outputPath, JSON.stringify({ model: options.model, costUsd, results }, null, 2));
  const request = async (client: OpenRouterBrainClient, input: BrainInteractionRequest) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await client.create({ ...input, signal: AbortSignal.timeout(60_000) });
      costUsd += response.usage.costUsd ?? 0;
      try {
        if (response.status !== 'completed') throw new Error('incomplete');
        JSON.parse(response.outputText ?? '');
        return response;
      } catch {
        if (attempt === 1) throw new Error('invalid structured response after retry');
      }
    }
    throw new Error('unreachable');
  };
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (index < options.personas.length) {
      const persona = options.personas[index++]!;
      const username = persona.generatedFromUsername!;
      try {
      const client = new OpenRouterBrainClient({ apiKey: options.apiKey, logger: new Logger('VOICE_EVAL', 'error'), maxRetainedChains: 10 });
      const now = Date.now();
      const common = { model: options.model, systemInstruction: BRAIN_SYSTEM_INSTRUCTION, thinkingLevel: 'low' as const, maxOutputTokens: 2048, store: true as const };
      const bootstrap = await request(client, { ...common, kind: 'bootstrap', responseSchema: READY_RESPONSE_SCHEMA, input: JSON.stringify({
        channel: 'offline_fixture', category: 'Just Chatting', streamContext: '', startedAt: now,
        availableBots: [username], personas: [builder.buildBrainSnapshot(username, persona)],
        globalMemories: [], currentSessionEvents: [], earlierStreamEvents: [], recentChat: [],
      }) });
      if (JSON.parse(bootstrap.outputText ?? '{}').ready !== true) throw new Error('voice_eval_bootstrap_failed');
      const scenarios = [
        { id: 'followup', speech: `S: ${username}, да, я про декоративные облака. Ты сам такие клеил или просто спросил?`, previous: 'они на клей обычно идут или на сетку?', visual: 'Стример показывает декоративные облака. Материал не определён.' },
        { id: 'unknown_advice', speech: `S: ${username}, скажи точно, какой клей купить для этого?`, visual: 'На столе деталь без маркировки. Материал и назначение неизвестны.' },
        { id: 'preference', speech: `S: ${username}, ты бы сегодня попробовал новую игру или вернулся в старую знакомую? Почему?`, visual: '' },
        { id: 'correction', speech: `S: ${username}, нет, ты перепутал, я первый раз это пробую, не второй`, previous: 'со второго раза уже легче', visual: 'Стример пробует собрать небольшую модель.' },
        { id: 'silence', speech: '', visual: 'Неизменный экран. Играет фоновая инструментальная музыка. Разборчивой речи и новых событий нет.' },
      ];
      for (const scenario of scenarios.filter(s => !options.scenarios || options.scenarios.includes(s.id))) {
        const event = {
          id: scenario.id, timestamp: now, type: 'conversation' as const, summary: scenario.speech || scenario.visual,
          speech: scenario.speech, visualContext: scenario.visual, source: 'transcription' as const, confidence: 0.98,
          importance: scenario.id === 'silence' ? 0.1 : 0.7, directMentions: scenario.speech ? [username] : [],
          audience: scenario.speech ? 'twitch_chat' as const : 'unclear' as const,
        };
        const context = await builder.build({ username, persona, event, directMention: Boolean(scenario.speech), recentMessages: scenario.previous ? [scenario.previous] : [] });
        const response = await request(client, { ...common, kind: 'decision', previousInteractionId: bootstrap.id, responseSchema: BRAIN_DECISION_RESPONSE_SCHEMA, input: JSON.stringify({
          triggerKind: 'external_stream_event',
          event,
          availableBots: [username], recentChatDelta: [],
          recentSpeech: scenario.speech ? [{ timestamp: now, text: scenario.speech }] : [],
          recentAccountMessages: [{ username, messages: scenario.previous ? [scenario.previous] : [] }],
          ...(scenario.previous ? { streamerReplyTo: { username, message: scenario.previous, sentAt: now - 15000 } } : {}),
          streamerMemories: [], targetedPersonaContext: scenario.speech ? [{
            username, relevantCanon: context.relevantCanon, relevantMemories: context.relevantMemories,
            recentConversation: context.recentConversation, recentMessages: context.recentMessages,
            personalResponseGuidance: context.personalResponseGuidance,
          }] : [], reactionExamples: [], deltas: [],
          constraints: { maxReactions: 1, maxMessageBytes: 450, globalSlotsAvailable: 1, expiresAt: now + 3600_000 },
        }) });
        const decision = JSON.parse(response.outputText ?? '{}');
        results.push({ username, scenario: scenario.id, status: response.status, decision, usage: response.usage });
        save();
      }
      console.log(`Reviewed ${username}: ${options.scenarios?.length ?? 5} scenarios (${results.length})`);
      } catch {
        results.push({ username, error: 'evaluation_request_failed' });
        save();
        console.log(`Evaluation incomplete for ${username}; other accounts continue`);
      }
    }
  }));
  save();
  return { cases: results.length, costUsd };
}
