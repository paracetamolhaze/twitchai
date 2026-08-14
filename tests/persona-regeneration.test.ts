import { describe, expect, it } from 'vitest';
import { PersonaStore } from '../src/personas/persona-store';
import { BotPersona } from '../src/personas/types';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { generatePersonaV3, personaGenerationFingerprint } from '../src/personas/generator-v3';

class FailingBulkRepository extends MemoryRepository {
  override async replacePersonasWithBackups(): Promise<void> {
    throw new Error('atomic_bulk_write_failed');
  }
}

describe('persona regeneration', () => {
  it('backs up legacy generated canon and preserves operator overrides through preview/apply', async () => {
    const repository = new MemoryRepository();
    await repository.upsertPersona({
      id: 'account-karlbekner', name: 'Спокойный аналитик · karlbekner', description: 'Старый шаблон',
      identity: { nickname: 'karlbekner' }, styleInstructions: 'пиши спокойно', relationships: [],
      __templateUsername: 'karlbekner',
    } as unknown as BotPersona);
    await repository.upsertBot({
      username: 'karlbekner', personaId: 'account-karlbekner', enabled: true,
      connectionState: 'DISCONNECTED', chatConnected: false, messagesSent: 0,
    });

    const store = new PersonaStore(repository);
    await store.initialize();
    const staged = store.get('account-karlbekner');
    expect(staged.name).toBe('Спокойный аналитик · karlbekner');
    expect(staged.legacyManualReviewRequired).toBe(true);
    expect(await repository.listPersonaCanonBackups(staged.id, 10)).toHaveLength(1);

    staged.description = 'Ручная заметка, добавленная оператором до перехода на v3';
    const reviewedLegacy = await store.update(staged);
    expect(reviewedLegacy.generationVersion).toBe(0);
    expect(reviewedLegacy.manualOverrides).toContain('description');

    const migrationPreview = await store.previewRegeneration(staged.id);
    expect(migrationPreview.legacyManualReviewRequired).toBe(true);
    expect(migrationPreview.proposed.description).toBe('Ручная заметка, добавленная оператором до перехода на v3');
    const migrated = await store.regenerate(staged.id, migrationPreview.previewHash);
    expect(migrated.identity).toMatchObject({ firstName: 'Константин', preferredName: 'Костя', nickname: 'karlbekner' });
    expect(migrated.generationVersion).toBe(3);
    expect(migrated.legacyManualReviewRequired).toBe(false);

    migrated.identity.preferredName = 'Костян';
    migrated.opinions[0] = { ...migrated.opinions[0]!, stance: 'ручная формулировка оператора' };
    const edited = await store.update(migrated);
    expect(edited.manuallyEdited).toBe(true);
    expect(edited.manualOverrides).toEqual(expect.arrayContaining(['identity.preferredName', 'opinions']));

    const preview = await store.previewRegeneration(migrated.id);
    expect(preview.proposed.identity.preferredName).toBe('Костян');
    expect(preview.proposed.opinions[0]?.stance).toBe('ручная формулировка оператора');
    const applied = await store.regenerate(migrated.id, preview.previewHash);
    expect(applied.identity.preferredName).toBe('Костян');
    expect(applied.manualOverrides).toEqual(edited.manualOverrides);
    expect(await repository.listPersonaCanonBackups(migrated.id, 10)).toHaveLength(2);
  });

  it('validates every bulk preview before writing any persona', async () => {
    const repository = new MemoryRepository();
    const first = generatePersonaV3('gigantiuz');
    const second = generatePersonaV3('supercser2');
    const unassigned = generatePersonaV3('karlbekner');
    await repository.upsertPersona(first);
    await repository.upsertPersona(second);
    await repository.upsertPersona(unassigned);
    await repository.upsertBot({ username: 'gigantiuz', personaId: first.id, enabled: true, connectionState: 'DISCONNECTED', chatConnected: false, messagesSent: 0 });
    await repository.upsertBot({ username: 'supercser2', personaId: second.id, enabled: true, connectionState: 'DISCONNECTED', chatConnected: false, messagesSent: 0 });
    const store = new PersonaStore(repository);
    await store.initialize();
    const previews = await store.previewAllRegenerations();
    expect(previews.map((preview) => preview.personaId).sort()).toEqual([first.id, second.id].sort());
    const before = personaGenerationFingerprint(store.get(first.id));

    await expect(store.regenerateAll([
      { personaId: previews[0]!.personaId, previewHash: previews[0]!.previewHash },
      { personaId: previews[1]!.personaId, previewHash: '0'.repeat(64) },
    ])).rejects.toThrow('persona_regeneration_preview_stale');

    expect(personaGenerationFingerprint(store.get(first.id))).toBe(before);
    expect(await repository.listPersonaCanonBackups(first.id, 10)).toEqual([]);
  });

  it('keeps the full cohort unchanged when the atomic bulk write fails', async () => {
    const repository = new FailingBulkRepository();
    const first = generatePersonaV3('gigantiuz');
    const second = generatePersonaV3('supercser2');
    first.description = 'Устаревшая первая биография для проверки транзакции';
    second.description = 'Устаревшая вторая биография для проверки транзакции';
    await repository.upsertPersona(first);
    await repository.upsertPersona(second);
    await repository.upsertBot({ username: 'gigantiuz', personaId: first.id, enabled: true, connectionState: 'DISCONNECTED', chatConnected: false, messagesSent: 0 });
    await repository.upsertBot({ username: 'supercser2', personaId: second.id, enabled: true, connectionState: 'DISCONNECTED', chatConnected: false, messagesSent: 0 });

    const store = new PersonaStore(repository);
    await store.initialize();
    const previews = await store.previewAllRegenerations();
    expect(previews.every((preview) => preview.changed)).toBe(true);
    const beforeFirst = store.get(first.id);
    const beforeSecond = store.get(second.id);

    await expect(store.regenerateAll(previews.map((preview) => ({
      personaId: preview.personaId,
      previewHash: preview.previewHash,
    })))).rejects.toThrow('atomic_bulk_write_failed');

    expect(store.get(first.id)).toEqual(beforeFirst);
    expect(store.get(second.id)).toEqual(beforeSecond);
    expect(await repository.listPersonaCanonBackups(first.id, 10)).toEqual([]);
    expect(await repository.listPersonaCanonBackups(second.id, 10)).toEqual([]);
  });

  it('does not auto-migrate a manually edited generated persona at startup', async () => {
    const repository = new MemoryRepository();
    const edited = generatePersonaV3('darwinboo2');
    edited.generationVersion = 2;
    edited.description = 'Ручной канон из предыдущей версии';
    edited.identity.firstName = 'Ручное имя';
    edited.manuallyEdited = true;
    edited.manualOverrides = [];
    await repository.upsertPersona(edited);
    await repository.upsertBot({ username: 'darwinboo2', personaId: edited.id, enabled: true, connectionState: 'DISCONNECTED', chatConnected: false, messagesSent: 0 });

    const store = new PersonaStore(repository);
    await store.initialize();

    const preserved = store.get(edited.id);
    expect(preserved.generationVersion).toBe(2);
    expect(preserved.description).toBe('Ручной канон из предыдущей версии');
    expect(preserved.identity.firstName).toBe('Ручное имя');
    expect(await repository.listPersonaCanonBackups(edited.id, 10)).toEqual([]);

    const preview = await store.previewRegeneration(edited.id);
    expect(preview.changed).toBe(true);
    expect(preview.requiresIndividualConfirmation).toBe(true);
  });

  it('requires individual confirmation before bulk regeneration can replace a sensitive manual canon', async () => {
    const repository = new MemoryRepository();
    const edited = generatePersonaV3('darwinboo2');
    edited.identity.firstName = 'Ручное имя';
    edited.description = 'устаревшее описание для проверки preview';
    edited.manuallyEdited = true;
    edited.manualOverrides = ['identity.firstName'];
    await repository.upsertPersona(edited);
    await repository.upsertBot({ username: 'darwinboo2', personaId: edited.id, enabled: true, connectionState: 'DISCONNECTED', chatConnected: false, messagesSent: 0 });

    const store = new PersonaStore(repository);
    await store.initialize();
    const preview = await store.previewRegeneration(edited.id);

    expect(preview.changed).toBe(true);
    expect(preview.requiresIndividualConfirmation).toBe(true);
    await expect(store.regenerateAll([{ personaId: preview.personaId, previewHash: preview.previewHash }]))
      .rejects.toThrow('persona_regeneration_requires_individual_confirmation');
    expect(store.get(edited.id).identity.firstName).toBe('Ручное имя');
    expect(await repository.listPersonaCanonBackups(edited.id, 10)).toEqual([]);
  });
});
