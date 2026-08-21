import { ReactionExample } from '../learning/types';
import { LearnedPolicyRule, LearnedRuleStatus } from '../learning/learned-policy.types';
import { StreamerMemory, StreamSession } from '../global-memory/types';
import {
  BotMessageRecord,
  BotPersona,
  MessageVerdictRecord,
  PersonaConversationMessage,
  PersonaMemoryItem,
  PersonaRelationship,
} from '../personas/types';
import { PersonaMindRecord } from '../personas/persona-mind';
import { SentMessageMotiveRecord } from '../reaction/types';
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

export interface PersonaCanonBackupRecord {
  personaId: string;
  username?: string;
  reason: string;
  generationVersion: number;
  canon: BotPersona;
  createdAt: number;
}

/**
 * A canon replacement and its recovery point. Repositories must commit the
 * whole collection atomically so a bulk operator action cannot stop halfway.
 */
export interface PersonaReplacementWithBackup {
  backup: PersonaCanonBackupRecord;
  persona: BotPersona;
}

/**
 * The intentionally small transactional surface used by global streamer
 * memory. Keeping it domain-specific prevents callers from accidentally
 * mixing unrelated persistence with a memory batch.
 */
export interface StreamerMemoryTransaction {
  getStreamerMemory(id: string): Promise<StreamerMemory | undefined>;
  findActiveStreamerMemoryByDedupeKey(channel: string, dedupeKey: string): Promise<StreamerMemory | undefined>;
  saveStreamerMemory(memory: StreamerMemory): Promise<void>;
}

export interface AppRepository {
  initialize(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;
  listPersonas(): Promise<BotPersona[]>;
  upsertPersona(persona: BotPersona): Promise<void>;
  deletePersona(id: string): Promise<void>;
  savePersonaCanonBackup(backup: PersonaCanonBackupRecord): Promise<void>;
  replacePersonasWithBackups(replacements: PersonaReplacementWithBackup[]): Promise<void>;
  listPersonaCanonBackups(personaId: string, limit: number): Promise<PersonaCanonBackupRecord[]>;
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
  saveMessageVerdict(verdict: MessageVerdictRecord): Promise<void>;
  listMessageVerdicts(limit: number): Promise<MessageVerdictRecord[]>;
  /** Verdicts no Teacher run has counted yet, oldest first so a batch reads in the order it happened. */
  listUnprocessedMessageVerdicts(limit: number): Promise<MessageVerdictRecord[]>;
  saveStreamEvent(event: StreamEvent): Promise<void>;
  listStreamEvents(limit: number): Promise<StreamEvent[]>;
  /** One event by id, for rebuilding the moment a rated message answered. */
  getStreamEvent(id: string): Promise<StreamEvent | undefined>;
  /** Why each sent message existed — joined against verdicts to score motive quality over time. */
  saveSentMessageMotive(record: SentMessageMotiveRecord): Promise<void>;
  listSentMessageMotives(limit: number): Promise<SentMessageMotiveRecord[]>;
  /** The dynamic half of each persona — see src/personas/persona-mind.ts for what a mind holds. */
  listPersonaMinds(): Promise<PersonaMindRecord[]>;
  savePersonaMind(record: PersonaMindRecord): Promise<void>;
  deletePersonaMind(personaId: string): Promise<boolean>;
  listLearnedPolicyRules(): Promise<LearnedPolicyRule[]>;
  /**
   * Applies one Teacher run's whole result, or none of it.
   *
   * All-or-nothing because a half-applied run is worse than a failed one: a rule created without the
   * verdicts that justified it being marked processed would be re-derived and double-counted on the
   * next run, and a verdict marked processed without its rule stored would lose the evidence for
   * good. `processedVerdictIds` are stamped in the same transaction as the rule writes.
   */
  applyLearnedPolicyBatch(input: {
    upserts: LearnedPolicyRule[];
    processedVerdictIds: string[];
    processedAt: number;
  }): Promise<void>;
  /** Operator-driven status change from the dashboard. Returns the updated rule, or undefined. */
  setLearnedPolicyRuleStatus(id: string, status: LearnedRuleStatus): Promise<LearnedPolicyRule | undefined>;
  deleteLearnedPolicyRule(id: string): Promise<boolean>;
  getSettings(): Promise<Record<string, unknown>>;
  setSettings(settings: Record<string, unknown>): Promise<void>;
  saveUsageSnapshot(snapshot: UsageSnapshot): Promise<void>;
  /** Atomically reuse a channel's live session instead of creating a duplicate after a restart. */
  startOrResumeStreamSession(session: StreamSession, staleBefore: number): Promise<StreamSession>;
  saveStreamSession(session: StreamSession): Promise<void>;
  getStreamSession(id: string): Promise<StreamSession | undefined>;
  listStreamSessions(channel: string, limit: number): Promise<StreamSession[]>;
  /**
   * Serialize and atomically commit a channel-scoped memory mutation batch.
   * Postgres implementations hold a transaction and advisory lock; in-memory
   * implementations use copy-on-write so a failed callback leaves no writes.
   */
  withStreamerMemoryTransaction<T>(
    channel: string,
    operation: (transaction: StreamerMemoryTransaction) => Promise<T>,
  ): Promise<T>;
  saveStreamerMemory(memory: StreamerMemory): Promise<void>;
  getStreamerMemory(id: string): Promise<StreamerMemory | undefined>;
  listStreamerMemories(channel: string, limit: number): Promise<StreamerMemory[]>;
  findActiveStreamerMemoryByDedupeKey(channel: string, dedupeKey: string): Promise<StreamerMemory | undefined>;
  expireStreamerMemories(channel: string, now: number): Promise<number>;
  deleteStreamerMemory(id: string, channel?: string): Promise<boolean>;
}
