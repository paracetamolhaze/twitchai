import { ReactionExample } from '../learning/types';
import { LearnedPolicyRule, LearnedRuleStatus } from '../learning/learned-policy.types';
import { StreamerMemory, StreamSession } from '../global-memory/types';
import {
  BotMessageRecord,
  MessageVerdictRecord,
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
  PersonaCanonBackupRecord,
  PersonaReplacementWithBackup,
  StreamerMemoryTransaction,
  TwitchCredentialRefreshFailure,
  TwitchOAuthNonceRecord,
} from './repository';

export class MemoryRepository implements AppRepository {
  private personas = new Map<string, BotPersona>();
  private personaMemories: PersonaMemoryItem[] = [];
  private personaConversationMessages: PersonaConversationMessage[] = [];
  private personaRelationships = new Map<string, PersonaRelationship>();
  private personaCanonBackups: PersonaCanonBackupRecord[] = [];
  private bots = new Map<string, BotAccountRecord>();
  private twitchCredentials = new Map<string, EncryptedTwitchCredentialRecord>();
  private twitchOAuthNonces = new Map<string, TwitchOAuthNonceRecord>();
  private messages: BotMessageRecord[] = [];
  private examples: ReactionExample[] = [];
  private readonly verdicts: MessageVerdictRecord[] = [];
  private readonly processedVerdicts = new Set<string>();
  private readonly learnedRules = new Map<string, LearnedPolicyRule>();
  private events: StreamEvent[] = [];
  private settings: Record<string, unknown> = {};
  private usage?: UsageSnapshot;
  private streamSessions = new Map<string, StreamSession>();
  private streamerMemories = new Map<string, StreamerMemory>();
  private streamerMemoryMutationTail: Promise<void> = Promise.resolve();

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
  async savePersonaCanonBackup(backup: PersonaCanonBackupRecord): Promise<void> {
    this.personaCanonBackups.push(clone(backup));
  }
  async replacePersonasWithBackups(replacements: PersonaReplacementWithBackup[]): Promise<void> {
    if (!replacements.length) return;
    const personas = new Map(this.personas);
    const relationships = new Map(this.personaRelationships);
    const backups = [...this.personaCanonBackups];
    for (const replacement of replacements) {
      const persona = clone(replacement.persona);
      backups.push(clone(replacement.backup));
      personas.set(persona.id, persona);
      for (const key of relationships.keys()) {
        if (key.startsWith(`${persona.id}:`)) relationships.delete(key);
      }
      for (const relationship of persona.relationships) {
        relationships.set(`${persona.id}:${relationship.targetPersonaId}`, clone(relationship));
      }
    }
    this.personas = personas;
    this.personaRelationships = relationships;
    this.personaCanonBackups = backups;
  }
  async listPersonaCanonBackups(personaId: string, limit: number): Promise<PersonaCanonBackupRecord[]> {
    return this.personaCanonBackups.filter((backup) => backup.personaId === personaId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit)
      .map(clone);
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
  async saveMessageVerdict(verdict: MessageVerdictRecord): Promise<void> { this.verdicts.push(clone(verdict)); }
  async listMessageVerdicts(limit: number): Promise<MessageVerdictRecord[]> {
    return this.verdicts.slice(-limit).reverse().map((verdict) => ({
      ...clone(verdict),
      ...(this.processedVerdicts.has(verdict.id) ? { processedAt: verdict.createdAt } : {}),
    }));
  }
  async saveStreamEvent(event: StreamEvent): Promise<void> {
    const index = this.events.findIndex((candidate) => candidate.id === event.id);
    if (index >= 0) this.events[index] = clone(event);
    else this.events.push(clone(event));
  }
  async listStreamEvents(limit: number): Promise<StreamEvent[]> { return this.events.slice(-limit).reverse().map(clone); }
  async getStreamEvent(id: string): Promise<StreamEvent | undefined> {
    const event = this.events.find((candidate) => candidate.id === id);
    return event ? clone(event) : undefined;
  }

  async listUnprocessedMessageVerdicts(limit: number): Promise<MessageVerdictRecord[]> {
    return this.verdicts.filter((item) => !this.processedVerdicts.has(item.id)).slice(0, limit).map(clone);
  }

  async listLearnedPolicyRules(): Promise<LearnedPolicyRule[]> {
    return [...this.learnedRules.values()].sort((left, right) => right.updatedAt - left.updatedAt).map(clone);
  }

  async applyLearnedPolicyBatch(input: {
    upserts: LearnedPolicyRule[];
    processedVerdictIds: string[];
    processedAt: number;
  }): Promise<void> {
    // The Postgres implementation holds one transaction; here the whole method is synchronous
    // between awaits, so it is already all-or-nothing for the same reason.
    for (const rule of input.upserts) this.learnedRules.set(rule.id, clone(rule));
    for (const id of input.processedVerdictIds) this.processedVerdicts.add(id);
  }

  async setLearnedPolicyRuleStatus(id: string, status: LearnedRuleStatus): Promise<LearnedPolicyRule | undefined> {
    const rule = this.learnedRules.get(id);
    if (!rule) return undefined;
    const updated: LearnedPolicyRule = { ...rule, status, updatedAt: Date.now() };
    this.learnedRules.set(id, updated);
    return clone(updated);
  }

  async deleteLearnedPolicyRule(id: string): Promise<boolean> { return this.learnedRules.delete(id); }

  async getSettings(): Promise<Record<string, unknown>> { return clone(this.settings); }
  async setSettings(settings: Record<string, unknown>): Promise<void> { this.settings = { ...this.settings, ...clone(settings) }; }
  async saveUsageSnapshot(snapshot: UsageSnapshot): Promise<void> { this.usage = clone(snapshot); }

  async startOrResumeStreamSession(session: StreamSession, staleBefore: number): Promise<StreamSession> {
    for (const candidate of this.streamSessions.values()) {
      if (candidate.channel !== session.channel || candidate.status !== 'live' || candidate.lastSeenAt > staleBefore) continue;
      this.streamSessions.set(candidate.id, { ...candidate, status: 'interrupted', endedAt: candidate.lastSeenAt });
    }
    const active = [...this.streamSessions.values()]
      .filter((candidate) => candidate.channel === session.channel && candidate.status === 'live')
      .sort((left, right) => right.startedAt - left.startedAt || left.id.localeCompare(right.id))[0];
    if (active) return clone(active);
    this.streamSessions.set(session.id, clone(session));
    return clone(session);
  }

  async saveStreamSession(session: StreamSession): Promise<void> {
    this.streamSessions.set(session.id, clone(session));
  }

  async getStreamSession(id: string): Promise<StreamSession | undefined> {
    const session = this.streamSessions.get(id);
    return session ? clone(session) : undefined;
  }

  async listStreamSessions(channel: string, limit: number): Promise<StreamSession[]> {
    return [...this.streamSessions.values()]
      .filter((session) => session.channel === channel.toLowerCase())
      .sort((left, right) => right.startedAt - left.startedAt || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(clone);
  }

  async withStreamerMemoryTransaction<T>(
    _channel: string,
    operation: (transaction: StreamerMemoryTransaction) => Promise<T>,
  ): Promise<T> {
    return this.serializeStreamerMemoryMutation(async () => {
      // Copy-on-write gives the in-memory repository the same all-or-nothing
      // behavior as the SQL transaction below. A failed callback simply drops
      // this draft instead of exposing half a batch to later reads.
      const draft = new Map([...this.streamerMemories.entries()].map(([id, memory]) => [id, clone(memory)]));
      const transaction: StreamerMemoryTransaction = {
        getStreamerMemory: async (id) => {
          const memory = draft.get(id);
          return memory ? clone(memory) : undefined;
        },
        findActiveStreamerMemoryByDedupeKey: async (channel, dedupeKey) => {
          const memory = [...draft.values()].find((candidate) => candidate.channel === channel.toLowerCase()
            && candidate.status === 'active' && candidate.dedupeKey === dedupeKey);
          return memory ? clone(memory) : undefined;
        },
        saveStreamerMemory: async (memory) => {
          draft.set(memory.id, clone(memory));
        },
      };
      const result = await operation(transaction);
      this.streamerMemories = draft;
      return result;
    });
  }

  async saveStreamerMemory(memory: StreamerMemory): Promise<void> {
    await this.serializeStreamerMemoryMutation(async () => {
      this.streamerMemories.set(memory.id, clone(memory));
    });
  }

  async getStreamerMemory(id: string): Promise<StreamerMemory | undefined> {
    const memory = this.streamerMemories.get(id);
    return memory ? clone(memory) : undefined;
  }

  async listStreamerMemories(channel: string, limit: number): Promise<StreamerMemory[]> {
    return [...this.streamerMemories.values()]
      .filter((memory) => memory.channel === channel.toLowerCase())
      .sort((left, right) => right.updatedAt - left.updatedAt || right.importance - left.importance || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(clone);
  }

  async findActiveStreamerMemoryByDedupeKey(channel: string, dedupeKey: string): Promise<StreamerMemory | undefined> {
    const memory = [...this.streamerMemories.values()].find((candidate) => candidate.channel === channel.toLowerCase()
      && candidate.status === 'active' && candidate.dedupeKey === dedupeKey);
    return memory ? clone(memory) : undefined;
  }

  async expireStreamerMemories(channel: string, now: number): Promise<number> {
    return this.serializeStreamerMemoryMutation(async () => {
      let expired = 0;
      for (const memory of this.streamerMemories.values()) {
        if (memory.channel !== channel.toLowerCase() || memory.status !== 'active' || !memory.expiresAt || memory.expiresAt > now) continue;
        this.streamerMemories.set(memory.id, { ...memory, status: 'expired', updatedAt: now });
        expired += 1;
      }
      return expired;
    });
  }

  async deleteStreamerMemory(id: string, channel?: string): Promise<boolean> {
    return this.serializeStreamerMemoryMutation(async () => {
      const memory = this.streamerMemories.get(id);
      if (!memory || (channel && memory.channel !== channel.toLowerCase())) return false;
      this.streamerMemories.delete(id);
      return true;
    });
  }

  private async serializeStreamerMemoryMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.streamerMemoryMutationTail;
    let release: (() => void) | undefined;
    this.streamerMemoryMutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

function clone<T>(value: T): T { return structuredClone(value); }
