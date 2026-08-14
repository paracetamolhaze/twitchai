import { randomUUID } from 'node:crypto';
import { AppRepository } from '../persistence/repository';
import { PersonaConversationMessage, PersonaMemoryItem } from './types';

export interface PersonaMemoryOptions {
  now?: () => number;
  longTermThreshold?: number;
  sessionThreshold?: number;
  sessionTtlMs?: number;
  conversationWindowMs?: number;
}

export type NewPersonaMemory = Omit<PersonaMemoryItem, 'id' | 'createdAt'> & { id?: string; createdAt?: number };

export class PersonaMemory {
  private readonly now: () => number;
  private readonly longTermThreshold: number;
  private readonly sessionThreshold: number;
  private readonly sessionTtlMs: number;
  private readonly conversationWindowMs: number;
  private readonly conversationClocks = new Map<string, number>();

  constructor(private readonly repository: AppRepository, options: PersonaMemoryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.longTermThreshold = options.longTermThreshold ?? 0.7;
    this.sessionThreshold = options.sessionThreshold ?? 0.4;
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60_000;
    this.conversationWindowMs = options.conversationWindowMs ?? 10 * 60_000;
  }

  async remember(input: NewPersonaMemory): Promise<PersonaMemoryItem | undefined> {
    const importance = clamp(input.importance);
    if (importance < this.sessionThreshold) return undefined;
    const createdAt = input.createdAt ?? this.now();
    const item: PersonaMemoryItem = {
      id: input.id ?? randomUUID(),
      personaId: input.personaId,
      createdAt,
      type: input.type,
      summary: input.summary.replace(/\s+/g, ' ').trim().slice(0, 1_000),
      importance,
      tags: normalizeTags(input.tags),
      ...(input.viewerUsername ? { viewerUsername: input.viewerUsername.toLowerCase() } : {}),
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.expiresAt
        ? { expiresAt: input.expiresAt }
        : importance < this.longTermThreshold ? { expiresAt: createdAt + this.sessionTtlMs } : {}),
    };
    if (!item.summary) return undefined;
    await this.repository.savePersonaMemory(item);
    return structuredClone(item);
  }

  async retrieve(personaId: string, query: string, limit = 6): Promise<PersonaMemoryItem[]> {
    const safeLimit = Math.max(1, Math.min(8, limit));
    const now = this.now();
    const candidates = (await this.repository.listPersonaMemories(personaId, 200))
      .filter((item) => !item.expiresAt || item.expiresAt > now);
    const queryTokens = semanticTokens(query);
    return candidates
      .map((item) => {
        const relevance = relevanceScore(queryTokens, `${item.summary} ${item.tags.join(' ')}`);
        return { item, relevance, score: relevance * 2 + item.importance * 0.35 };
      })
      .filter(({ relevance }) => relevance > 0)
      .sort((left, right) => right.score - left.score || right.item.createdAt - left.item.createdAt || left.item.id.localeCompare(right.item.id))
      .slice(0, safeLimit)
      .map(({ item }) => structuredClone(item));
  }

  async list(personaId: string, limit = 50): Promise<PersonaMemoryItem[]> {
    return this.repository.listPersonaMemories(personaId, Math.max(1, Math.min(200, limit)));
  }

  async delete(personaId: string, id: string): Promise<boolean> {
    return this.repository.deletePersonaMemory(id, personaId);
  }

  async addConversation(input: {
    personaId: string;
    viewerUsername: string;
    role: PersonaConversationMessage['role'];
    message: string;
    createdAt?: number;
  }): Promise<PersonaConversationMessage | undefined> {
    const message = input.message.replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!message) return undefined;
    const requestedCreatedAt = input.createdAt ?? this.now();
    const threadKey = `${input.personaId}:${input.viewerUsername.toLowerCase()}`;
    const createdAt = Math.max(requestedCreatedAt, (this.conversationClocks.get(threadKey) ?? requestedCreatedAt - 1) + 1);
    this.conversationClocks.set(threadKey, createdAt);
    const record: PersonaConversationMessage = {
      id: randomUUID(),
      personaId: input.personaId,
      viewerUsername: input.viewerUsername.toLowerCase(),
      role: input.role,
      message,
      createdAt,
      expiresAt: createdAt + this.conversationWindowMs,
    };
    await this.repository.savePersonaConversationMessage(record);
    return structuredClone(record);
  }

  async conversation(personaId: string, viewerUsername: string, limit = 12): Promise<PersonaConversationMessage[]> {
    const now = this.now();
    const messages = await this.repository.listPersonaConversationMessages(
      personaId,
      viewerUsername.toLowerCase(),
      now - this.conversationWindowMs,
      Math.max(1, Math.min(20, limit)),
    );
    return messages.filter((message) => message.expiresAt > now);
  }

  async recentConversationPersonaIds(viewerUsername: string, limit = 3): Promise<string[]> {
    const now = this.now();
    const messages = await this.repository.listRecentPersonaConversationMessages(
      viewerUsername.toLowerCase(),
      now - this.conversationWindowMs,
      Math.max(1, Math.min(50, limit * 6)),
    );
    const personaIds: string[] = [];
    for (const message of messages) {
      if (message.expiresAt <= now || personaIds.includes(message.personaId)) continue;
      personaIds.push(message.personaId);
      if (personaIds.length >= limit) break;
    }
    return personaIds;
  }
}

export function semanticTokens(value: string): Set<string> {
  const words = value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens = new Set<string>();
  for (const word of words) {
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    tokens.add(word);
    tokens.add(stem(word));
  }
  return tokens;
}

export function relevanceScore(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const documentTokens = semanticTokens(text);
  let matches = 0;
  for (const token of queryTokens) if (documentTokens.has(token)) matches += token.length >= 5 ? 1.2 : 1;
  return matches / Math.max(2, Math.sqrt(queryTokens.size * Math.max(1, documentTokens.size)));
}

function stem(word: string): string {
  if (word.length <= 4) return word;
  return word.slice(0, Math.min(6, Math.max(4, word.length - 2)));
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }

const STOP_WORDS = new Set([
  'как', 'что', 'это', 'его', 'её', 'тебя', 'твой', 'твоя', 'твое', 'твоего', 'про', 'для', 'или', 'где',
  'когда', 'там', 'тут', 'был', 'была', 'были', 'есть', 'уже', 'ещё', 'стример', 'viewer', 'bot',
]);
