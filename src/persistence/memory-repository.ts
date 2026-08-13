import { ReactionExample } from '../learning/types';
import { BotMessageRecord, BotPersona } from '../personas/types';
import { StreamEvent } from '../stream-brain/types';
import { UsageSnapshot } from '../usage/usage-tracker';
import { AppRepository, BotAccountRecord } from './repository';

export class MemoryRepository implements AppRepository {
  private personas = new Map<string, BotPersona>();
  private bots = new Map<string, BotAccountRecord>();
  private messages: BotMessageRecord[] = [];
  private examples: ReactionExample[] = [];
  private events: StreamEvent[] = [];
  private settings: Record<string, unknown> = {};
  private usage?: UsageSnapshot;

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async healthCheck(): Promise<boolean> { return true; }

  async listPersonas(): Promise<BotPersona[]> { return [...this.personas.values()].map(clone); }
  async upsertPersona(persona: BotPersona): Promise<void> { this.personas.set(persona.id, clone(persona)); }
  async listBots(): Promise<BotAccountRecord[]> { return [...this.bots.values()].map(clone); }
  async upsertBot(bot: BotAccountRecord): Promise<void> { this.bots.set(bot.username, clone(bot)); }
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
