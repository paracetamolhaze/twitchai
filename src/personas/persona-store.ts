import { createHash, timingSafeEqual } from 'node:crypto';
import { AppRepository } from '../persistence/repository';
import { personaTemplateForUsername } from './defaults';
import { generatePersonaV3 } from './generator-v3';
import { auditPersonas, auditedPersonaSummaries, validatePersonaCoherence } from './persona-quality';
import { createBlankPersona, personaCompleteness, personaSchema, personaSummary, upgradePersona } from './schema';
import {
  BotPersona,
  PERSONA_EDITABLE_PATHS,
  PERSONA_GENERATION_VERSION,
  PersonaAuditReport,
  PersonaEditablePath,
  PersonaSummary,
} from './types';

export interface PersonaRegenerationPreview {
  personaId: string;
  username: string;
  current: BotPersona;
  proposed: BotPersona;
  previewHash: string;
  preservedManualOverrides: PersonaEditablePath[];
  legacyManualReviewRequired: boolean;
}

export type PersonaAssignmentProblem = 'persona_username_mismatch' | 'persona_incomplete';

export class PersonaStore {
  private readonly personas = new Map<string, BotPersona>();
  private readonly accountByPersonaId = new Map<string, string>();

  constructor(private readonly repository: AppRepository, private readonly now: () => number = Date.now) {}

  async initialize(): Promise<void> {
    const stored = await this.repository.listPersonas();
    const rawById = new Map<string, unknown>();
    for (const [index, raw] of stored.entries()) {
      const persona = upgradePersona(raw, index);
      rawById.set(persona.id, raw);
      const relationships = await this.repository.listPersonaRelationships(persona.id);
      if (relationships.length) persona.relationships = relationships;
      this.personas.set(persona.id, persona);
    }

    const bots = await this.repository.listBots();
    for (const bot of bots) {
      const username = normalizeUsername(bot.username);
      this.accountByPersonaId.set(bot.personaId, username);
      const current = this.personas.get(bot.personaId);
      const raw = rawById.get(bot.personaId);
      if (current && shouldAutoMigrateGeneratedPersona(raw, current)) {
        const generated = this.generatedWithManualOverrides(current, username);
        await this.backup(current, username, 'automatic-generation-v3-migration');
        await this.persist(generated);
        this.personas.set(generated.id, generated);
      } else if (current && isUnversionedLegacyGeneratedPersona(raw, current, username)) {
        const staged = personaSchema.parse({
          ...current,
          source: 'generated',
          generatedFromUsername: username,
          legacyManualReviewRequired: true,
        });
        await this.backup(current, username, 'generation-v3-manual-review-staged');
        await this.persist(staged);
        this.personas.set(staged.id, staged);
      }
    }

    for (const persona of this.personas.values()) {
      persona.relationships = persona.relationships.filter((relationship) =>
        relationship.targetPersonaId !== persona.id && this.personas.has(relationship.targetPersonaId));
      await this.persist(persona);
    }
  }

  list(): BotPersona[] {
    return [...this.personas.values()]
      .sort((left, right) => left.name.localeCompare(right.name, 'ru'))
      .map((persona) => structuredClone(persona));
  }

  summaries(): PersonaSummary[] {
    const entries = this.list().map((persona) => ({ username: this.accountByPersonaId.get(persona.id), persona }));
    return auditedPersonaSummaries(entries, (persona) => personaSummary(persona));
  }

  audit(): PersonaAuditReport {
    const assigned = this.list()
      .flatMap((persona) => this.accountByPersonaId.has(persona.id)
        ? [{ username: this.accountByPersonaId.get(persona.id), persona }]
        : []);
    return auditPersonas(assigned.length ? assigned : this.list().map((persona) => ({ persona })));
  }

  has(id: string): boolean { return this.personas.has(id); }

  get(id: string): BotPersona {
    const persona = this.personas.get(id);
    if (!persona) throw new Error(`Persona ${id} not found`);
    return structuredClone(persona);
  }

  getOptional(id: string): BotPersona | undefined {
    const persona = this.personas.get(id);
    return persona ? structuredClone(persona) : undefined;
  }

  registerAssignment(username: string, personaId: string): void {
    this.accountByPersonaId.set(personaId, normalizeUsername(username));
  }

  unregisterAssignment(personaId: string): void { this.accountByPersonaId.delete(personaId); }

  assignmentProblem(username: string, personaId: string): PersonaAssignmentProblem | undefined {
    const persona = this.get(personaId);
    const normalized = normalizeUsername(username);
    if (persona.identity.nickname?.toLowerCase() !== normalized) return 'persona_username_mismatch';
    if (persona.source === 'generated' && persona.generatedFromUsername !== normalized) return 'persona_username_mismatch';
    if (persona.legacyManualReviewRequired) return undefined;
    if (personaCompleteness(persona) < 85
      || validatePersonaCoherence(persona).some((issue) => issue.severity === 'error')) return 'persona_incomplete';
    return undefined;
  }

  async create(input: unknown): Promise<BotPersona> {
    const persona = personaSchema.parse(input);
    if (this.personas.has(persona.id)) throw new Error('persona_already_exists');
    this.validateRelationships(persona);
    this.personas.set(persona.id, structuredClone(persona));
    try { await this.persist(persona); }
    catch (error) { this.personas.delete(persona.id); throw error; }
    return structuredClone(persona);
  }

  async createBlank(id: string, name?: string): Promise<BotPersona> {
    return this.create(createBlankPersona(id, name));
  }

  async createTemplate(username: string, requestedId?: string): Promise<BotPersona> {
    const candidate = personaTemplateForUsername(username, this.personas.size);
    const id = requestedId ? normalizeId(requestedId) : uniqueId(candidate.id, this.personas);
    return this.create({ ...candidate, id });
  }

  async duplicate(sourceId: string, id: string, name: string): Promise<BotPersona> {
    const source = this.get(sourceId);
    return this.create({
      ...source,
      id: normalizeId(id),
      name: name.trim(),
      description: `${source.description} Копия создана оператором и должна быть дополнительно персонализирована.`,
      source: 'manual',
      generatedFromUsername: undefined,
      manuallyEdited: true,
      manualOverrides: [],
      legacyManualReviewRequired: false,
      relationships: [],
    });
  }

  async ensureUniqueForAccount(username: string, preferredId: string | undefined, usedPersonaIds: Set<string>): Promise<BotPersona> {
    const preferred = preferredId ? this.getOptional(preferredId) : undefined;
    if (preferred && !usedPersonaIds.has(preferred.id)) {
      this.registerAssignment(username, preferred.id);
      return preferred;
    }
    let created: BotPersona;
    try {
      created = await this.createTemplate(username);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'persona_blueprint_not_found') throw error;
      const normalized = normalizeUsername(username);
      const id = uniqueId(normalizeId(`account-${normalized}`), this.personas);
      const placeholder = createBlankPersona(id, `Новая личность · ${normalized}`);
      placeholder.identity.nickname = normalized;
      placeholder.description = `Ручной профиль для Twitch-аккаунта ${normalized}. Автогенерация не применена: для этого username ещё нет проверенного индивидуального blueprint.`;
      created = await this.create(placeholder);
    }
    this.registerAssignment(username, created.id);
    return created;
  }

  async update(input: unknown): Promise<BotPersona> {
    const submitted = personaSchema.parse(input);
    const current = this.personas.get(submitted.id);
    if (!current) throw new Error('persona_not_found');
    const persona = this.withOperatorMetadata(current, submitted);
    this.validateRelationships(persona);
    this.personas.set(persona.id, structuredClone(persona));
    try { await this.persist(persona); }
    catch (error) { this.personas.set(current.id, current); throw error; }
    return structuredClone(persona);
  }

  async previewRegeneration(id: string): Promise<PersonaRegenerationPreview> {
    const current = this.get(id);
    if (current.source !== 'generated') throw new Error('persona_manual_regeneration_forbidden');
    const username = this.accountByPersonaId.get(id) ?? current.generatedFromUsername;
    if (!username) throw new Error('persona_username_not_found');
    const proposed = this.generatedWithManualOverrides(current, username);
    return {
      personaId: id,
      username,
      current,
      proposed,
      previewHash: regenerationHash(current, proposed),
      preservedManualOverrides: [...current.manualOverrides],
      legacyManualReviewRequired: current.legacyManualReviewRequired,
    };
  }

  async previewAllRegenerations(): Promise<PersonaRegenerationPreview[]> {
    const previews: PersonaRegenerationPreview[] = [];
    for (const persona of this.list()) {
      if (persona.source === 'generated' && this.accountByPersonaId.has(persona.id)) {
        previews.push(await this.previewRegeneration(persona.id));
      }
    }
    return previews;
  }

  async regenerate(id: string, previewHash: string): Promise<BotPersona> {
    const preview = await this.previewRegeneration(id);
    if (!safeEqual(preview.previewHash, previewHash)) throw new Error('persona_regeneration_preview_stale');
    await this.backup(preview.current, preview.username, 'operator-approved-generation-v3-regeneration');
    await this.persist(preview.proposed);
    this.personas.set(id, structuredClone(preview.proposed));
    return structuredClone(preview.proposed);
  }

  async regenerateAll(previews: Array<{ personaId: string; previewHash: string }>): Promise<BotPersona[]> {
    const uniqueIds = new Set(previews.map((preview) => preview.personaId));
    if (uniqueIds.size !== previews.length) throw new Error('persona_regeneration_duplicate');
    const verified: PersonaRegenerationPreview[] = [];
    for (const submitted of previews) {
      const current = await this.previewRegeneration(submitted.personaId);
      if (!safeEqual(current.previewHash, submitted.previewHash)) throw new Error('persona_regeneration_preview_stale');
      verified.push(current);
    }
    const results: BotPersona[] = [];
    for (const preview of verified) {
      await this.backup(preview.current, preview.username, 'operator-approved-generation-v3-bulk-regeneration');
      await this.persist(preview.proposed);
      this.personas.set(preview.personaId, structuredClone(preview.proposed));
      results.push(structuredClone(preview.proposed));
    }
    return results;
  }

  async delete(id: string): Promise<boolean> {
    if (!this.personas.has(id)) return false;
    if ((await this.repository.listBots()).some((bot) => bot.personaId === id)) throw new Error('persona_in_use');
    const referencing = [...this.personas.values()].filter((persona) =>
      persona.id !== id && persona.relationships.some((relationship) => relationship.targetPersonaId === id));
    for (const persona of referencing) {
      const updated = { ...persona, relationships: persona.relationships.filter((relationship) => relationship.targetPersonaId !== id) };
      this.personas.set(updated.id, updated);
      await this.persist(updated);
    }
    await this.repository.deletePersona(id);
    this.personas.delete(id);
    this.accountByPersonaId.delete(id);
    return true;
  }

  private generatedWithManualOverrides(current: BotPersona, username: string): BotPersona {
    const generated = generatePersonaV3(username, { id: current.id });
    for (const path of current.manualOverrides) applyPath(generated, current, path);
    generated.manuallyEdited = current.manualOverrides.length > 0;
    generated.manualOverrides = [...current.manualOverrides];
    generated.relationships = structuredClone(current.relationships);
    return personaSchema.parse(generated);
  }

  private withOperatorMetadata(current: BotPersona, submitted: BotPersona): BotPersona {
    if (current.source === 'manual') {
      return personaSchema.parse({
        ...submitted,
        source: 'manual',
        generatedFromUsername: undefined,
        manuallyEdited: true,
        manualOverrides: [],
        legacyManualReviewRequired: false,
      });
    }
    const username = current.generatedFromUsername ?? this.accountByPersonaId.get(current.id);
    if (!username) throw new Error('persona_username_not_found');
    if (current.legacyManualReviewRequired) {
      const newlyEdited = PERSONA_EDITABLE_PATHS.filter((path) => !sameAtPath(current, submitted, path));
      const manualOverrides = [...new Set([...current.manualOverrides, ...newlyEdited])];
      return personaSchema.parse({
        ...submitted,
        generationVersion: current.generationVersion,
        source: 'generated',
        generatedFromUsername: username,
        manuallyEdited: manualOverrides.length > 0,
        manualOverrides,
        legacyManualReviewRequired: true,
      });
    }
    const baseline = generatePersonaV3(username, { id: current.id });
    const manualOverrides = PERSONA_EDITABLE_PATHS.filter((path) => !sameAtPath(baseline, submitted, path));
    return personaSchema.parse({
      ...submitted,
      generationVersion: PERSONA_GENERATION_VERSION,
      source: 'generated',
      generatedFromUsername: username,
      manuallyEdited: manualOverrides.length > 0,
      manualOverrides,
    });
  }

  private async backup(persona: BotPersona, username: string, reason: string): Promise<void> {
    await this.repository.savePersonaCanonBackup({
      personaId: persona.id,
      username,
      reason,
      generationVersion: persona.generationVersion,
      canon: structuredClone(persona),
      createdAt: this.now(),
    });
  }

  private async persist(persona: BotPersona): Promise<void> { await this.repository.upsertPersona(persona); }

  private validateRelationships(persona: BotPersona): void {
    const targets = new Set<string>();
    for (const relationship of persona.relationships) {
      if (relationship.targetPersonaId === persona.id) throw new Error('persona_relationship_self_reference');
      if (!this.personas.has(relationship.targetPersonaId)) throw new Error('persona_relationship_target_not_found');
      if (targets.has(relationship.targetPersonaId)) throw new Error('persona_relationship_duplicate');
      targets.add(relationship.targetPersonaId);
    }
  }
}

function shouldAutoMigrateGeneratedPersona(raw: unknown, persona: BotPersona): boolean {
  return record(raw).source === 'generated'
    && !persona.legacyManualReviewRequired
    && persona.generationVersion < PERSONA_GENERATION_VERSION;
}

function isUnversionedLegacyGeneratedPersona(raw: unknown, persona: BotPersona, username: string): boolean {
  const source = record(raw).source;
  if (source === 'manual') return false;
  if (source === 'generated') return false;
  const marker = text(record(raw).__templateUsername).toLowerCase();
  const nickname = text(record(record(raw).identity).nickname).toLowerCase();
  const legacyTitle = /спокойный аналитик|сухой шутник|дружелюбный постоянник|эмоциональный фанат/iu.test(text(record(raw).name));
  return marker === username || (persona.id.startsWith('account-') && nickname === username) || legacyTitle;
}

function sameAtPath(left: BotPersona, right: BotPersona, path: PersonaEditablePath): boolean {
  return JSON.stringify(readPath(left, path)) === JSON.stringify(readPath(right, path));
}

function applyPath(target: BotPersona, source: BotPersona, path: PersonaEditablePath): void {
  const keys = path.split('.');
  let targetCursor = target as unknown as Record<string, unknown>;
  let sourceCursor = source as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    const targetValue = targetCursor[key];
    const sourceValue = sourceCursor[key];
    if (!targetValue || typeof targetValue !== 'object' || Array.isArray(targetValue)
      || !sourceValue || typeof sourceValue !== 'object' || Array.isArray(sourceValue)) return;
    targetCursor = targetValue as Record<string, unknown>;
    sourceCursor = sourceValue as Record<string, unknown>;
  }
  const leaf = keys.at(-1)!;
  const value = sourceCursor[leaf];
  if (value === undefined) delete targetCursor[leaf];
  else targetCursor[leaf] = structuredClone(value);
}

function readPath(value: BotPersona, path: PersonaEditablePath): unknown {
  let cursor: unknown = value;
  for (const key of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function regenerationHash(current: BotPersona, proposed: BotPersona): string {
  return createHash('sha256').update(JSON.stringify({ current, proposed })).digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9_]{1,50}$/.test(username)) throw new Error('invalid_twitch_username');
  return username;
}

function normalizeId(value: string): string {
  const id = value.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!id) throw new Error('invalid_persona_id');
  return id;
}

function uniqueId(base: string, personas: Map<string, BotPersona>): string {
  if (!personas.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base.slice(0, 74)}-${suffix}`;
    if (!personas.has(candidate)) return candidate;
  }
  throw new Error('persona_id_space_exhausted');
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
