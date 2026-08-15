import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { PersonaMemory } from '../src/personas/persona-memory';

describe('PersonaMemory.recall (Persona Drive spontaneous recall)', () => {
  async function harness(random: () => number = () => 0.5) {
    const repository = new MemoryRepository();
    await repository.initialize();
    let now = 1_000_000_000_000;
    const memory = new PersonaMemory(repository, { now: () => now, random });
    return { memory, setNow: (value: number) => { now = value; } };
  }

  it('excludes expired memories', async () => {
    const { memory, setNow } = await harness();
    setNow(1_000_000_000_000);
    await memory.remember({
      personaId: 'p1', type: 'self', summary: 'истёкшая память', importance: 0.9, tags: [],
      expiresAt: 1_000_000_000_000 + 10_000,
    });
    setNow(1_000_000_000_000 + 20_000);
    expect(await memory.recall('p1', { minAgeMs: 0 })).toEqual([]);
  });

  it('excludes very-recent memories by default, then includes them once old enough', async () => {
    const { memory, setNow } = await harness();
    setNow(1_000_000_000_000);
    await memory.remember({ personaId: 'p1', type: 'self', summary: 'только что', importance: 0.9, tags: [] });
    setNow(1_000_000_000_000 + 5_000);
    expect(await memory.recall('p1')).toEqual([]);
    setNow(1_000_000_000_000 + 70_000);
    const recalled = await memory.recall('p1');
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.summary).toBe('только что');
  });

  it('excludes viewer-tagged memories only when excludeViewerTagged is set', async () => {
    const { memory, setNow } = await harness();
    setNow(1_000_000_000_000);
    await memory.remember({
      personaId: 'p1', type: 'viewer', summary: 'личное про Васю', importance: 0.9, tags: [], viewerUsername: 'vasya',
    });
    await memory.remember({ personaId: 'p1', type: 'self', summary: 'обычная память', importance: 0.9, tags: [] });
    setNow(1_000_000_000_000 + 120_000);
    const excluded = await memory.recall('p1', { excludeViewerTagged: true });
    expect(excluded.map((item) => item.summary)).toEqual(['обычная память']);
    const included = await memory.recall('p1', { excludeViewerTagged: false });
    expect(included).toHaveLength(2);
  });

  it('never returns another persona\'s memories', async () => {
    const { memory, setNow } = await harness();
    setNow(1_000_000_000_000);
    await memory.remember({ personaId: 'p1', type: 'self', summary: 'память p1', importance: 0.9, tags: [] });
    await memory.remember({ personaId: 'p2', type: 'self', summary: 'память p2', importance: 0.9, tags: [] });
    setNow(1_000_000_000_000 + 120_000);
    const recalled = await memory.recall('p1');
    expect(recalled.map((item) => item.personaId)).toEqual(['p1']);
  });

  it('lets a high-importance old memory outrank a low-importance fresh one — recency is a tie-breaker, not the ranking', async () => {
    const { memory, setNow } = await harness(() => 0);
    setNow(1_000_000_000_000);
    await memory.remember({ personaId: 'p1', type: 'self', summary: 'старая важная память', importance: 0.95, tags: [] });
    setNow(1_000_000_000_000 + 10 * 60 * 60_000);
    await memory.remember({ personaId: 'p1', type: 'self', summary: 'свежая неважная память', importance: 0.1, tags: [] });
    setNow(1_000_000_000_000 + 10 * 60 * 60_000 + 120_000);
    const recalled = await memory.recall('p1', { limit: 1 });
    expect(recalled[0]?.summary).toBe('старая важная память');
  });

  it('deprioritizes a memory recalled moments ago so the same thought does not resurface every tick', async () => {
    const { memory, setNow } = await harness(() => 0);
    setNow(1_000_000_000_000);
    await memory.remember({ personaId: 'p1', type: 'self', summary: 'память A', importance: 0.9, tags: [] });
    await memory.remember({ personaId: 'p1', type: 'self', summary: 'память B', importance: 0.85, tags: [] });
    setNow(1_000_000_000_000 + 120_000);
    const first = await memory.recall('p1', { limit: 1 });
    expect(first[0]?.summary).toBe('память A');
    setNow(1_000_000_000_000 + 130_000);
    const second = await memory.recall('p1', { limit: 1 });
    expect(second[0]?.summary).toBe('память B');
  });

  it('returns an empty array — a fully valid outcome — when nothing is eligible', async () => {
    const { memory } = await harness();
    expect(await memory.recall('unknown-persona')).toEqual([]);
  });
});
