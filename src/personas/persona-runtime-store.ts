import { PersonaMood, PersonaRuntimeState } from './types';

export class PersonaRuntimeStore {
  private readonly states = new Map<string, PersonaRuntimeState>();

  constructor(private readonly now: () => number = Date.now) {}

  get(personaId: string): PersonaRuntimeState {
    const existing = this.states.get(personaId);
    if (existing) return structuredClone(existing);
    const state = defaultState();
    this.states.set(personaId, state);
    return structuredClone(state);
  }

  peek(personaId: string): PersonaRuntimeState {
    return structuredClone(this.states.get(personaId) ?? defaultState());
  }

  setMood(personaId: string, mood: PersonaMood, engagement?: number): PersonaRuntimeState {
    const state = this.states.get(personaId) ?? this.get(personaId);
    const updated: PersonaRuntimeState = {
      ...state,
      mood,
      engagement: clamp(engagement ?? state.engagement),
    };
    this.states.set(personaId, updated);
    return structuredClone(updated);
  }

  observe(personaId: string, eventType: string, importance: number): PersonaRuntimeState {
    const state = this.states.get(personaId) ?? this.get(personaId);
    const energyBias = stableHash(personaId) % 5;
    let mood = state.mood;
    if (importance >= 0.8) {
      if (eventType === 'win' || eventType === 'surprise' || eventType === 'funny') mood = energyBias === 0 ? 'focused' : 'excited';
      else if (eventType === 'loss' || eventType === 'fail') mood = energyBias >= 3 ? 'annoyed' : 'focused';
      else if (eventType === 'conversation') mood = 'good';
    } else if (state.sessionMessageCount >= 12) {
      mood = 'tired';
    }
    const updated: PersonaRuntimeState = {
      ...state,
      mood,
      engagement: clamp(state.engagement * 0.75 + importance * 0.25),
    };
    this.states.set(personaId, updated);
    return structuredClone(updated);
  }

  recordSent(personaId: string): PersonaRuntimeState {
    const state = this.states.get(personaId) ?? this.get(personaId);
    const updated: PersonaRuntimeState = {
      ...state,
      sessionMessageCount: state.sessionMessageCount + 1,
      lastActiveAt: this.now(),
      engagement: clamp(state.engagement + 0.03),
    };
    this.states.set(personaId, updated);
    return structuredClone(updated);
  }

  clear(): void { this.states.clear(); }
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
function defaultState(): PersonaRuntimeState { return { mood: 'neutral', engagement: 0.5, sessionMessageCount: 0 }; }
function stableHash(value: string): number {
  let hash = 0;
  for (const character of value) hash = Math.imul(31, hash) + character.charCodeAt(0) | 0;
  return Math.abs(hash);
}
