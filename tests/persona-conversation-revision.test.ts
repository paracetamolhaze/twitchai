import { describe, expect, it } from 'vitest';
import { CONVERSATION_REVISIONS, refineConversation } from '../src/personas/conversation-refinements';
import { generatePersonaV3 } from '../src/personas/generator-v3';
import { PERSONA_BLUEPRINTS } from '../src/personas/generator-v3-data';
import { PersonaStore } from '../src/personas/persona-store';
import { PersonaContextBuilder } from '../src/personas/persona-context-builder';
import { PersonaMemory } from '../src/personas/persona-memory';
import { PersonaRuntimeStore } from '../src/personas/persona-runtime-store';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { PersonaMindStore, seedMind } from '../src/personas/persona-mind';
import { Logger } from '../src/logger';

const NOW = 1_790_344_969_304;
const logger = new Logger('TEST', 'error');

describe('conversation revision deployed to existing accounts', () => {
  it('grounds a direct experience question in explicit supplied facts rather than the profession', async () => {
    const repository = new MemoryRepository();
    const builder = new PersonaContextBuilder(new PersonaMemory(repository), new PersonaRuntimeStore());
    const context = await builder.build({
      username: 'karlbekner', persona: generatePersonaV3('karlbekner'), directMention: true, recentMessages: ['они на клей идут или на сетку?'],
      event: { id: 'experience', timestamp: NOW, type: 'conversation', summary: 'S: Ты сам такие облака клеил или просто спросил?', speech: 'S: Ты сам такие облака клеил или просто спросил?', source: 'transcription', confidence: 0.9, importance: 0.7, directMentions: ['karlbekner'] },
    });
    expect(context.personalResponseGuidance).toContain('Only explicit relevantCanon or relevantMemories');
    expect(context.personalResponseGuidance).toContain('curiosity alone');
    expect(context.relevantMemories).toEqual([]);
  });
  it('migrates all 30 without changing identities, relationships, or custom grouped fields; saves one backup', async () => {
    const repository = new MemoryRepository();
    const originals = Object.keys(CONVERSATION_REVISIONS).map((username) => {
      const persona = generatePersonaV3(username);
      delete persona.conversationRevision;
      persona.speech = structuredClone(PERSONA_BLUEPRINTS[username]!.speech);
      persona.speech.avoidedExpressions.push('ручная фраза оператора');
      persona.manualOverrides = ['speech'];
      persona.manuallyEdited = true;
      return persona;
    });
    expect(originals).toHaveLength(30);
    for (const persona of originals) await repository.upsertPersona(persona);
    const store = new PersonaStore(repository, () => NOW);
    await store.initialize();
    await store.initialize();
    const builder = new PersonaContextBuilder(new PersonaMemory(repository), new PersonaRuntimeStore());
    for (const original of originals) {
      const persona = store.get(original.id);
      expect(persona.identity).toEqual(original.identity);
      expect(persona.family).toEqual(original.family);
      expect(persona.timeline).toEqual(original.timeline);
      expect(persona.relationships).toEqual(original.relationships);
      expect(persona.speech.avoidedExpressions).toContain('ручная фраза оператора');
      expect(persona.speech.messageExamples).toEqual(CONVERSATION_REVISIONS[persona.generatedFromUsername!]!.examples);
      expect(await repository.listPersonaCanonBackups(persona.id, 10)).toHaveLength(1);
      const snapshot = builder.buildBrainSnapshot(persona.generatedFromUsername!, persona);
      expect(snapshot.character).toContain(persona.character.conflictStyle);
      expect(snapshot.opinions[0]).toContain(persona.opinions[0]!.stance);
    }
  });

  it('preserves a genuinely edited voice even when the old editor marked the whole speech group', () => {
    const persona = generatePersonaV3('karlbekner');
    delete persona.conversationRevision;
    persona.manualOverrides = ['speech'];
    persona.speech.messageExamples = ['уникальный ручной пример'];
    expect(refineConversation(persona).speech.messageExamples).toEqual(['уникальный ручной пример']);
  });

  it('quarantines unsupported historical learning durably without losing correct facts or canon', async () => {
    const repository = new MemoryRepository();
    const persona = generatePersonaV3('aaaarrtyom');
    const record = seedMind(persona, 'aaaarrtyom', NOW);
    record.curiosities = [
      { id: 'bad', topic: 'hyperpop', question: 'интересно попробовать: hyperpop', status: 'answered', answer: 'Человек 30 сейчас', sourceEventId: 'bad-event', strength: 0.7, createdAt: NOW, updatedAt: NOW },
      { id: 'good', topic: 'компьютерный клуб', question: 'сколько стоит час в клубе', status: 'answered', answer: 'Час в клубе стоит 30 юаней', sourceEventId: 'good-event', strength: 0.7, createdAt: NOW, updatedAt: NOW },
    ];
    record.knowledge.push({ topic: 'hyperpop', note: 'Человек 30 сейчас', sourceEventId: 'bad-event', state: 'heard_of', updatedAt: NOW });
    record.knowledge.push({ topic: 'компьютерный клуб', note: 'Час в клубе стоит 30 юаней', sourceEventId: 'good-event', state: 'heard_of', updatedAt: NOW });
    record.openLoops.push({ id: 'loop-bad-even-0', kind: 'callback', text: 'Человек 30 сейчас', status: 'open', createdAt: NOW, updatedAt: NOW });
    await repository.savePersonaMind(record);
    const store = new PersonaMindStore(repository, logger, () => NOW);
    await store.load();
    await store.ensureSeeded([{ username: 'aaaarrtyom', persona }]);
    await store.load();
    const updated = store.byUsername('aaaarrtyom')!;
    expect(updated.quarantinedLearning).toHaveLength(1);
    expect(updated.quarantinedLearning![0]!.curiosity.answer).toBe('Человек 30 сейчас');
    expect(updated.curiosities[0]!.status).toBe('open');
    expect(updated.knowledge.some((item) => item.sourceEventId === 'bad-event')).toBe(false);
    expect(updated.openLoops).toHaveLength(0);
    expect(updated.knowledge.some((item) => item.sourceEventId === 'good-event')).toBe(true);
    expect(updated.knowledge.some((item) => item.state === 'knows_well')).toBe(true);
  });

  it('replaces legacy shared life templates once and keeps individual renewal after a month', async () => {
    const repository = new MemoryRepository();
    const candidates = Object.keys(CONVERSATION_REVISIONS).map((username) => ({ username, persona: generatePersonaV3(username) }));
    for (const { username, persona } of candidates) {
      const record = seedMind(persona, username, NOW);
      record.life = [{ id: 'old', kind: 'device', concern: 'что-то из техники начало барахлить', stage: 'active', salience: 0.7, startedAt: NOW, updatedAt: NOW }];
      await repository.savePersonaMind(record);
    }
    const store = new PersonaMindStore(repository, logger, () => NOW);
    await store.load();
    await store.ensureSeeded(candidates);
    const concerns = candidates.map(({ username }) => store.byUsername(username)!.life[0]!.concern);
    expect(new Set(concerns).size).toBeGreaterThan(20);
    await store.ensureSeeded(candidates);
    for (const { username } of candidates) expect(store.byUsername(username)!.retiredLife).toHaveLength(1);
    for (let day = 30; day < 50; day += 1) await store.lifeTick(NOW + day * 86_400_000);
    for (const { username } of candidates) {
      for (const concern of store.byUsername(username)!.life) {
        expect(CONVERSATION_REVISIONS[username]!.life).toContain(concern.concern);
      }
    }
  });
});
