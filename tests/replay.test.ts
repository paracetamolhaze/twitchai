import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { generatePersonaV3 } from '../src/personas/generator-v3';
import { seedMind } from '../src/personas/persona-mind';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { StreamEvent } from '../src/stream-brain/types';
import { readOnlyRepository, runReplay } from '../src/tools/replay';

const NOW = 1_700_000_000_000;

function streamEvent(id: string, overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    id, timestamp: NOW, type: 'conversation',
    summary: 'стример обсуждает цены на аренду жилья в Шанхае',
    speech: 'стример обсуждает цены на аренду жилья в Шанхае',
    importance: 0.6, confidence: 0.9, source: 'transcription', directMentions: [], ...overrides,
  };
}

async function seededRepository(): Promise<MemoryRepository> {
  const repository = new MemoryRepository();
  await repository.initialize();
  const persona = generatePersonaV3('karlbekner');
  await repository.upsertPersona(persona);
  await repository.upsertBot({
    username: 'karlbekner', personaId: persona.id, enabled: true,
    connectionState: 'CONNECTED', chatConnected: true, messagesSent: 0,
  });
  await repository.savePersonaMind(seedMind(persona, 'karlbekner', NOW));
  await repository.saveStreamEvent(streamEvent('event-1'));
  await repository.saveStreamEvent(streamEvent('event-2', {
    timestamp: NOW + 60_000,
    summary: 'S: час в компьютерном клубе стоит 30 юаней',
    speech: 'S: час в компьютерном клубе стоит 30 юаней',
  }));
  return repository;
}

describe('fixture M — the read-only wall', () => {
  it('replaces every mutating repository method with a throw', async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const guarded = readOnlyRepository(repository);
    await expect(guarded.savePersonaMind({} as never)).rejects.toThrow('replay_write_blocked:savePersonaMind');
    await expect(guarded.saveStreamEvent({} as never)).rejects.toThrow('replay_write_blocked:saveStreamEvent');
    await expect(guarded.upsertPersona({} as never)).rejects.toThrow('replay_write_blocked:upsertPersona');
    await expect(guarded.deletePersonaMind('x')).rejects.toThrow('replay_write_blocked:deletePersonaMind');
    await expect(guarded.setSettings({})).rejects.toThrow('replay_write_blocked:setSettings');
    // initialize is blocked too: on Postgres it runs migrations, which is a write path.
    await expect(guarded.initialize()).rejects.toThrow('replay_write_blocked:initialize');
  });

  it('lets reads through untouched', async () => {
    const repository = await seededRepository();
    const guarded = readOnlyRepository(repository);
    expect(await guarded.listPersonas()).toHaveLength(1);
    expect(await guarded.listStreamEvents(10)).toHaveLength(2);
  });

  it('a full replay run performs zero writes against the supplied repository', async () => {
    const repository = await seededRepository();
    const saveMind = vi.spyOn(repository, 'savePersonaMind');
    const saveEvent = vi.spyOn(repository, 'saveStreamEvent');
    const saveMessage = vi.spyOn(repository, 'saveBotMessage');
    const result = await runReplay({ repository, limit: 10 });
    expect(result.events).toBe(2);
    // Observation DID mutate minds — the sandbox copies, never the repository handed in.
    expect(result.observation.considered).toBeGreaterThan(0);
    expect(saveMind).not.toHaveBeenCalled();
    expect(saveEvent).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
  });
});

describe('fixture L — deterministic replay', () => {
  it('the same stored evening replays to the identical report, twice', async () => {
    const first = await runReplay({ repository: await seededRepository(), limit: 10 });
    const second = await runReplay({ repository: await seededRepository(), limit: 10 });
    expect(second).toEqual(first);
    expect(first.events).toBe(2);
  });

  it('runs events oldest first and reports validated provenance for the mock brain', async () => {
    const result = await runReplay({ repository: await seededRepository(), limit: 10 });
    expect(result.outcomes.map((outcome) => outcome.eventId)).toEqual(['event-1', 'event-2']);
    for (const outcome of result.outcomes) {
      for (const reaction of outcome.reactions) {
        // The mock claims only sources the payload actually supplied, so a rejection here would
        // mean provenance validation and payload construction disagree — the bug this pins.
        expect(reaction.outcome).not.toBe('invalid_motive_source');
      }
    }
  });
});

describe('fixture M — no send path exists at all', () => {
  it('the replay modules never import Twitch, senders, or the bot manager', () => {
    for (const file of ['replay.ts', 'replay-cli.ts']) {
      const source = readFileSync(join(__dirname, '..', 'src', 'tools', file), 'utf-8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]!);
      for (const specifier of imports) {
        expect(specifier).not.toMatch(/twitch/i);
        expect(specifier).not.toMatch(/bot-manager/i);
        expect(specifier).not.toMatch(/reaction-coordinator/i);
      }
      expect(source).not.toMatch(/\btmi\b/);
    }
  });
});
