import { ReactionExample } from '../learning/types';
import { BotMessageRecord, BotPersona } from '../personas/types';
import { StreamEvent } from '../stream-brain/types';
import { UsageSnapshot } from '../usage/usage-tracker';

export type BotConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR' | 'DISABLED';

export interface BotAccountRecord {
  username: string;
  personaId: string;
  enabled: boolean;
  connectionState: BotConnectionState;
  chatConnected: boolean;
  messagesSent: number;
  lastMessage?: string;
  lastReactionAt?: number;
  lastError?: string;
}

export interface AppRepository {
  initialize(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;
  listPersonas(): Promise<BotPersona[]>;
  upsertPersona(persona: BotPersona): Promise<void>;
  listBots(): Promise<BotAccountRecord[]>;
  upsertBot(bot: BotAccountRecord): Promise<void>;
  saveBotMessage(message: BotMessageRecord): Promise<void>;
  listBotMessages(username: string, limit: number): Promise<BotMessageRecord[]>;
  saveReactionExample(example: ReactionExample): Promise<void>;
  listReactionExamples(limit: number): Promise<ReactionExample[]>;
  saveStreamEvent(event: StreamEvent): Promise<void>;
  listStreamEvents(limit: number): Promise<StreamEvent[]>;
  getSettings(): Promise<Record<string, unknown>>;
  setSettings(settings: Record<string, unknown>): Promise<void>;
  saveUsageSnapshot(snapshot: UsageSnapshot): Promise<void>;
}
