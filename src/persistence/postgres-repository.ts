import { Pool, PoolClient } from 'pg';
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
  PersonaCanonBackupRecord,
  PersonaReplacementWithBackup,
  TwitchCredentialRefreshFailure,
  TwitchOAuthNonceRecord,
} from './repository';
import { runMigrations } from './run-migrations';

export class PostgresRepository implements AppRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string, ssl: boolean) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: ssl ? { rejectUnauthorized: true } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }

  async initialize(): Promise<void> { await runMigrations(this.pool); }
  async close(): Promise<void> { await this.pool.end(); }
  async healthCheck(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async listPersonas(): Promise<BotPersona[]> {
    const result = await this.pool.query<{ id: string; config: Record<string, unknown> }>('SELECT id, config FROM personas ORDER BY id');
    // The relational primary key is authoritative for old JSON rows whose
    // embedded id was missing or malformed.
    return result.rows.map((row) => ({ ...row.config, id: row.id }) as unknown as BotPersona);
  }

  async upsertPersona(persona: BotPersona): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.upsertPersonaWithClient(client, persona);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deletePersona(id: string): Promise<void> {
    await this.pool.query('DELETE FROM personas WHERE id=$1', [id]);
  }

  async savePersonaCanonBackup(backup: PersonaCanonBackupRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO persona_canon_backups
       (persona_id, username, reason, generation_version, canon, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [backup.personaId, backup.username ?? null, backup.reason, backup.generationVersion, backup.canon, new Date(backup.createdAt)],
    );
  }

  async replacePersonasWithBackups(replacements: PersonaReplacementWithBackup[]): Promise<void> {
    if (!replacements.length) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const replacement of replacements) {
        await this.savePersonaCanonBackupWithClient(client, replacement.backup);
        await this.upsertPersonaWithClient(client, replacement.persona);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listPersonaCanonBackups(personaId: string, limit: number): Promise<PersonaCanonBackupRecord[]> {
    const result = await this.pool.query<{
      persona_id: string; username: string | null; reason: string; generation_version: number; canon: BotPersona; created_at: Date;
    }>(
      `SELECT persona_id, username, reason, generation_version, canon, created_at
       FROM persona_canon_backups WHERE persona_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [personaId, limit],
    );
    return result.rows.map((row) => ({
      personaId: row.persona_id,
      ...(row.username ? { username: row.username } : {}),
      reason: row.reason,
      generationVersion: row.generation_version,
      canon: row.canon,
      createdAt: row.created_at.getTime(),
    }));
  }

  async savePersonaMemory(memory: PersonaMemoryItem): Promise<void> {
    await this.pool.query('DELETE FROM persona_memories WHERE expires_at IS NOT NULL AND expires_at<=NOW()');
    await this.pool.query(
      `INSERT INTO persona_memories
       (id, persona_id, created_at, type, summary, importance, tags, viewer_username, event_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET summary=EXCLUDED.summary, importance=EXCLUDED.importance,
       tags=EXCLUDED.tags, expires_at=EXCLUDED.expires_at`,
      [memory.id, memory.personaId, new Date(memory.createdAt), memory.type, memory.summary, memory.importance,
        memory.tags, memory.viewerUsername ?? null, memory.eventId ?? null,
        memory.expiresAt ? new Date(memory.expiresAt) : null],
    );
  }

  async listPersonaMemories(personaId: string, limit: number): Promise<PersonaMemoryItem[]> {
    const result = await this.pool.query<{
      id: string; persona_id: string; created_at: Date; type: PersonaMemoryItem['type']; summary: string;
      importance: number; tags: string[]; viewer_username: string | null; event_id: string | null; expires_at: Date | null;
    }>(
      `SELECT id, persona_id, created_at, type, summary, importance, tags, viewer_username, event_id, expires_at
       FROM persona_memories WHERE persona_id=$1 AND (expires_at IS NULL OR expires_at>NOW())
       ORDER BY created_at DESC, importance DESC, id ASC LIMIT $2`,
      [personaId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id, personaId: row.persona_id, createdAt: row.created_at.getTime(), type: row.type,
      summary: row.summary, importance: Number(row.importance), tags: row.tags,
      ...(row.viewer_username ? { viewerUsername: row.viewer_username } : {}),
      ...(row.event_id ? { eventId: row.event_id } : {}),
      ...(row.expires_at ? { expiresAt: row.expires_at.getTime() } : {}),
    }));
  }

  async deletePersonaMemory(id: string, personaId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM persona_memories WHERE id=$1 AND persona_id=$2', [id, personaId]);
    return Boolean(result.rowCount);
  }

  async savePersonaConversationMessage(message: PersonaConversationMessage): Promise<void> {
    await this.pool.query('DELETE FROM persona_conversation_messages WHERE expires_at<=NOW()');
    await this.pool.query(
      `INSERT INTO persona_conversation_messages
       (id, persona_id, viewer_username, role, message, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [message.id, message.personaId, message.viewerUsername, message.role, message.message,
        new Date(message.createdAt), new Date(message.expiresAt)],
    );
  }

  async listPersonaConversationMessages(personaId: string, viewerUsername: string, since: number, limit: number): Promise<PersonaConversationMessage[]> {
    const result = await this.pool.query<{
      id: string; persona_id: string; viewer_username: string; role: PersonaConversationMessage['role'];
      message: string; created_at: Date; expires_at: Date;
    }>(
      `SELECT id, persona_id, viewer_username, role, message, created_at, expires_at
       FROM persona_conversation_messages
       WHERE persona_id=$1 AND viewer_username=$2 AND created_at>=$3 AND expires_at>NOW()
       ORDER BY created_at DESC, id ASC LIMIT $4`,
      [personaId, viewerUsername.toLowerCase(), new Date(since), limit],
    );
    return result.rows.reverse().map((row) => ({
      id: row.id, personaId: row.persona_id, viewerUsername: row.viewer_username, role: row.role,
      message: row.message, createdAt: row.created_at.getTime(), expiresAt: row.expires_at.getTime(),
    }));
  }

  async listRecentPersonaConversationMessages(viewerUsername: string, since: number, limit: number): Promise<PersonaConversationMessage[]> {
    const result = await this.pool.query<{
      id: string; persona_id: string; viewer_username: string; role: PersonaConversationMessage['role'];
      message: string; created_at: Date; expires_at: Date;
    }>(
      `SELECT id, persona_id, viewer_username, role, message, created_at, expires_at
       FROM persona_conversation_messages
       WHERE viewer_username=$1 AND created_at>=$2 AND expires_at>NOW()
       ORDER BY created_at DESC, id ASC LIMIT $3`,
      [viewerUsername.toLowerCase(), new Date(since), limit],
    );
    return result.rows.map((row) => ({
      id: row.id, personaId: row.persona_id, viewerUsername: row.viewer_username, role: row.role,
      message: row.message, createdAt: row.created_at.getTime(), expiresAt: row.expires_at.getTime(),
    }));
  }

  async listPersonaRelationships(personaId: string): Promise<PersonaRelationship[]> {
    const result = await this.pool.query<{
      target_persona_id: string; familiarity: number; sentiment: number; notes: string[];
    }>('SELECT target_persona_id, familiarity, sentiment, notes FROM persona_relationships WHERE persona_id=$1 ORDER BY target_persona_id', [personaId]);
    return result.rows.map((row) => ({
      targetPersonaId: row.target_persona_id,
      familiarity: Number(row.familiarity),
      sentiment: Number(row.sentiment),
      notes: row.notes,
    }));
  }

  async listBots(): Promise<BotAccountRecord[]> {
    const result = await this.pool.query<{
      username: string; persona_id: string; enabled: boolean; connection_state: BotAccountRecord['connectionState'];
      chat_connected: boolean; messages_sent: number; last_message: string | null; last_reaction_at: Date | null; last_error: string | null;
    }>('SELECT * FROM bot_accounts ORDER BY username');
    return result.rows.map((row) => ({
      username: row.username,
      personaId: row.persona_id,
      enabled: row.enabled,
      connectionState: row.connection_state,
      chatConnected: row.chat_connected,
      messagesSent: Number(row.messages_sent),
      ...(row.last_message ? { lastMessage: row.last_message } : {}),
      ...(row.last_reaction_at ? { lastReactionAt: row.last_reaction_at.getTime() } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
    }));
  }

  async upsertBot(bot: BotAccountRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO bot_accounts
       (username, persona_id, enabled, connection_state, chat_connected, messages_sent, last_message, last_reaction_at, last_error, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (username) DO UPDATE SET persona_id=EXCLUDED.persona_id, enabled=EXCLUDED.enabled,
       connection_state=EXCLUDED.connection_state, chat_connected=EXCLUDED.chat_connected,
       messages_sent=EXCLUDED.messages_sent, last_message=EXCLUDED.last_message,
       last_reaction_at=EXCLUDED.last_reaction_at, last_error=EXCLUDED.last_error, updated_at=NOW()`,
      [bot.username, bot.personaId, bot.enabled, bot.connectionState, bot.chatConnected, bot.messagesSent,
        bot.lastMessage ?? null, bot.lastReactionAt ? new Date(bot.lastReactionAt) : null, bot.lastError ?? null],
    );
  }

  async listTwitchCredentials(): Promise<EncryptedTwitchCredentialRecord[]> {
    const result = await this.pool.query<{
      username: string; previous_username: string | null; twitch_user_id: string; access_token_ciphertext: string; refresh_token_ciphertext: string;
      scopes: string[]; expires_at: Date; refresh_state: EncryptedTwitchCredentialRecord['refreshState'];
      last_refresh_at: Date | null; last_refresh_error: string | null; updated_at: Date; credential_version: string;
    }>('SELECT * FROM twitch_bot_credentials ORDER BY username');
    return result.rows.map(mapTwitchCredential);
  }

  async getTwitchCredential(username: string): Promise<EncryptedTwitchCredentialRecord | undefined> {
    const result = await this.pool.query<{
      username: string; previous_username: string | null; twitch_user_id: string; access_token_ciphertext: string; refresh_token_ciphertext: string;
      scopes: string[]; expires_at: Date; refresh_state: EncryptedTwitchCredentialRecord['refreshState'];
      last_refresh_at: Date | null; last_refresh_error: string | null; updated_at: Date; credential_version: string;
    }>(`SELECT * FROM twitch_bot_credentials
        WHERE username=$1 OR previous_username=$1
        ORDER BY (username=$1) DESC
        LIMIT 1`, [username.toLowerCase()]);
    return result.rows[0] ? mapTwitchCredential(result.rows[0]) : undefined;
  }

  async getTwitchCredentialByUserId(userId: string): Promise<EncryptedTwitchCredentialRecord | undefined> {
    const result = await this.pool.query<{
      username: string; previous_username: string | null; twitch_user_id: string; access_token_ciphertext: string; refresh_token_ciphertext: string;
      scopes: string[]; expires_at: Date; refresh_state: EncryptedTwitchCredentialRecord['refreshState'];
      last_refresh_at: Date | null; last_refresh_error: string | null; updated_at: Date; credential_version: string;
    }>('SELECT * FROM twitch_bot_credentials WHERE twitch_user_id=$1', [userId]);
    return result.rows[0] ? mapTwitchCredential(result.rows[0]) : undefined;
  }

  async upsertTwitchCredential(credential: EncryptedTwitchCredentialRecord): Promise<void> {
    const client = await this.pool.connect();
    const username = credential.username.toLowerCase();
    try {
      await client.query('BEGIN');
      const prior = await client.query<{ username: string }>(
        'SELECT username FROM twitch_bot_credentials WHERE twitch_user_id=$1 FOR UPDATE',
        [credential.userId],
      );
      const previousUsername = prior.rows[0]?.username;
      if (previousUsername && previousUsername !== username) {
        await client.query('UPDATE bot_message_history SET username=$1 WHERE username=$2', [username, previousUsername]);
        const targetBot = await client.query('SELECT 1 FROM bot_accounts WHERE username=$1', [username]);
        if (targetBot.rowCount) {
          await client.query('DELETE FROM bot_accounts WHERE username=$1', [previousUsername]);
        } else {
          await client.query('UPDATE bot_accounts SET username=$1 WHERE username=$2', [username, previousUsername]);
        }
      }
      await client.query(
        `INSERT INTO twitch_bot_credentials
         (twitch_user_id, username, previous_username, access_token_ciphertext, refresh_token_ciphertext, scopes, expires_at,
          refresh_state, last_refresh_at, last_refresh_error, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (twitch_user_id) DO UPDATE SET username=EXCLUDED.username,
         previous_username=EXCLUDED.previous_username,
         access_token_ciphertext=EXCLUDED.access_token_ciphertext,
         refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext, scopes=EXCLUDED.scopes,
         expires_at=EXCLUDED.expires_at, refresh_state=EXCLUDED.refresh_state,
         last_refresh_at=EXCLUDED.last_refresh_at, last_refresh_error=EXCLUDED.last_refresh_error,
         updated_at=NOW(), credential_version=twitch_bot_credentials.credential_version + 1`,
        [credential.userId, username, credential.previousUsername ?? null,
          credential.accessTokenCiphertext, credential.refreshTokenCiphertext,
          credential.scopes, new Date(credential.expiresAt), credential.refreshState,
          credential.lastRefreshAt ? new Date(credential.lastRefreshAt) : null, credential.lastRefreshError ?? null],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markTwitchCredentialRefreshFailure(failure: TwitchCredentialRefreshFailure): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE twitch_bot_credentials
       SET refresh_state=$3, last_refresh_at=$4, last_refresh_error=$5,
           updated_at=NOW(), credential_version=credential_version + 1
       WHERE twitch_user_id=$1 AND credential_version=$2`,
      [failure.userId, failure.expectedVersion, failure.refreshState,
        new Date(failure.lastRefreshAt), failure.lastRefreshError],
    );
    return Boolean(result.rowCount);
  }

  async saveTwitchOAuthNonce(nonce: TwitchOAuthNonceRecord): Promise<void> {
    await this.pool.query('DELETE FROM twitch_oauth_nonces WHERE expires_at <= NOW()');
    await this.pool.query(
      `INSERT INTO twitch_oauth_nonces (nonce_hash, purpose, expires_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (nonce_hash, purpose) DO UPDATE SET expires_at=EXCLUDED.expires_at, created_at=NOW()`,
      [nonce.nonceHash, nonce.purpose, new Date(nonce.expiresAt)],
    );
  }

  async consumeTwitchOAuthNonce(nonceHash: string, purpose: TwitchOAuthNonceRecord['purpose'], now: number): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM twitch_oauth_nonces
       WHERE nonce_hash=$1 AND purpose=$2 AND expires_at>$3
       RETURNING nonce_hash`,
      [nonceHash, purpose, new Date(now)],
    );
    return Boolean(result.rowCount);
  }

  async saveBotMessage(message: BotMessageRecord): Promise<void> {
    await this.pool.query(
      'INSERT INTO bot_message_history (id, username, message, event_id, sent_at) VALUES ($1,$2,$3,$4,$5)',
      [message.id, message.username, message.message, message.eventId ?? null, new Date(message.sentAt)],
    );
  }

  async listBotMessages(username: string, limit: number): Promise<BotMessageRecord[]> {
    const result = await this.pool.query<{ id: string; username: string; message: string; event_id: string | null; sent_at: Date }>(
      'SELECT id, username, message, event_id, sent_at FROM bot_message_history WHERE username=$1 ORDER BY sent_at DESC LIMIT $2',
      [username, limit],
    );
    return result.rows.map((row) => ({
      id: row.id, username: row.username, message: row.message, sentAt: row.sent_at.getTime(),
      ...(row.event_id ? { eventId: row.event_id } : {}),
    }));
  }

  async saveReactionExample(example: ReactionExample): Promise<void> {
    await this.pool.query(
      `INSERT INTO reaction_examples
       (id, occurred_at, game, stream_context, event_type, event_summary, transcript, chat_messages)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [example.id, new Date(example.timestamp), example.game, example.streamContext, example.eventType,
        example.event, example.transcript ?? null, example.chatMessages],
    );
  }

  async listReactionExamples(limit: number): Promise<ReactionExample[]> {
    const result = await this.pool.query<{
      id: string; occurred_at: Date; game: string; stream_context: string; event_type: ReactionExample['eventType'];
      event_summary: string; transcript: string | null; chat_messages: string[];
    }>('SELECT * FROM reaction_examples ORDER BY occurred_at DESC LIMIT $1', [limit]);
    return result.rows.map((row) => ({
      id: row.id, timestamp: row.occurred_at.getTime(), game: row.game, streamContext: row.stream_context,
      eventType: row.event_type, event: row.event_summary, chatMessages: row.chat_messages,
      ...(row.transcript ? { transcript: row.transcript } : {}),
    }));
  }

  async saveStreamEvent(event: StreamEvent): Promise<void> {
    await this.pool.query(
      'INSERT INTO stream_events (id, occurred_at, type, summary, importance, confidence, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [event.id, new Date(event.timestamp), event.type, event.summary, event.importance, event.confidence, event],
    );
  }

  async listStreamEvents(limit: number): Promise<StreamEvent[]> {
    const result = await this.pool.query<{ payload: StreamEvent }>('SELECT payload FROM stream_events ORDER BY occurred_at DESC LIMIT $1', [limit]);
    return result.rows.map((row) => row.payload);
  }

  async getSettings(): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{ value: Record<string, unknown> }>("SELECT value FROM app_settings WHERE key='runtime'");
    return result.rows[0]?.value ?? {};
  }

  async setSettings(settings: Record<string, unknown>): Promise<void> {
    const current = await this.getSettings();
    await this.pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('runtime',$1,NOW())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [{ ...current, ...settings }],
    );
  }

  async saveUsageSnapshot(snapshot: UsageSnapshot): Promise<void> {
    await this.pool.query('INSERT INTO usage_snapshots (metrics) VALUES ($1)', [snapshot]);
  }

  private async upsertPersonaWithClient(client: PoolClient, persona: BotPersona): Promise<void> {
    await client.query(
      `INSERT INTO personas (id, config, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`,
      [persona.id, persona],
    );
    await client.query('DELETE FROM persona_relationships WHERE persona_id=$1', [persona.id]);
    for (const relationship of persona.relationships) {
      await client.query(
        `INSERT INTO persona_relationships (persona_id, target_persona_id, familiarity, sentiment, notes, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [persona.id, relationship.targetPersonaId, relationship.familiarity, relationship.sentiment, relationship.notes],
      );
    }
  }

  private async savePersonaCanonBackupWithClient(client: PoolClient, backup: PersonaCanonBackupRecord): Promise<void> {
    await client.query(
      `INSERT INTO persona_canon_backups
       (persona_id, username, reason, generation_version, canon, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [backup.personaId, backup.username ?? null, backup.reason, backup.generationVersion, backup.canon, new Date(backup.createdAt)],
    );
  }
}

function mapTwitchCredential(row: {
  username: string; previous_username: string | null; twitch_user_id: string; access_token_ciphertext: string; refresh_token_ciphertext: string;
  scopes: string[]; expires_at: Date; refresh_state: EncryptedTwitchCredentialRecord['refreshState'];
  last_refresh_at: Date | null; last_refresh_error: string | null; updated_at: Date; credential_version: string;
}): EncryptedTwitchCredentialRecord {
  return {
    username: row.username,
    ...(row.previous_username ? { previousUsername: row.previous_username } : {}),
    userId: row.twitch_user_id,
    accessTokenCiphertext: row.access_token_ciphertext,
    refreshTokenCiphertext: row.refresh_token_ciphertext,
    scopes: row.scopes,
    expiresAt: row.expires_at.getTime(),
    refreshState: row.refresh_state,
    ...(row.last_refresh_at ? { lastRefreshAt: row.last_refresh_at.getTime() } : {}),
    ...(row.last_refresh_error ? { lastRefreshError: row.last_refresh_error } : {}),
    updatedAt: row.updated_at.getTime(),
    version: Number(row.credential_version),
  };
}
