import { AppRepository } from '../persistence/repository';
import { DEFAULT_PERSONAS, personaTemplateForUsername } from './defaults';
import { createBlankPersona, personaSchema, personaSummary, upgradePersona } from './schema';
import { BotPersona, PersonaSummary } from './types';

export class PersonaStore {
  private readonly personas = new Map<string, BotPersona>();

  constructor(private readonly repository: AppRepository) {}

  async initialize(): Promise<void> {
    const stored = await this.repository.listPersonas();
    for (const persona of DEFAULT_PERSONAS) this.personas.set(persona.id, structuredClone(persona));
    for (const [index, raw] of stored.entries()) {
      const legacyTemplateUsername = record(raw).__templateUsername;
      const persona = typeof legacyTemplateUsername === 'string' && legacyTemplateUsername.trim()
        ? mergeTemplateWithLegacy(personaTemplateForUsername(legacyTemplateUsername, index), raw, index)
        : upgradePersona(raw, index);
      const relationships = await this.repository.listPersonaRelationships(persona.id);
      if (relationships.length) persona.relationships = relationships;
      this.personas.set(persona.id, persona);
    }

    for (const persona of this.personas.values()) {
      persona.relationships = persona.relationships.filter((relationship) =>
        relationship.targetPersonaId !== persona.id && this.personas.has(relationship.targetPersonaId));
    }

    // Persist both missing demos and backward-compatible JSON upgrades. This is
    // the only automatic canon migration; normal chat/memory never calls update.
    await Promise.all([...this.personas.values()].map((persona) => this.persist(persona)));
  }

  list(): BotPersona[] {
    return [...this.personas.values()]
      .sort((left, right) => left.name.localeCompare(right.name, 'ru'))
      .map((persona) => structuredClone(persona));
  }

  summaries(): PersonaSummary[] { return this.list().map((persona) => personaSummary(persona)); }

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
      relationships: [],
    });
  }

  async ensureUniqueForAccount(username: string, preferredId: string | undefined, usedPersonaIds: Set<string>): Promise<BotPersona> {
    const preferred = preferredId ? this.getOptional(preferredId) : undefined;
    if (preferred && !usedPersonaIds.has(preferred.id)) return preferred;
    const created = await this.createTemplate(username);
    return created;
  }

  async update(input: unknown): Promise<BotPersona> {
    const persona = personaSchema.parse(input);
    if (!this.personas.has(persona.id)) throw new Error('persona_not_found');
    this.validateRelationships(persona);
    const previous = this.personas.get(persona.id)!;
    this.personas.set(persona.id, structuredClone(persona));
    try { await this.persist(persona); }
    catch (error) { this.personas.set(previous.id, previous); throw error; }
    return structuredClone(persona);
  }

  async delete(id: string): Promise<boolean> {
    if (!this.personas.has(id)) return false;
    if (DEFAULT_PERSONAS.some((persona) => persona.id === id)) throw new Error('persona_builtin');
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
    return true;
  }

  private async persist(persona: BotPersona): Promise<void> {
    await this.repository.upsertPersona(persona);
  }

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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mergeTemplateWithLegacy(template: BotPersona, legacy: unknown, fallbackIndex: number): BotPersona {
  const raw = record(legacy);
  const withoutMarker = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== '__templateUsername'));
  const upgraded = upgradePersona(withoutMarker, fallbackIndex);
  const savedName = typeof raw.name === 'string' ? raw.name.trim() : '';
  const identity = has(raw, 'identity')
    ? upgraded.identity
    : savedName
      ? { ...template.identity, firstName: savedName.split(/\s+/)[0] }
      : template.identity;
  return personaSchema.parse({
    ...structuredClone(template),
    id: upgraded.id,
    name: upgraded.name,
    description: upgraded.description,
    identity,
    family: has(raw, 'family') ? upgraded.family : template.family,
    timeline: has(raw, 'timeline') ? upgraded.timeline : template.timeline,
    facts: has(raw, 'facts') ? upgraded.facts : template.facts,
    opinions: has(raw, 'opinions') ? upgraded.opinions : template.opinions,
    knowledge: has(raw, 'knowledge') ? upgraded.knowledge : template.knowledge,
    character: has(raw, 'character')
      ? upgraded.character
      : { ...template.character, summary: upgraded.character.summary },
    interests: has(raw, 'interests') ? upgraded.interests : template.interests,
    speech: has(raw, 'speech') ? upgraded.speech : template.speech,
    // Legacy behavior lived at the top level. upgradePersona maps those saved
    // values before the template fills the unrelated biography sections.
    behavior: upgraded.behavior,
    streamerRelationship: has(raw, 'streamerRelationship')
      ? upgraded.streamerRelationship
      : template.streamerRelationship,
    relationships: has(raw, 'relationships') ? upgraded.relationships : template.relationships,
  });
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
