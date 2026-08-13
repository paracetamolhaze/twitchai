import { AppRepository } from '../persistence/repository';
import { DEFAULT_PERSONAS, personaForIndex } from './defaults';
import { BotPersona } from './types';

export class PersonaStore {
  private readonly personas = new Map<string, BotPersona>();

  constructor(private readonly repository: AppRepository) {}

  async initialize(): Promise<void> {
    const stored = await this.repository.listPersonas();
    for (const persona of DEFAULT_PERSONAS) this.personas.set(persona.id, persona);
    for (const persona of stored) this.personas.set(persona.id, persona);
    const storedIds = new Set(stored.map((persona) => persona.id));
    await Promise.all(DEFAULT_PERSONAS
      .filter((persona) => !storedIds.has(persona.id))
      .map((persona) => this.repository.upsertPersona(persona)));
  }

  list(): BotPersona[] { return [...this.personas.values()].map((persona) => structuredClone(persona)); }

  get(id: string, fallbackIndex = 0): BotPersona {
    return structuredClone(this.personas.get(id) ?? personaForIndex(fallbackIndex));
  }

  async update(persona: BotPersona): Promise<void> {
    this.personas.set(persona.id, structuredClone(persona));
    await this.repository.upsertPersona(persona);
  }
}
