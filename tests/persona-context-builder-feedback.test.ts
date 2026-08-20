import { describe, expect, it } from 'vitest';
import { Logger } from '../src/logger';
import { PersonaFeedbackStore } from '../src/personas/feedback-store';
import { PersonaContextBuilder } from '../src/personas/persona-context-builder';
import { PersonaMemory } from '../src/personas/persona-memory';
import { PersonaRuntimeStore } from '../src/personas/persona-runtime-store';
import { upgradePersona } from '../src/personas/schema';
import { BotPersona, MessageVerdictRecord } from '../src/personas/types';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { StreamEvent } from '../src/stream-brain/types';

function fakeRepository() {
  const rows: MessageVerdictRecord[] = [];
  return {
    saveMessageVerdict: async (verdict: MessageVerdictRecord): Promise<void> => { rows.unshift(verdict); },
    listMessageVerdicts: async (limit: number): Promise<MessageVerdictRecord[]> => rows.slice(0, limit),
  };
}

function person(id: string, examples: string[]): BotPersona {
  return upgradePersona({
    schemaVersion: 2,
    fictionalPersona: true,
    id,
    name: id,
    description: `${id} — постоянный зритель`,
    identity: {
      firstName: id,
      birthDate: '2000-04-10',
      birthplace: { country: 'Казахстан', city: 'Алматы' },
      currentLocation: { country: 'Казахстан', city: 'Алматы' },
      languages: [{ language: 'русский', level: 'свободно' }],
      occupation: 'монтажёр',
    },
    family: [],
    timeline: [],
    facts: [],
    opinions: [],
    knowledge: { expertise: [], familiarTopics: [], weakTopics: [], unknownTopics: [] },
    character: { summary: 'спокойный', traits: ['наблюдательный'], strengths: [], flaws: [], humor: 'сухой', conflictStyle: 'не спорит долго' },
    interests: { games: ['Dota 2'], music: [], food: [], other: [] },
    speech: {
      averageMessageWords: 6, vocabulary: ['ну'], favoriteExpressions: [], rareExpressions: [],
      avoidedExpressions: [], fillerWords: ['короче'], typoStyle: [], punctuationStyle: 'редкие точки',
      capitalizationStyle: 'обычный регистр', laughStyles: ['ахах'], emojiPreferences: [], profanityLevel: 0.1,
      messageExamples: examples,
    },
    behavior: {
      styleInstructions: 'отвечай коротко', verbosity: { minWords: 2, maxWords: 10 }, reactionProbability: 0.4,
      uppercaseProbability: 0.01, questionProbability: 0.1, emojiProbability: 0.02, slangLevel: 0.4,
      sarcasmLevel: 0.2, toxicityLimit: 0.05, temperature: 0.8, minimumIntervalMs: 60_000,
      imperfections: { typingMistakes: [], hesitations: [], emotionalTriggers: [], blindSpots: [] },
      activity: { chatFrequency: 'low', directReplyLikelihood: 0.9, eventSelectivity: 0.8, preferredEventTypes: ['conversation'], averageDelayMs: { min: 1_500, max: 5_000 } },
    },
    streamerRelationship: { familiarity: 0.4, supportiveness: 0.6, teasingLevel: 0.2, favoriteStreamTypes: ['Dota 2'], recurringReferences: [], rememberedStreamerMoments: [] },
    relationships: [],
  });
}

const event: StreamEvent = {
  id: 'event-1', timestamp: 1_700_000_000_000, type: 'other', summary: 'стример катает рейтинговую игру',
  importance: 0.7, confidence: 0.9, source: 'gemini-live', directMentions: [],
};

async function setup(authoredExamples: string[] = ['авторский пример один', 'авторский пример два']) {
  const repository = new MemoryRepository();
  const memory = new PersonaMemory(repository, { now: () => 1_700_000_000_000 });
  const runtime = new PersonaRuntimeStore(() => 1_700_000_000_000);
  const feedbackStore = new PersonaFeedbackStore(fakeRepository(), new Logger('TEST', 'error'));
  const builder = new PersonaContextBuilder(memory, runtime, undefined, undefined, feedbackStore);
  const persona = person('griffin0502', authoredExamples);
  return { builder, feedbackStore, persona };
}

describe('PersonaContextBuilder with live feedback examples', () => {
  it('a liked live message becomes eligible for the per-event example list', async () => {
    const { builder, feedbackStore, persona } = await setup();
    await feedbackStore.record({ username: 'griffin0502', message: 'го дальше по классике сегодня', verdict: 'good' });
    const context = await builder.build({
      username: 'griffin0502', persona, event, recentMessages: [], directMention: false,
    });
    expect(context.speech.messageExamples).toContain('го дальше по классике сегодня');
  });

  it('keeps the example budget exactly as before — merging live examples does not grow the payload', async () => {
    const { builder, feedbackStore, persona } = await setup(
      Array.from({ length: 10 }, (_, i) => `авторский пример номер ${i} про совершенно разное`),
    );
    for (let i = 0; i < 5; i += 1) {
      await feedbackStore.record({ username: 'griffin0502', message: `лайкнутое сообщение номер ${i} совсем другое`, verdict: 'good' });
    }
    const context = await builder.build({
      username: 'griffin0502', persona, event, recentMessages: [], directMention: false,
    });
    expect(context.speech.messageExamples.length).toBeLessThanOrEqual(5);
  });

  it('never mixes one persona\'s liked examples into another persona\'s context', async () => {
    const { builder, feedbackStore, persona } = await setup();
    await feedbackStore.record({ username: 'someone-else', message: 'чужой понравившийся текст', verdict: 'good' });
    const context = await builder.build({
      username: 'griffin0502', persona, event, recentMessages: [], directMention: false,
    });
    expect(context.speech.messageExamples.join(' ')).not.toContain('чужой понравившийся текст');
  });

  it('does not let several near-identical likes all occupy the diversity-limited slot list', async () => {
    const { builder, feedbackStore, persona } = await setup([]);
    // Five near-identical likes plus one genuinely different one.
    for (let i = 0; i < 5; i += 1) {
      await feedbackStore.record({ username: 'griffin0502', message: 'го дальше по классике чё как там дела', verdict: 'good' });
    }
    await feedbackStore.record({ username: 'griffin0502', message: 'сегодня стрим про кулинарию и рецепты', verdict: 'good' });
    const context = await builder.build({
      username: 'griffin0502', persona, event, recentMessages: [], directMention: false,
    });
    const distinct = new Set(context.speech.messageExamples);
    // Near-duplicate skip in selectSpeechExamples means the near-identical family contributes at
    // most one survivor, not all five, even though five of the six liked candidates share it.
    const nearIdenticalSurvivors = context.speech.messageExamples.filter((example) => example.includes('го дальше по классике'));
    expect(nearIdenticalSurvivors.length).toBeLessThanOrEqual(1);
    expect(distinct.size).toBe(context.speech.messageExamples.length);
  });

  it('counts a live example actually reaching a snapshot, not merely being eligible', async () => {
    const { builder, feedbackStore, persona } = await setup([]);
    await feedbackStore.record({ username: 'griffin0502', message: 'единственный пример для этого события', verdict: 'good' });
    expect(feedbackStore.snapshot().approvedLiveExamplesUsed).toBe(0);
    await builder.build({ username: 'griffin0502', persona, event, recentMessages: [], directMention: false });
    expect(feedbackStore.snapshot().approvedLiveExamplesUsed).toBeGreaterThan(0);
  });

  it('buildBrainSnapshot draws its shape examples from the same merged pool', async () => {
    const { builder, feedbackStore, persona } = await setup([]);
    await feedbackStore.record({ username: 'griffin0502', message: 'распознаваемая одобренная фраза для снапшота', verdict: 'good' });
    const snapshot = builder.buildBrainSnapshot('griffin0502', persona);
    expect(snapshot.speechFingerprint).toContain('распознаваемая одобренная фраза для снапшота');
  });

  it('works unchanged when no feedback store is supplied — existing wiring keeps behaving as before', async () => {
    const repository = new MemoryRepository();
    const memory = new PersonaMemory(repository, { now: () => 1_700_000_000_000 });
    const runtime = new PersonaRuntimeStore(() => 1_700_000_000_000);
    const builder = new PersonaContextBuilder(memory, runtime);
    const persona = person('griffin0502', ['авторский пример']);
    const context = await builder.build({ username: 'griffin0502', persona, event, recentMessages: [], directMention: false });
    expect(context.speech.messageExamples).toContain('авторский пример');
  });
});
