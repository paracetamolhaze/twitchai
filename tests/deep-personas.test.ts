import { describe, expect, it } from 'vitest';
import { resolveViewerConversationTargets, shouldPersistViewerMemory, viewerConversationSummary } from '../src/application';
import { BotHistory } from '../src/personas/bot-history';
import { isAccountClassificationQuestion, PersonaContextBuilder } from '../src/personas/persona-context-builder';
import { generatePersonaV3 } from '../src/personas/generator-v3';
import { PersonaMemory } from '../src/personas/persona-memory';
import { PersonaRuntimeStore } from '../src/personas/persona-runtime-store';
import { PersonaStore } from '../src/personas/persona-store';
import { upgradePersona } from '../src/personas/schema';
import { BotPersona, PersonaFact } from '../src/personas/types';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { StreamEvent } from '../src/stream-brain/types';

const event = (summary: string, directMentions: string[] = []): StreamEvent => ({
  id: `event-${summary}`,
  timestamp: 1_700_000_000_000,
  type: directMentions.length ? 'conversation' : 'other',
  summary,
  importance: 0.8,
  confidence: 1,
  source: 'gemini-live',
  directMentions,
});

function person(id: string, firstName: string, city: string, uncle: string): BotPersona {
  return upgradePersona({
    schemaVersion: 2,
    fictionalPersona: true,
    id,
    name: firstName,
    description: `${firstName} — постоянный зритель`,
    identity: {
      firstName,
      birthDate: '2000-04-10',
      birthplace: { country: 'Казахстан', city },
      currentLocation: { country: 'Казахстан', city },
      languages: [{ language: 'русский', level: 'свободно' }],
      occupation: 'монтажёр',
    },
    family: [{
      id: `${id}-uncle`, relation: 'uncle', name: uncle, occupation: 'автомеханик',
      city, relationshipDescription: 'иногда созваниваются', facts: ['научил разбираться в машинах'],
    }],
    timeline: [],
    facts: [],
    opinions: [],
    knowledge: { expertise: ['автомобили'], familiarTopics: [], weakTopics: [], unknownTopics: [] },
    character: { summary: 'спокойный', traits: ['наблюдательный'], strengths: [], flaws: [], humor: 'сухой', conflictStyle: 'не спорит долго' },
    interests: { games: ['Dota 2'], music: [], food: [], other: ['автомобили'] },
    speech: {
      averageMessageWords: 6, vocabulary: ['ну'], favoriteExpressions: ['ну это сильно'], rareExpressions: [],
      avoidedExpressions: [], fillerWords: ['короче'], typoStyle: ['иногда пропускает запятые'], punctuationStyle: 'редкие точки',
      capitalizationStyle: 'обычный регистр', laughStyles: ['ахах'], emojiPreferences: [], profanityLevel: 0.1,
      messageExamples: ['ну это сильно конечно'],
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

async function setup() {
  const repository = new MemoryRepository();
  const memory = new PersonaMemory(repository, { now: () => 1_700_000_000_000 });
  const history = new BotHistory(repository);
  const builder = new PersonaContextBuilder(memory, new PersonaRuntimeStore(() => 1_700_000_000_000));
  return { repository, memory, history, builder };
}

describe('deep persistent personas', () => {
  it('does not keep account-classification accusations as durable viewer memory', () => {
    expect(isAccountClassificationQuestion('ты бот?')).toBe(true);
    expect(isAccountClassificationQuestion('ты бот')).toBe(true);
    expect(isAccountClassificationQuestion('ты ИИ?')).toBe(true);
    expect(isAccountClassificationQuestion('это бот в чате?')).toBe(true);
    expect(isAccountClassificationQuestion('@karlbekner ты настоящий бот?')).toBe(true);
    expect(isAccountClassificationQuestion('@bot ты бот?')).toBe(true);
    expect(isAccountClassificationQuestion('@karlbekner бот ли ты?')).toBe(true);
    expect(isAccountClassificationQuestion('@karlbekner этот аккаунт — бот?')).toBe(true);
    expect(isAccountClassificationQuestion('is this account a bot?')).toBe(true);
    expect(isAccountClassificationQuestion('you are a bot?')).toBe(true);
    expect(isAccountClassificationQuestion('Gemini для кода иногда норм')).toBe(false);
    expect(isAccountClassificationQuestion('@karlbekner ты пробовал Gemini для кода?')).toBe(false);
    expect(isAccountClassificationQuestion('@bot ты пробовал Gemini для кода?')).toBe(false);
    expect(isAccountClassificationQuestion('@gpt ты Gemini используешь?')).toBe(false);
    expect(isAccountClassificationQuestion('ты GPT для кода тестил?')).toBe(false);
    expect(isAccountClassificationQuestion('you are a botany expert?')).toBe(false);
    expect(shouldPersistViewerMemory('ты бот? запомни')).toBe(false);
    expect(shouldPersistViewerMemory('ты бот запомни')).toBe(false);
    expect(shouldPersistViewerMemory('я работаю ночью в аптеке')).toBe(true);
  });

  it('does not inherit an account-classification flag from unrelated recent chat', async () => {
    const { builder } = await setup();
    const context = await builder.build({
      username: 'karlbekner',
      persona: generatePersonaV3('karlbekner'),
      event: event('@karlbekner что скажешь про Black Hole?', ['karlbekner']),
      directMention: true,
      recentMessages: [],
      recentChat: [{
        id: 'other-bot-classification', timestamp: 1_700_000_000_000, username: 'viewer', displayName: 'viewer',
        message: '@otherbot ты бот?', kind: 'viewer',
      }],
    });

    expect(context.accountClassificationQuestion).toBe(false);
  });

  it('does not retrieve personal canon from another viewer\'s recent chat', async () => {
    const { builder } = await setup();
    const context = await builder.build({
      username: 'karlbekner',
      persona: generatePersonaV3('karlbekner'),
      event: event('@karlbekner ну что по файту?', ['karlbekner']),
      directMention: true,
      recentMessages: [],
      recentChat: [{
        id: 'other-viewer-location', timestamp: 1_700_000_000_000, username: 'other-viewer', displayName: 'other-viewer',
        message: '@karlbekner где сейчас живёшь?', kind: 'viewer',
      }],
    });

    expect(context.relevantCanon).toEqual([]);
  });

  it('builds an admin-free minimal model context for an ordinary gameplay event', async () => {
    const { builder } = await setup();
    const karl = generatePersonaV3('karlbekner');
    const context = await builder.build({
      username: 'karlbekner',
      persona: karl,
      event: event('стример промахнулся решающим ультимейтом'),
      directMention: false,
      recentMessages: [],
    });

    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain('"fictionalPersona"');
    expect(serialized).not.toContain('"personaId"');
    expect(serialized).not.toContain('"generationVersion"');
    expect(serialized).not.toContain('"generatedFromUsername"');
    expect(serialized).not.toContain('"manualOverrides"');
    expect(serialized).not.toMatch(/fictional|вымышленн/iu);
    expect(context).not.toHaveProperty('identity');
    for (const personalFact of ['Константин', 'Костя', '1995', 'Кокшетау', 'Прага', 'системный администратор', 'Роман']) {
      expect(serialized).not.toContain(personalFact);
    }
    expect(context.character.summary).not.toBe('');
    expect(context.speech.summary).not.toBe('');
    expect(context.behavior.activity).toBeDefined();
    expect(context.knowledge.expertise.length).toBeGreaterThan(0);
    expect(context.relevantCanon.some((item) => ['family-background', 'relative', 'timeline'].includes(item.kind))).toBe(false);
  });

  it('strips inflected Russian authoring labels from model-facing profile text', async () => {
    const { builder } = await setup();
    const karl = generatePersonaV3('karlbekner');
    karl.character.summary = 'вымышленный сгенерированный профиль';

    const context = await builder.build({
      username: 'karlbekner',
      persona: karl,
      event: event('стример промахнулся решающим ультимейтом'),
      directMention: false,
      recentMessages: [],
    });

    expect(context.character.summary).toBe('');
    expect(JSON.stringify(context)).not.toMatch(/вымышленн|сгенерированн|"ый"/iu);
  });

  it('does not reintroduce persona canon through free profile text or bot history', async () => {
    const { builder } = await setup();
    const karl = generatePersonaV3('karlbekner');
    karl.speech.messageExamples = ['до Праги я ночные трамваи недооценивал', 'зовут Костя', 'Роман всё чинит', 'ульт в молоко'];

    const context = await builder.build({
      username: 'karlbekner',
      persona: karl,
      event: event('стример промахнулся решающим ультимейтом'),
      directMention: false,
      recentMessages: ['зовут Костя', 'живу в Праге', 'ульт в молоко'],
    });

    const serialized = JSON.stringify(context);
    for (const personalFact of ['Костя', 'Прага', 'Роман', 'Чехию']) {
      expect(serialized).not.toContain(personalFact);
    }
    expect(context.speech.messageExamples).toEqual(['ульт в молоко']);
    expect(context.recentMessages).toEqual(['ульт в молоко']);
    expect(context.knowledge.familiarTopics).not.toContain('переезд в Чехию');
  });

  it('retrieves only the requested uncle fact instead of a family dump', async () => {
    const { builder } = await setup();
    const karl = generatePersonaV3('karlbekner');
    const context = await builder.build({
      username: 'karlbekner',
      persona: karl,
      event: event('@karlbekner как дядю зовут?', ['karlbekner']),
      directMention: true,
      viewerUsername: 'viewer',
      recentMessages: [],
    });

    expect(context.relevantCanon).toHaveLength(1);
    expect(context.relevantCanon[0]).toEqual({ kind: 'relative', value: 'дядя: Роман' });
    expect(JSON.stringify(context.relevantCanon)).not.toContain('Лариса');
    expect(JSON.stringify(context.relevantCanon)).not.toContain('Марат');
    expect(context).not.toHaveProperty('identity');

    const privateKarl = generatePersonaV3('karlbekner');
    privateKarl.disclosure = {
      ...privateKarl.disclosure,
      topics: { ...privateKarl.disclosure.topics, family: 'private' },
    };
    const privateContext = await builder.build({
      username: 'karlbekner',
      persona: privateKarl,
      event: event('@karlbekner как дядю зовут?', ['karlbekner']),
      directMention: true,
      viewerUsername: 'viewer',
      recentMessages: [],
    });
    expect(privateContext.relevantCanon).toEqual([]);
    expect(privateContext.personalResponseGuidance).toMatch(/private/i);
  });

  it('retrieves one exact personal canon item only for a matching direct question', async () => {
    const { builder } = await setup();
    const karl = generatePersonaV3('karlbekner');
    const buildFor = (message: string) => builder.build({
      username: 'karlbekner',
      persona: karl,
      event: event(message, ['karlbekner']),
      directMention: true,
      viewerUsername: 'viewer',
      recentMessages: [],
    });

    const [name, location, occupation] = await Promise.all([
      buildFor('@karlbekner как тебя зовут?'),
      buildFor('@karlbekner где сейчас живёшь?'),
      buildFor('@karlbekner кем работаешь?'),
    ]);

    expect(name.relevantCanon).toEqual([{ kind: 'identity', value: 'Имя: Костя' }]);
    expect(location.relevantCanon).toEqual([{ kind: 'identity', value: 'Сейчас живёт в Прага, Чехия.' }]);
    expect(occupation.relevantCanon).toEqual([{
      kind: 'identity',
      value: 'Работает: системный администратор в небольшой логистической компании.',
    }]);
    for (const context of [name, location, occupation]) {
      expect(context).not.toHaveProperty('identity');
    }
  });

  it('keeps family, memory and bot history strictly namespaced by persona/account', async () => {
    const { memory, history, builder } = await setup();
    const maxim = person('maxim', 'Максим', 'Караганда', 'Сергей');
    const artem = person('artem', 'Артём', 'Алматы', 'Данияр');
    await memory.remember({ personaId: maxim.id, type: 'conversation', summary: 'Максим обсуждал старую Toyota', importance: 0.9, tags: ['машина'] });
    await memory.remember({ personaId: artem.id, type: 'conversation', summary: 'Артём собирается в горы', importance: 0.9, tags: ['горы'] });
    await memory.addConversation({ personaId: maxim.id, viewerUsername: 'viewer', role: 'viewer', message: 'где ты родился?' });
    await memory.addConversation({ personaId: maxim.id, viewerUsername: 'viewer', role: 'persona', message: 'в караганде' });
    await memory.addConversation({ personaId: artem.id, viewerUsername: 'viewer', role: 'persona', message: 'я из алматы' });
    await history.add('bot-maxim', 'моя королла была упрямая');
    await history.add('bot-artem', 'в горы лучше утром');

    const maximContext = await builder.build({
      username: 'bot-maxim', persona: maxim, event: event('@bot-maxim как дядю зовут?', ['bot-maxim']),
      directMention: true, viewerUsername: 'viewer', recentMessages: (await history.recent('bot-maxim')).map((item) => item.message),
    });
    const artemContext = await builder.build({
      username: 'bot-artem', persona: artem, event: event('@bot-artem как дядю зовут?', ['bot-artem']),
      directMention: true, viewerUsername: 'viewer', recentMessages: (await history.recent('bot-artem')).map((item) => item.message),
    });

    expect(JSON.stringify(maximContext)).toContain('Сергей');
    expect(JSON.stringify(maximContext)).not.toContain('Данияр');
    expect(JSON.stringify(maximContext)).not.toContain('в горы лучше утром');
    expect(maximContext.recentConversation).toEqual([]);
    expect(JSON.stringify(maximContext.recentConversation)).not.toContain('я из алматы');
    expect(JSON.stringify(artemContext)).toContain('Данияр');
    expect(JSON.stringify(artemContext)).not.toContain('Сергей');
    expect(JSON.stringify(artemContext)).not.toContain('моя королла');
  });

  it('keeps canon stable and explicitly outranks a conflicting chat claim', async () => {
    const { builder } = await setup();
    const maxim = person('maxim', 'Максим', 'Караганда', 'Сергей');
    const before = structuredClone(maxim);
    const context = await builder.build({
      username: 'bot-maxim', persona: maxim,
      event: event('@bot-maxim твоего дядю Антон зовут?', ['bot-maxim']),
      directMention: true, viewerUsername: 'viewer', recentMessages: [],
    });
    const modelContext = context as unknown as { consistencyGuidance?: string };
    expect(modelContext.consistencyGuidance).toMatch(/canonical|consistent/i);
    expect(JSON.stringify(context.relevantCanon)).toContain('Сергей');
    expect(maxim.identity.birthDate).toBe('2000-04-10');
    expect(maxim.identity.birthplace?.city).toBe('Караганда');
    expect(maxim.identity.occupation).toBe('монтажёр');
    expect(maxim).toEqual(before);
  });

  it('retrieves only a compact topic-specific subset from one hundred facts', async () => {
    const { builder } = await setup();
    const maxim = person('maxim', 'Максим', 'Караганда', 'Сергей');
    const noise: PersonaFact[] = Array.from({ length: 96 }, (_, index) => ({
      id: `noise-${index}`, category: 'other', fact: `нейтральный факт номер ${index} про школьную тетрадь`,
      importance: 0.3, tags: ['школа'],
    }));
    maxim.facts = [
      ...noise,
      { id: 'car-1', category: 'technology', fact: 'первая машина была Toyota Corolla', importance: 0.95, tags: ['машина', 'автомобиль'] },
      { id: 'car-2', category: 'story', fact: 'дядя помог выбрать первую машину', importance: 0.8, tags: ['машина', 'дядя'] },
      { id: 'car-3', category: 'preference', fact: 'не любит слишком низкую посадку автомобиля', importance: 0.6, tags: ['автомобиль'] },
      { id: 'car-4', category: 'habit', fact: 'проверяет масло перед дальней поездкой', importance: 0.5, tags: ['машина'] },
    ];
    const context = await builder.build({
      username: 'bot-maxim', persona: maxim, event: event('стример обсуждает свою первую машину'),
      directMention: false, recentMessages: [],
    });
    const serialized = JSON.stringify(context.relevantCanon);
    expect(context.relevantCanon.length).toBeLessThanOrEqual(6);
    expect(serialized).toContain('Toyota Corolla');
    expect(serialized).not.toContain('школьную тетрадь');
  });

  it('upgrades a shallow stored persona without inventing shared biography defaults', () => {
    const upgraded = upgradePersona({
      id: 'legacy-one', name: 'Старый аналитик', description: 'Смотрит игру внимательно',
      styleInstructions: 'пишет спокойно', verbosity: { minWords: 3, maxWords: 12 },
      reactionProbability: 0.4, uppercaseProbability: 0, questionProbability: 0.2, emojiProbability: 0,
      slangLevel: 0.2, sarcasmLevel: 0.1, toxicityLimit: 0, interests: ['strategy'], temperature: 0.7,
      minimumIntervalMs: 70_000,
    });
    expect(upgraded.schemaVersion).toBe(2);
    expect(upgraded.fictionalPersona).toBe(true);
    expect(upgraded.identity.birthDate).toBeUndefined();
    expect(upgraded.identity.birthplace).toBeUndefined();
    expect(upgraded.identity.occupation).toBeUndefined();
    expect(upgraded.family).toEqual([]);
    expect(upgraded.behavior.styleInstructions).toBe('пишет спокойно');
    expect(upgraded.behavior.verbosity).toEqual({ minWords: 3, maxWords: 12 });
  });

  it('persists only important memory and keeps medium items session-scoped', async () => {
    const { memory } = await setup();
    expect(await memory.remember({ personaId: 'maxim', type: 'stream_event', summary: 'обычная пауза', importance: 0.1, tags: [] })).toBeUndefined();
    const session = await memory.remember({ personaId: 'maxim', type: 'conversation', summary: 'короткий контекст этой сессии', importance: 0.5, tags: ['сессия'] });
    const durable = await memory.remember({ personaId: 'maxim', type: 'viewer', summary: 'viewer собирается в Таиланд', importance: 0.8, tags: ['поездка'] });
    expect(session?.expiresAt).toBeDefined();
    expect(durable?.expiresAt).toBeUndefined();
    expect((await memory.list('maxim')).map((item) => item.summary)).toEqual([
      'viewer собирается в Таиланд',
      'короткий контекст этой сессии',
    ]);
  });

  it('routes an unmentioned follow-up to the viewer most recent persona thread', async () => {
    const { memory } = await setup();
    await memory.addConversation({ personaId: 'maxim', viewerUsername: 'viewer', role: 'viewer', message: 'где родился?' });
    await memory.addConversation({ personaId: 'maxim', viewerUsername: 'viewer', role: 'persona', message: 'в караганде' });
    const recentPersonaIds = await memory.recentConversationPersonaIds('viewer');
    const targets = resolveViewerConversationTargets([
      { username: 'bot-maxim', personaId: 'maxim' },
      { username: 'bot-artem', personaId: 'artem' },
    ], [], recentPersonaIds);
    expect(targets).toEqual([{ username: 'bot-maxim', personaId: 'maxim' }]);
  });

  it('describes direct and continued Twitch conversations in Russian', () => {
    expect(viewerConversationSummary('viewer', ['bot-maxim'], 'ты тут?', true)).toBe(
      'viewer напрямую обратился(ась) к @bot-maxim: ты тут?',
    );
    expect(viewerConversationSummary('viewer', ['bot-maxim'], 'а дальше?', false)).toBe(
      'viewer продолжил(а) недавний разговор с @bot-maxim: а дальше?',
    );
  });

  it('uses deterministic memory ordering when relevance and timestamps tie', async () => {
    const { memory } = await setup();
    await memory.remember({ id: 'z-memory', createdAt: event('').timestamp, personaId: 'maxim', type: 'conversation', summary: 'обсуждали машину', importance: 0.8, tags: ['машина'] });
    await memory.remember({ id: 'a-memory', createdAt: event('').timestamp, personaId: 'maxim', type: 'conversation', summary: 'обсуждали машину', importance: 0.8, tags: ['машина'] });
    const first = await memory.retrieve('maxim', 'машина', 2);
    const second = await memory.retrieve('maxim', 'машина', 2);
    expect(first.map(({ id }) => id)).toEqual(['a-memory', 'z-memory']);
    expect(second.map(({ id }) => id)).toEqual(first.map(({ id }) => id));
  });

  it('preserves an unassigned legacy persona instead of guessing a new biography', async () => {
    const repository = new MemoryRepository();
    await repository.upsertPersona({
      id: 'account-old-bot', name: 'Сохранённое имя', description: 'Сохранённое описание',
      styleInstructions: 'мой сохранённый стиль', verbosity: { minWords: 3, maxWords: 9 },
      reactionProbability: 0.35, uppercaseProbability: 0, questionProbability: 0.1,
      emojiProbability: 0, slangLevel: 0.2, sarcasmLevel: 0.3, toxicityLimit: 0,
      interests: ['Dota 2'], temperature: 0.7, minimumIntervalMs: 60_000,
      __templateUsername: 'old-bot', relationships: [],
    } as unknown as BotPersona);
    const store = new PersonaStore(repository);
    await store.initialize();
    const upgraded = store.get('account-old-bot');
    expect(upgraded.name).toBe('Сохранённое имя');
    expect(upgraded.description).toBe('Сохранённое описание');
    expect(upgraded.behavior.styleInstructions).toBe('мой сохранённый стиль');
    expect(upgraded.identity.birthDate).toBeUndefined();
    expect(upgraded.source).toBe('manual');
    expect(await store.delete('missing-persona')).toBe(false);
  });

  it('does not mutate runtime state when building a dashboard preview', async () => {
    const repository = new MemoryRepository();
    const memory = new PersonaMemory(repository, { now: () => event('').timestamp });
    const runtime = new PersonaRuntimeStore(() => event('').timestamp);
    runtime.setMood('maxim', 'tired', 0.2);
    const builder = new PersonaContextBuilder(memory, runtime);
    await builder.build({
      username: 'bot-maxim', persona: person('maxim', 'Максим', 'Караганда', 'Сергей'),
      event: event('сильное событие', ['bot-maxim']), recentMessages: [], directMention: true,
      observeRuntime: false,
    });
    expect(runtime.peek('maxim')).toMatchObject({ mood: 'tired', engagement: 0.2, sessionMessageCount: 0 });
  });
});
