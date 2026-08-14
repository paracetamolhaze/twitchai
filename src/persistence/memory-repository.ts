import { ReactionExample } from '../learning/types';
import {
  BotMessageRecord,
  BotPersona,
  PersonaConversationMessage,
  PersonaMemoryItem,
  PersonaRelationship,
} from '../personas/types';
import { StreamEvent } from '../stream-brain/types';
import { UsageSnapshot } from '../usage/usage-tracker';
import {
  AppRepository,
  BotAccountRecord,
  EncryptedTwitchCredentialRecord,
  TwitchCredentialRefreshFailure,
  TwitchOAuthNonceRecord,
} from './repository';

export class MemoryRepository implements AppRepository {
  private personas = new Map<string, BotPersona>();
  private personaMemories: PersonaMemoryItem[] = [];
  private personaConversationMessages: PersonaConversationMessage[] = [];
  private personaRelationships = new Map<string, PersonaRelationship>();
  private bots = new Map<string, BotAccountRecord>();
  private twitchCredentials = new Map<string, EncryptedTwitchCredentialRecord>();
  private twitchOAuthNonces = new Map<string, TwitchOAuthNonceRecord>();
  private messages: BotMessageRecord[] = [];
  private examples: ReactionExample[] = [];
  private events: StreamEvent[] = [];
  private settings: Record<string, unknown> = {};
  private usage?: UsageSnapshot;

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async healthCheck(): Promise<boolean> { return true; }

  async listPersonas(): Promise<BotPersona[]> { return [...this.personas.values()].map(clone); }
  async upsertPersona(persona: BotPersona): Promise<void> {
    this.personas.set(persona.id, clone(persona));
    for (const key of this.personaRelationships.keys()) {
      if (key.startsWith(`${persona.id}:`)) this.personaRelationships.delete(key);
    }
    for (const relationship of persona.relationships) {
      this.personaRelationships.set(`${persona.id}:${relationship.targetPersonaId}`, clone(relationship));
    }
  }
  async deletePersona(id: string): Promise<void> {
    this.personas.delete(id);
    this.personaMemories = this.personaMemories.filter((item) => item.personaId !== id);
    this.personaConversationMessages = this.personaConversationMessages.filter((item) => item.personaId !== id);
    for (const key of this.personaRelationships.keys()) {
      if (key.startsWith(`${id}:`) || key.endsWith(`:${id}`)) this.personaRelationships.delete(key);
    }
  }
  async savePersonaMemory(memory: PersonaMemoryItem): Promise<void> {
    const index = this.personaMemories.findIndex((item) => item.id === memory.id);
    if (index >= 0) this.personaMemories[index] = clone(memory);
    else this.personaMemories.push(clone(memory));
  }
  async listPersonaMemories(personaId: string, limit: number): Promise<PersonaMemoryItem[]> {
    return this.personaMemories.filter((item) => item.personaId === personaId)
      .sort((left, right) => right.createdAt - left.createdAt || right.importance - left.importance || left.id.localeCompare(right.id)).slice(0, limit).map(clone);
  }
  async deletePersonaMemory(id: string, personaId: string): Promise<boolean> {
    const before = this.personaMemories.length;
    this.personaMemories = this.personaMemories.filter((item) => item.id !== id || item.personaId !== personaId);
    return this.personaMemories.length < before;
  }
  async savePersonaConversationMessage(message: PersonaConversationMessage): Promise<void> {
    this.personaConversationMessages.push(clone(message));
  }
  async listPersonaConversationMessages(personaId: string, viewerUsername: string, since: number, limit: number): Promise<PersonaConversationMessage[]> {
    return this.personaConversationMessages
      .filter((item) => item.personaId === personaId && item.viewerUsername === viewerUsername && item.createdAt >= since && item.expiresAt > since)
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id)).slice(0, limit).reverse().map(clone);
  }
  async listRecentPersonaConversationMessages(viewerUsername: string, since: number, limit: number): Promise<PersonaConversationMessage[]> {
    return this.personaConversationMessages
      .filter((item) => item.viewerUsername === viewerUsername.toLowerCase() && item.createdAt >= since && item.expiresAt > since)
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(clone);
  }
  async listPersonaRelationships(personaId: string): Promise<PersonaRelationship[]> {
    return [...this.personaRelationships.entries()].filter(([key]) => key.startsWith(`${personaId}:`)).map(([, value]) => clone(value));
  }
  async listBots(): Promise<BotAccountRecord[]> { return [...this.bots.values()].map(clone); }
  async upsertBot(bot: BotAccountRecord): Promise<void> { this.bots.set(bot.username, clone(bot)); }
  async listTwitchCredentials(): Promise<EncryptedTwitchCredentialRecord[]> {
    return [...this.twitchCredentials.values()].map(clone);
  }
  async getTwitchCredential(username: string): Promise<EncryptedTwitchCredentialRecord | undefined> {
    const normalized = username.toLowerCase();
    const credential = this.twitchCredentials.get(normalized)
      ?? [...this.twitchCredentials.values()].find((candidate) => candidate.previousUsername === normalized);
    return credential ? clone(credential) : undefined;
  }
  async getTwitchCredentialByUserId(userId: string): Promise<EncryptedTwitchCredentialRecord | undefined> {
    const credential = [...this.twitchCredentials.values()].find((candidate) => candidate.userId === userId);
    return credential ? clone(credential) : undefined;
  }
  async upsertTwitchCredential(credential: EncryptedTwitchCredentialRecord): Promise<void> {
    const normalized = credential.username.toLowerCase();
    const previous = [...this.twitchCredentials.values()].find((candidate) => candidate.userId === credential.userId);
    if (previous && previous.username !== normalized) {
      this.twitchCredentials.delete(previous.username);
      const oldBot = this.bots.get(previous.username);
      if (oldBot && !this.bots.has(normalized)) {
        this.bots.delete(previous.username);
        this.bots.set(normalized, { ...oldBot, username: normalized });
      } else if (oldBot) {
        this.bots.delete(previous.username);
      }
      this.messages = this.messages.map((message) => message.username === previous.username
        ? { ...message, username: normalized }
        : message);
    }
    this.twitchCredentials.set(normalized, clone({
      ...credential,
      username: normalized,
      version: (previous?.version ?? 0) + 1,
    }));
  }
  async markTwitchCredentialRefreshFailure(failure: TwitchCredentialRefreshFailure): Promise<boolean> {
    const current = [...this.twitchCredentials.values()].find((candidate) => candidate.userId === failure.userId);
    if (!current || current.version !== failure.expectedVersion) return false;
    this.twitchCredentials.set(current.username, clone({
      ...current,
      refreshState: failure.refreshState,
      lastRefreshAt: failure.lastRefreshAt,
      lastRefreshError: failure.lastRefreshError,
      updatedAt: failure.lastRefreshAt,
      version: current.version + 1,
    }));
    return true;
  }
  async saveTwitchOAuthNonce(nonce: TwitchOAuthNonceRecord): Promise<void> {
    this.twitchOAuthNonces.set(`${nonce.purpose}:${nonce.nonceHash}`, clone(nonce));
  }
  async consumeTwitchOAuthNonce(nonceHash: string, purpose: TwitchOAuthNonceRecord['purpose'], now: number): Promise<boolean> {
    const key = `${purpose}:${nonceHash}`;
    const nonce = this.twitchOAuthNonces.get(key);
    this.twitchOAuthNonces.delete(key);
    return Boolean(nonce && nonce.expiresAt > now);
  }
  async saveBotMessage(message: BotMessageRecord): Promise<void> { this.messages.push(clone(message)); }
  async listBotMessages(username: string, limit: number): Promise<BotMessageRecord[]> {
    return this.messages.filter((item) => item.username === username).slice(-limit).reverse().map(clone);
  }
  async saveReactionExample(example: ReactionExample): Promise<void> { this.examples.push(clone(example)); }
  async listReactionExamples(limit: number): Promise<ReactionExample[]> { return this.examples.slice(-limit).reverse().map(clone); }
  async saveStreamEvent(event: StreamEvent): Promise<void> { this.events.push(clone(event)); }
  async listStreamEvents(limit: number): Promise<StreamEvent[]> { return this.events.slice(-limit).reverse().map(clone); }
  async getSettings(): Promise<Record<string, unknown>> { return clone(this.settings); }
  async setSettings(settings: Record<string, unknown>): Promise<void> { this.settings = { ...this.settings, ...clone(settings) }; }
  async saveUsageSnapshot(snapshot: UsageSnapshot): Promise<void> { this.usage = clone(snapshot); }
}

function clone<T>(value: T): T { return structuredClone(value); }
