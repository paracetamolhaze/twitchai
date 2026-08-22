import { randomUUID } from 'node:crypto';
import { AppRepository } from '../persistence/repository';
import { normalizeMessage, tokenSimilarity } from '../shared/similarity';
import { BotMessageRecord } from './types';

export class BotHistory {
  private readonly cache = new Map<string, BotMessageRecord[]>();

  constructor(
    private readonly repository: AppRepository,
    private readonly limit = 50,
    private readonly similarityThreshold = 0.72,
  ) {}

  async recent(username: string): Promise<BotMessageRecord[]> {
    const cached = this.cache.get(username);
    if (cached) return structuredClone(cached);
    const messages = (await this.repository.listBotMessages(username, this.limit)).reverse();
    this.cache.set(username, messages);
    return structuredClone(messages);
  }

  async isDuplicate(username: string, candidate: string): Promise<boolean> {
    const normalized = normalizeMessage(candidate);
    if (!normalized) return true;
    const recent = (await this.recent(username)).slice(-20);
    return recent.some((item) => {
      const previous = normalizeMessage(item.message);
      return previous === normalized || tokenSimilarity(previous, normalized) >= this.similarityThreshold;
    });
  }

  /**
   * `id` is the canonical reaction id when the caller has one (the coordinator always does), so the
   * bot_messages row IS the reaction rather than a second identity for it. Minted here only for
   * callers that predate the id.
   */
  async add(username: string, message: string, eventId?: string, sentAt = Date.now(), id?: string): Promise<BotMessageRecord> {
    const record: BotMessageRecord = {
      id: id ?? randomUUID(),
      username,
      message,
      sentAt,
      ...(eventId ? { eventId } : {}),
    };
    const messages = this.cache.get(username) ?? (await this.repository.listBotMessages(username, this.limit)).reverse();
    messages.push(record);
    if (messages.length > this.limit) messages.splice(0, messages.length - this.limit);
    this.cache.set(username, messages);
    await this.repository.saveBotMessage(record);
    return record;
  }
}
