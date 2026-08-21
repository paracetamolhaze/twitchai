import { describe, expect, it } from 'vitest';
import { Logger } from '../src/logger';
import { generatePersonaV3 } from '../src/personas/generator-v3';
import { PERSONA_BLUEPRINTS } from '../src/personas/generator-v3-data';
import {
  PersonaMindRecord,
  PersonaMindStore,
  seedMind,
  validateMindPopulation,
} from '../src/personas/persona-mind';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { StreamEvent } from '../src/stream-brain/types';

const logger = new Logger('TEST', 'error');
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60_000;

function streamEvent(overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    id: 'event-1', timestamp: NOW, type: 'conversation',
    summary: 'стример обсуждает квартиру в Шанхае и цены на аренду жилья',
    speech: 'стример обсуждает квартиру в Шанхае и цены на аренду жилья',
    importance: 0.6, confidence: 0.9, source: 'transcription', directMentions: [], ...overrides,
  };
}

/** A hand-built mind for retrieval tests, so fixtures control exactly what each person carries. */
function mind(username: string, overrides: Partial<PersonaMindRecord> = {}): PersonaMindRecord {
  return {
    personaId: `account-${username}`,
    username,
    seedVersion: 1,
    knowledge: [],
    curiosities: [],
    openLoops: [],
    life: [],
    people: [],
    moment: { mood: 'спокойное настроение', energy: 0.7, attention: 'watching', updatedAt: NOW },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function storeWith(minds: PersonaMindRecord[], now: () => number = () => NOW) {
  const repository = new MemoryRepository();
  await repository.initialize();
  for (const record of minds) await repository.savePersonaMind(record);
  const store = new PersonaMindStore(repository, logger, now);
  await store.load();
  return { store, repository };
}

describe('seeding a mind from the authored canon', () => {
  it('is deterministic: the same persona and seed version always produce the same mind', () => {
    const persona = generatePersonaV3('karlbekner');
    const first = seedMind(persona, 'karlbekner', NOW);
    const second = seedMind(persona, 'karlbekner', NOW);
    expect(second).toEqual(first);
  });

  it('a new seed version produces a different life, preserving the same canon-derived knowledge topics', () => {
    const persona = generatePersonaV3('karlbekner');
    const v1 = seedMind(persona, 'karlbekner', NOW, 1);
    const v2 = seedMind(persona, 'karlbekner', NOW, 2);
    expect(v2.knowledge.map((item) => item.topic)).toEqual(v1.knowledge.map((item) => item.topic));
    expect(JSON.stringify(v2.life) === JSON.stringify(v1.life)
      && JSON.stringify(v2.curiosities) === JSON.stringify(v1.curiosities)).toBe(false);
  });

  it('derives epistemic state from canon: expertise is known, weak is uncertain, unknown is unknown', () => {
    const persona = generatePersonaV3('karlbekner');
    const seeded = seedMind(persona, 'karlbekner', NOW);
    const states = new Map(seeded.knowledge.map((item) => [item.topic, item.state]));
    for (const topic of persona.knowledge.expertise.slice(0, 6)) expect(states.get(topic)).toBe('knows_well');
    for (const topic of persona.knowledge.weakTopics.slice(0, 4)) expect(states.get(topic)).toBe('uncertain');
    for (const topic of persona.knowledge.unknownTopics.slice(0, 4)) expect(states.get(topic)).toBe('unknown');
  });

  it('curiosities come from interests the person is NOT expert in — caring plus not-knowing', () => {
    const persona = generatePersonaV3('karlbekner');
    const seeded = seedMind(persona, 'karlbekner', NOW);
    for (const curiosity of seeded.curiosities) {
      expect(persona.knowledge.expertise).not.toContain(curiosity.topic);
    }
  });

  it('gives everyone an ordinary current life, and the population does not collapse into caricature', () => {
    const minds = Object.keys(PERSONA_BLUEPRINTS).map((username) =>
      seedMind(generatePersonaV3(username), username, NOW));
    expect(minds.length).toBeGreaterThanOrEqual(30);
    const verdict = validateMindPopulation(minds);
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    // Multidimensional variety, not uniqueness for its own sake: real people overlap.
    expect(verdict.metrics.knowledgeStatesPresent).toBeGreaterThanOrEqual(4);
    expect(verdict.metrics.distinctConcernKinds).toBeGreaterThanOrEqual(3);
  });
});

describe('fixture A — the same event lands on different humans differently', () => {
  it('a remote worker curious about China rent gets a slice; an uninterested local gets none; a visa-curious one gets his own', async () => {
    const remoteWorker = mind('remote_worker', {
      life: [{ id: 'l1', concern: 'думает про жизнь за границей', kind: 'plan', stage: 'active', salience: 0.8, startedAt: NOW, updatedAt: NOW }],
      curiosities: [{ id: 'c1', topic: 'аренда жилья в Китае', question: 'сколько стоит аренда жилья в Шанхае', status: 'open', strength: 0.9, createdAt: NOW, updatedAt: NOW }],
      knowledge: [{ topic: 'Китай', state: 'unknown', updatedAt: NOW }],
    });
    const local = mind('local_guy', {
      life: [{ id: 'l1', concern: 'на работе завал', kind: 'work', stage: 'active', salience: 0.7, startedAt: NOW, updatedAt: NOW }],
      knowledge: [{ topic: 'машины', state: 'knows_well', updatedAt: NOW }],
    });
    const visaCurious = mind('visa_guy', {
      curiosities: [{ id: 'c1', topic: 'визы и оформление аренды жилья иностранцу', question: 'может ли иностранец снять жильё без бюрократии', status: 'open', strength: 0.8, createdAt: NOW, updatedAt: NOW }],
    });
    const { store } = await storeWith([remoteWorker, local, visaCurious]);

    const context = store.forEvent(streamEvent(), ['remote_worker', 'local_guy', 'visa_guy']);
    expect(context).toBeDefined();
    expect(context?.byPersona.remote_worker?.join(' ')).toContain('аренда жилья в Шанхае');
    // The uninterested local is absent entirely — his silence needs no instruction.
    expect(context?.byPersona.local_guy).toBeUndefined();
    expect(context?.byPersona.visa_guy?.join(' ')).toContain('иностранец');
  });
});

describe('fixture G — no personal relevance anywhere means no mind context at all', () => {
  it('returns undefined rather than an empty block', async () => {
    const minds = ['a', 'b', 'c'].map((name) => mind(name, {
      knowledge: [{ topic: 'футбол', state: 'knows_well', updatedAt: NOW }],
    }));
    const { store } = await storeWith(minds);
    const context = store.forEvent(
      streamEvent({ summary: 'персонаж бежит по лесу', speech: 'персонаж бежит по лесу' }),
      ['a', 'b', 'c'],
    );
    expect(context).toBeUndefined();
  });
});

describe('fixture J — a knowledge-driven question the stream never suggested', () => {
  it('a networking professional gets his expertise slice on an internet-cafe event', async () => {
    const networker = mind('net_guy', {
      knowledge: [{ topic: 'сети и пинг интернет провайдеры', state: 'knows_well', updatedAt: NOW }],
    });
    const { store } = await storeWith([networker]);
    const context = store.forEvent(streamEvent({
      summary: 'стример показывает необычное интернет кафе, компьютеры и сети очень старые',
      speech: 'стример показывает необычное интернет кафе, компьютеры и сети очень старые',
    }), ['net_guy']);
    expect(context?.byPersona.net_guy?.join(' ')).toContain('разбирается');
  });
});

describe('fixture B — a knowledge gap becomes knowledge when the stream answers it', () => {
  it('closes the curiosity, records the sourced fact, and opens a callback the person can use later', async () => {
    const curious = mind('pc_guy', {
      curiosities: [{ id: 'c1', topic: 'цены в компьютерном клубе в Китае', question: 'сколько стоит час в компьютерном клубе', status: 'open', strength: 0.9, createdAt: NOW, updatedAt: NOW }],
    });
    const { store, repository } = await storeWith([curious]);
    await store.observeEvent(streamEvent({
      summary: 'S: час в компьютерном клубе стоит 30 юаней',
      speech: 'S: час в компьютерном клубе стоит 30 юаней',
    }), ['pc_guy']);

    const updated = store.byUsername('pc_guy')!;
    expect(updated.curiosities[0]?.status).toBe('answered');
    expect(updated.knowledge.find((item) => item.topic.includes('клубе'))?.note).toContain('30 юаней');
    expect(updated.openLoops[0]?.text).toContain('30 юаней');

    // Durable, not just cached: a restart reloads the same learned fact.
    const reloaded = new PersonaMindStore(repository, logger, () => NOW);
    await reloaded.load();
    expect(reloaded.byUsername('pc_guy')?.curiosities[0]?.status).toBe('answered');

    // And later the callback is retrievable when the topic comes back.
    const later = reloaded.forEvent(streamEvent({
      summary: 'стример снова в компьютерном клубе играет',
      speech: 'стример снова в компьютерном клубе играет',
    }), ['pc_guy']);
    expect(later?.byPersona.pc_guy?.join(' ')).toContain('30 юаней');
  });

  it('a topical mention without a concrete fact keeps the curiosity open', async () => {
    const curious = mind('pc_guy', {
      curiosities: [{ id: 'c1', topic: 'цены в компьютерном клубе', question: 'сколько стоит час в клубе', status: 'open', strength: 0.9, createdAt: NOW, updatedAt: NOW }],
    });
    const { store } = await storeWith([curious]);
    await store.observeEvent(streamEvent({
      summary: 'стример зашёл в компьютерный клуб посмотреть цены',
      speech: 'стример зашёл в компьютерный клуб посмотреть цены',
    }), ['pc_guy']);
    expect(store.byUsername('pc_guy')?.curiosities[0]?.status).toBe('open');
  });

  it('never bleeds one persona\'s ingestion into another', async () => {
    const curious = mind('pc_guy', {
      curiosities: [{ id: 'c1', topic: 'цены в компьютерном клубе', question: 'сколько стоит час', status: 'open', strength: 0.9, createdAt: NOW, updatedAt: NOW }],
    });
    const bystander = mind('other_guy', {
      curiosities: [{ id: 'c1', topic: 'цены в компьютерном клубе', question: 'сколько стоит час', status: 'open', strength: 0.9, createdAt: NOW, updatedAt: NOW }],
    });
    const { store } = await storeWith([curious, bystander]);
    // Only pc_guy was connected when this was said. Presence, not the reaction shortlist, decides
    // who can learn — but someone who was not in the room learns nothing either way.
    await store.observeEvent(streamEvent({ speech: 'час стоит 30 юаней', summary: 'час стоит 30 юаней' }), ['pc_guy']);
    expect(store.byUsername('pc_guy')?.curiosities[0]?.status).toBe('answered');
    expect(store.byUsername('other_guy')?.curiosities[0]?.status).toBe('open');
  });
});

describe('fixture D — relationship continuity belongs to one persona', () => {
  it('the teaser gets his relationship slice on a Stef moment; a stranger inherits nothing', async () => {
    const teaser = mind('teaser', {
      people: [{ name: 'стефан', role: 'recurring_guest', impression: 'нравится, но любит его подколоть', familiarity: 0.7, runningJoke: 'вечно объясняет по полчаса', updatedAt: NOW }],
    });
    const stranger = mind('stranger');
    const { store } = await storeWith([teaser, stranger]);
    const context = store.forEvent(streamEvent({
      summary: 'Стефан снова что-то объясняет на камеру',
      speech: 'Стефан снова что-то объясняет на камеру',
    }), ['teaser', 'stranger']);
    expect(context?.byPersona.teaser?.join(' ')).toContain('подколоть');
    expect(context?.byPersona.stranger).toBeUndefined();
  });
});

describe('fixture E and F — life goes on between sessions, causally', () => {
  it('a concern winds down, decays, and disappears with elapsed time — continuity, not a fresh random life', async () => {
    const planner = mind('planner', {
      life: [{ id: 'trip', concern: 'собирает поездку за границу', kind: 'plan', stage: 'active', salience: 0.9, startedAt: NOW, updatedAt: NOW }],
      curiosities: [{ id: 'c1', topic: 'поездка за границу', question: 'что взять в поездку', status: 'open', strength: 0.9, createdAt: NOW, updatedAt: NOW }],
    });
    let clock = NOW;
    const { store } = await storeWith([planner], () => clock);

    // While the trip is being planned, travel talk is personally salient.
    const before = store.forEvent(streamEvent({ summary: 'обсуждают поездку за границу', speech: 'обсуждают поездку за границу' }), ['planner']);
    expect(before?.byPersona.planner?.join(' ')).toContain('поездку');

    // Eleven days later the plan has run its course.
    clock = NOW + 11 * DAY;
    await store.lifeTick(clock);
    const wound = store.byUsername('planner')!.life.find((item) => item.id === 'trip');
    expect(wound?.stage).toBe('winding_down');
    expect(wound!.salience).toBeLessThan(0.9);

    clock = NOW + 14 * DAY;
    await store.lifeTick(clock);
    const done = store.byUsername('planner')!.life.find((item) => item.id === 'trip');
    expect(done === undefined || done.stage === 'done').toBe(true);
  });

  // Fixture I: renewal is a possibility, never an appointment. The old rule guaranteed a fresh
  // concern the moment the week emptied, which made every persona's life a treadmill with no quiet
  // days — the least human-like schedule there is.
  it('an emptied stretch eventually picks up a new mundane concern, but not on a guaranteed schedule', async () => {
    const empty = mind('office_guy', {
      life: [{ id: 'l1', concern: 'сдаёт отчёт', kind: 'errand', stage: 'active', salience: 0.6, startedAt: NOW, updatedAt: NOW }],
    });
    let clock = NOW;
    const { store } = await storeWith([empty], () => clock);
    let renewalDay: number | undefined;
    for (let day = 1; day <= 20 && renewalDay === undefined; day += 1) {
      clock = NOW + (30 + day) * DAY;
      await store.lifeTick(clock);
      const life = store.byUsername('office_guy')!.life;
      if (life.some((item) => item.stage === 'active')) renewalDay = day;
    }
    // Life goes on — within a few weeks something new comes up...
    expect(renewalDay).toBeDefined();
    // ...but not necessarily the same day the last concern ended: "ничего не произошло" is a
    // valid day, so a person may sit with an empty week for a while.
    expect(renewalDay!).toBeGreaterThan(1);
  });

  it('the same empty day renews some people and not others — deterministic per person, never universal', async () => {
    const names = ['renew_a', 'renew_i', 'renew_j', 'quiet_one', 'busy_one', 'worker_a'];
    const day = NOW + 40 * DAY;
    const { store } = await storeWith(names.map((name) => mind(name, { life: [] })), () => day);
    await store.lifeTick(day);
    const renewed = names.filter((name) => store.byUsername(name)!.life.some((item) => item.stage === 'active'));
    expect(renewed.length).toBeGreaterThan(0);
    expect(renewed.length).toBeLessThan(names.length);
  });

  it('the same person on different days differs in disposition, not in who they are', async () => {
    const person = mind('steady', {
      knowledge: [{ topic: 'дота', state: 'knows_well', updatedAt: NOW }],
      life: [{ id: 'l1', concern: 'обычная неделя', kind: 'social', stage: 'active', salience: 0.5, startedAt: NOW, updatedAt: NOW }],
    });
    let clock = NOW;
    const { store } = await storeWith([person], () => clock);
    const moments: string[] = [];
    for (let day = 1; day <= 6; day += 1) {
      clock = NOW + day * DAY;
      await store.lifeTick(clock);
      const state = store.byUsername('steady')!;
      moments.push(`${state.moment.mood}|${state.moment.attention}`);
      // Identity-bearing state does not drift with the weather.
      expect(state.knowledge[0]?.topic).toBe('дота');
      expect(state.knowledge[0]?.state).toBe('knows_well');
    }
    expect(new Set(moments).size).toBeGreaterThan(1);
  });

  it('life ticks are deterministic for the same day, so a restart replays identically', async () => {
    const build = () => mind('replay', {
      life: [{ id: 'l1', concern: 'выбирает наушники', kind: 'device', stage: 'active', salience: 0.7, startedAt: NOW, updatedAt: NOW }],
    });
    const first = await storeWith([build()], () => NOW + 7 * DAY);
    const second = await storeWith([build()], () => NOW + 7 * DAY);
    await first.store.lifeTick(NOW + 7 * DAY);
    await second.store.lifeTick(NOW + 7 * DAY);
    expect(second.store.byUsername('replay')).toEqual(first.store.byUsername('replay'));
  });

  it('expires an open loop that nobody came back to within two weeks', async () => {
    const holder = mind('loop_guy', {
      openLoops: [{ id: 'q1', kind: 'question_pending', text: 'так сколько стоит жильё?', status: 'open', createdAt: NOW, updatedAt: NOW }],
    });
    let clock = NOW;
    const { store } = await storeWith([holder], () => clock);
    clock = NOW + 15 * DAY;
    await store.lifeTick(clock);
    expect(store.byUsername('loop_guy')?.openLoops[0]?.status).toBe('expired');
  });
});

describe('drive slices and payload discipline', () => {
  it('forDrive surfaces only candidates carrying their own open material', async () => {
    const carrying = mind('carrying', {
      curiosities: [{ id: 'c1', topic: 'аренда', question: 'сколько стоит аренда в Шанхае', status: 'open', strength: 0.8, createdAt: NOW, updatedAt: NOW }],
    });
    const blank = mind('blank');
    const { store } = await storeWith([carrying, blank]);
    const context = store.forDrive(['carrying', 'blank']);
    expect(Object.keys(context?.byPersona ?? {})).toEqual(['carrying']);
    expect(store.forDrive(['blank'])).toBeUndefined();
  });

  it('caps every candidate at a few short lines, whatever the mind holds', async () => {
    const packed = mind('packed', {
      knowledge: Array.from({ length: 20 }, (_, index) => ({ topic: `аренда жилья тема ${index}`, state: 'unknown' as const, updatedAt: NOW })),
      curiosities: Array.from({ length: 8 }, (_, index) => ({
        id: `c${index}`, topic: 'аренда жилья', question: `вопрос про аренду ${index}`, status: 'open' as const, strength: 0.9, createdAt: NOW, updatedAt: NOW,
      })),
      life: [{ id: 'l1', concern: 'переезд и аренда жилья', kind: 'plan', stage: 'active', salience: 0.9, startedAt: NOW, updatedAt: NOW }],
    });
    const { store } = await storeWith([packed]);
    const context = store.forEvent(streamEvent(), ['packed']);
    expect(context?.byPersona.packed?.length).toBeLessThanOrEqual(4);
    const characters = JSON.stringify(context?.byPersona.packed).length;
    expect(characters).toBeLessThan(600);
  });

  it('records motives per account without leaking them anywhere near a payload', async () => {
    const { store } = await storeWith([mind('speaker')]);
    store.recordMotive('speaker', {
      motive: 'ask', sourceType: 'knowledge_gap', sourceRef: 'china_rent',
      message: 'а сколько там хата в месяц?', sourceValidated: true, validatedSourceType: 'knowledge_gap',
    });
    expect(store.lastMotives('speaker')[0]).toMatchObject({
      motive: 'ask', sourceType: 'knowledge_gap', sourceValidated: true,
    });
    expect(store.lastMotives('someone_else')).toEqual([]);
  });
});

describe('fixture A and G — observation is presence, not the reaction shortlist', () => {
  const priceEvent = () => streamEvent({
    summary: 'S: час в компьютерном клубе стоит 30 юаней',
    speech: 'S: час в компьютерном клубе стоит 30 юаней',
  });
  const clubCuriosity = () => ({
    id: 'c1', topic: 'цены в компьютерном клубе', question: 'сколько стоит час в клубе',
    status: 'open' as const, strength: 0.9, createdAt: NOW, updatedAt: NOW,
  });

  it('a persona nobody offered the floor to still learns from what was said', async () => {
    const silent = mind('silent_guy', { curiosities: [clubCuriosity()] });
    const { store } = await storeWith([silent]);
    // Present in the room; never shortlisted, never offered, never speaking.
    const stats = await store.observeEvent(priceEvent(), ['silent_guy']);
    expect(stats.considered).toBe(1);
    expect(stats.knowledgeUpdates).toBe(1);
    expect(store.byUsername('silent_guy')?.curiosities[0]?.status).toBe('answered');
  });

  it('background attention misses an ordinary moment entirely — no writes, not even noticing', async () => {
    const distracted = mind('afk_guy', {
      curiosities: [clubCuriosity()],
      moment: { mood: 'спокойное настроение', energy: 0.4, attention: 'background', updatedAt: NOW },
    });
    const { store } = await storeWith([distracted]);
    const stats = await store.observeEvent(priceEvent(), ['afk_guy']);
    expect(stats.observed).toBe(0);
    expect(stats.memoryWrites).toBe(0);
    expect(store.byUsername('afk_guy')?.curiosities[0]?.status).toBe('open');
  });

  it('hearing your own name pulls even a background watcher back', async () => {
    const distracted = mind('afk_guy', {
      curiosities: [clubCuriosity()],
      moment: { mood: 'спокойное настроение', energy: 0.4, attention: 'background', updatedAt: NOW },
    });
    const { store } = await storeWith([distracted]);
    const stats = await store.observeEvent(priceEvent(), ['afk_guy']);
    expect(stats.observed).toBe(0);
    const mentioned = await store.observeEvent(
      streamEvent({ ...priceEvent(), directMentions: ['afk_guy'] }), ['afk_guy'],
    );
    expect(mentioned.observed).toBe(1);
    expect(store.byUsername('afk_guy')?.curiosities[0]?.status).toBe('answered');
  });

  it('half-watching still catches a moment squarely about its own curiosity', async () => {
    const half = mind('half_guy', {
      curiosities: [clubCuriosity()],
      moment: { mood: 'спокойное настроение', energy: 0.5, attention: 'half_watching', updatedAt: NOW },
    });
    const { store } = await storeWith([half]);
    const stats = await store.observeEvent(priceEvent(), ['half_guy']);
    expect(stats.observed).toBe(1);
    expect(store.byUsername('half_guy')?.curiosities[0]?.status).toBe('answered');
  });

  it('noticing without storing is the common case: topical interest leaves no memory write', async () => {
    const fan = mind('dota_fan', { knowledge: [{ topic: 'Dota 2', state: 'knows_well', updatedAt: NOW }] });
    const { store } = await storeWith([fan]);
    // Registry bridge: canon says "Dota 2", the stream says «доту». No digits — nothing to store.
    const stats = await store.observeEvent(streamEvent({
      summary: 'стример решил зайти в доту на вечер', speech: 'стример решил зайти в доту на вечер',
    }), ['dota_fan']);
    expect(stats.observed).toBe(1);
    expect(stats.memoryWrites).toBe(0);
    expect(stats.observedUsernames).toEqual(['dota_fan']);
  });

  it('a pending question of their own resolves when anyone gets the concrete answer', async () => {
    const asker = mind('asker', {
      openLoops: [{ id: 'q1', kind: 'question_pending', text: 'сколько стоит час в компьютерном клубе', status: 'open', createdAt: NOW, updatedAt: NOW }],
    });
    const { store } = await storeWith([asker]);
    const stats = await store.observeEvent(priceEvent(), ['asker']);
    expect(stats.loopsResolved).toBe(1);
    expect(store.byUsername('asker')?.openLoops[0]?.status).toBe('resolved');
  });

  it('observation is deterministic: the same room and the same moment produce the same stats twice', async () => {
    const build = () => [
      mind('one', { curiosities: [clubCuriosity()] }),
      mind('two', { knowledge: [{ topic: 'Dota 2', state: 'knows_well', updatedAt: NOW }] }),
      mind('three'),
    ];
    const first = await storeWith(build());
    const second = await storeWith(build());
    const statsA = await first.store.observeEvent(priceEvent(), ['one', 'two', 'three']);
    const statsB = await second.store.observeEvent(priceEvent(), ['one', 'two', 'three']);
    expect(statsB).toEqual(statsA);
    expect(second.store.byUsername('one')).toEqual(first.store.byUsername('one'));
  });
});
