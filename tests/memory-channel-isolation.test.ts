import { describe, expect, it } from 'vitest';
import { PersonaMemory } from '../src/personas/persona-memory';
import { MemoryRepository } from '../src/persistence/memory-repository';

describe('channel-scoped persona memory', () => {
  it('isolates retrieval, initiative and conversations, including across restart', async () => {
    const repository = new MemoryRepository();
    let channel = 'first';
    const options = { channel: () => channel, now: () => 1_800_000_000_000, random: () => 0 };
    const memory = new PersonaMemory(repository, options);
    await memory.remember({ personaId: 'p1', type: 'streamer', summary: 'любит шахматы', importance: 0.9, tags: [] });
    await memory.addConversation({ personaId: 'p1', viewerUsername: 'viewer', role: 'viewer', message: 'шахматы?' });
    channel = 'second';
    expect(await memory.retrieve('p1', 'шахматы')).toEqual([]);
    expect(await memory.recall('p1', { minAgeMs: 0 })).toEqual([]);
    expect(await memory.conversation('p1', 'viewer')).toEqual([]);
    expect(await memory.recentConversationPersonaIds('viewer')).toEqual([]);
    expect(await memory.list('p1')).toEqual([]);
    channel = ' FIRST ';
    const restarted = new PersonaMemory(repository, options);
    expect(await restarted.retrieve('p1', 'шахматы')).toHaveLength(1);
    expect(await restarted.conversation('p1', 'viewer')).toHaveLength(1);
  });

  it('does not assign old unscoped records to the current channel', async () => {
    const repository = new MemoryRepository();
    await new PersonaMemory(repository).remember({ personaId: 'p1', type: 'streamer', summary: 'старый факт', importance: 0.9, tags: [] });
    const scoped = new PersonaMemory(repository, { channel: () => 'current' });
    expect(await scoped.retrieve('p1', 'старый факт')).toEqual([]);
    expect(await scoped.recall('p1', { minAgeMs: 0 })).toEqual([]);
    expect(await repository.listPersonaMemories('p1', 200)).toHaveLength(1);
  });
});
