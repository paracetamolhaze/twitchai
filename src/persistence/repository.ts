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

export interface EncryptedTwitchCredentialRecord {
  username: string;
  previousUsername?: string;
  userId: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  scopes: string[];
  expiresAt: number;
  refreshState: 'HEALTHY' | 'ERROR' | 'RECONNECT_REQUIRED';
  lastRefreshAt?: number;
  lastRefreshError?: string;
  updatedAt: number;
  version: number;
}

export interface TwitchCredentialRefreshFailure {
  userId: string;
  expectedVersion: number;
  refreshState: 'ERROR' | 'RECONNECT_REQUIRED';
  lastRefreshAt: number;
  lastRefreshError: string;
}

export interface TwitchOAuthNonceRecord {
  nonceHash: string;
  purpose: 'launch' | 'state';
  expiresAt: number;
}

export interface AppRepository {
  initialize(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;
  listPersonas(): Promise<BotPersona[]>;
  upsertPersona(persona: BotPersona): Promise<void>;
  deletePersona(id: string): Promise<void>;
  savePersonaMemory(memory: PersonaMemoryItem): Promise<void>;
  listPersonaMemories(personaId: string, limit: number): Promise<PersonaMemoryItem[]>;
  deletePersonaMemory(id: string, personaId: string): Promise<boolean>;
  savePersonaConversationMessage(message: PersonaConversationMessage): Promise<void>;
  listPersonaConversationMessages(personaId: string, viewerUsername: string, since: number, limit: number): Promise<PersonaConversationMessage[]>;
  listRecentPersonaConversationMessages(viewerUsername: string, since: number, limit: number): Promise<PersonaConversationMessage[]>;
  listPersonaRelationships(personaId: string): Promise<PersonaRelationship[]>;
  listBots(): Promise<BotAccountRecord[]>;
  upsertBot(bot: BotAccountRecord): Promise<void>;
  listTwitchCredentials(): Promise<EncryptedTwitchCredentialRecord[]>;
  getTwitchCredential(username: string): Promise<EncryptedTwitchCredentialRecord | undefined>;
  getTwitchCredentialByUserId(userId: string): Promise<EncryptedTwitchCredentialRecord | undefined>;
  upsertTwitchCredential(credential: EncryptedTwitchCredentialRecord): Promise<void>;
  markTwitchCredentialRefreshFailure(failure: TwitchCredentialRefreshFailure): Promise<boolean>;
  saveTwitchOAuthNonce(nonce: TwitchOAuthNonceRecord): Promise<void>;
  consumeTwitchOAuthNonce(nonceHash: string, purpose: TwitchOAuthNonceRecord['purpose'], now: number): Promise<boolean>;
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
