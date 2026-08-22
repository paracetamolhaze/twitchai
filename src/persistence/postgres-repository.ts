import { Pool, PoolClient } from 'pg';
import { StreamerMemory, StreamSession } from '../global-memory/types';
import { ReactionExample } from '../learning/types';
import { LearnedPolicyRule, LearnedRuleScope, LearnedRuleStatus } from '../learning/learned-policy.types';
import { PersonaMindRecord } from '../personas/persona-mind';
import {
  BotMessageRecord,
  MessageVerdictRecord,
  BotPersona,
  PersonaConversationMessage,
  PersonaMemoryItem,
  PersonaRelationship,
} from '../personas/types';
import { SentMessageMotiveRecord } from '../reaction/types';
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
      // chat_messages is JSONB. node-postgres renders a JS array as a Postgres array literal
      // ({a,b}), which JSONB rejects with "invalid input syntax for type json" — every save failed
      // in production. Objects are JSON-serialized by the driver, which is why the payload/config/
      // metrics columns nearby work untouched; only this array parameter needs explicit stringify.
      [example.id, new Date(example.timestamp), example.game, example.streamContext, example.eventType,
        example.event, example.transcript ?? null, JSON.stringify(example.chatMessages)],
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

  async saveMessageVerdict(verdict: MessageVerdictRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO message_verdicts (id, created_at, username, message, verdict, note, event_summary, event_id,
         reaction_id, link_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [verdict.id, new Date(verdict.createdAt), verdict.username, verdict.message, verdict.verdict,
        verdict.note ?? null, verdict.eventSummary ?? null, verdict.eventId ?? null,
        verdict.reactionId ?? null, verdict.linkKind ?? 'legacy'],
    );
  }

  async listMessageVerdicts(limit: number): Promise<MessageVerdictRecord[]> {
    const result = await this.pool.query<MessageVerdictRow>(
      `SELECT id, created_at, username, message, verdict, note, event_summary, event_id, processed_at,
              reaction_id, link_kind
       FROM message_verdicts ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(toMessageVerdict);
  }

  async listUnprocessedMessageVerdicts(limit: number): Promise<MessageVerdictRecord[]> {
    const result = await this.pool.query<MessageVerdictRow>(
      `SELECT id, created_at, username, message, verdict, note, event_summary, event_id, processed_at,
              reaction_id, link_kind
       FROM message_verdicts WHERE processed_at IS NULL ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map(toMessageVerdict);
  }

  async saveSentMessageMotive(record: SentMessageMotiveRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO sent_message_motives (id, created_at, username, message, event_id, trigger_kind,
         motive, source_type, source_ref, source_validated, validated_source_type, learned_rule_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [record.id, new Date(record.createdAt), record.username, record.message, record.eventId,
        record.triggerKind, record.motive, record.sourceType, record.sourceRef ?? null,
        record.sourceValidated, record.validatedSourceType ?? null, JSON.stringify(record.learnedRuleIds)],
    );
  }

  async listSentMessageMotives(limit: number): Promise<SentMessageMotiveRecord[]> {
    const result = await this.pool.query<SentMessageMotiveRow>(
      `SELECT id, created_at, username, message, event_id, trigger_kind, motive, source_type,
              source_ref, source_validated, validated_source_type, learned_rule_ids
       FROM sent_message_motives ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(toSentMessageMotive);
  }

  async getSentMessageMotive(reactionId: string): Promise<SentMessageMotiveRecord | undefined> {
    const result = await this.pool.query<SentMessageMotiveRow>(
      `SELECT id, created_at, username, message, event_id, trigger_kind, motive, source_type,
              source_ref, source_validated, validated_source_type, learned_rule_ids
       FROM sent_message_motives WHERE id=$1`,
      [reactionId],
    );
    const row = result.rows[0];
    return row ? toSentMessageMotive(row) : undefined;
  }

  async getStreamEvent(id: string): Promise<StreamEvent | undefined> {
    const result = await this.pool.query<{ payload: StreamEvent }>(
      'SELECT payload FROM stream_events WHERE id=$1', [id],
    );
    return result.rows[0]?.payload;
  }

  async listPersonaMinds(): Promise<PersonaMindRecord[]> {
    const result = await this.pool.query<{ mind: PersonaMindRecord }>('SELECT mind FROM persona_minds');
    return result.rows.map((row) => row.mind);
  }

  async savePersonaMind(record: PersonaMindRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO persona_minds (persona_id, username, mind, seed_version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (persona_id) DO UPDATE SET
         username=EXCLUDED.username, mind=EXCLUDED.mind, seed_version=EXCLUDED.seed_version,
         updated_at=EXCLUDED.updated_at`,
      [record.personaId, record.username, record, record.seedVersion,
        new Date(record.createdAt), new Date(record.updatedAt)],
    );
  }

  async deletePersonaMind(personaId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM persona_minds WHERE persona_id=$1', [personaId]);
    return (result.rowCount ?? 0) > 0;
  }

  async listLearnedPolicyRules(): Promise<LearnedPolicyRule[]> {
    const result = await this.pool.query<LearnedPolicyRuleRow>(
      `SELECT id, scope_type, scope_key, rule, rationale, confidence, support_count, positive_evidence,
              negative_evidence, status, teacher_model, evidence_ids, created_at, updated_at, version
       FROM learned_policy_rules ORDER BY updated_at DESC`,
    );
    return result.rows.map(toLearnedPolicyRule);
  }

  async applyLearnedPolicyBatch(input: {
    upserts: LearnedPolicyRule[];
    processedVerdictIds: string[];
    processedAt: number;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const rule of input.upserts) {
        await client.query(
          `INSERT INTO learned_policy_rules
             (id, scope_type, scope_key, rule, rationale, confidence, support_count, positive_evidence,
              negative_evidence, status, teacher_model, evidence_ids, created_at, updated_at, version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (id) DO UPDATE SET
             scope_type=EXCLUDED.scope_type, scope_key=EXCLUDED.scope_key, rule=EXCLUDED.rule,
             rationale=EXCLUDED.rationale, confidence=EXCLUDED.confidence,
             support_count=EXCLUDED.support_count, positive_evidence=EXCLUDED.positive_evidence,
             negative_evidence=EXCLUDED.negative_evidence, status=EXCLUDED.status,
             teacher_model=EXCLUDED.teacher_model, evidence_ids=EXCLUDED.evidence_ids,
             updated_at=EXCLUDED.updated_at, version=EXCLUDED.version`,
          [rule.id, rule.scopeType, rule.scopeKey, rule.rule, rule.rationale, rule.confidence,
            rule.supportCount, rule.positiveEvidence, rule.negativeEvidence, rule.status,
            rule.teacherModel, JSON.stringify(rule.evidenceIds), new Date(rule.createdAt),
            new Date(rule.updatedAt), rule.version],
        );
      }
      if (input.processedVerdictIds.length > 0) {
        await client.query(
          'UPDATE message_verdicts SET processed_at=$1 WHERE id = ANY($2::uuid[])',
          [new Date(input.processedAt), input.processedVerdictIds],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async setLearnedPolicyRuleStatus(id: string, status: LearnedRuleStatus): Promise<LearnedPolicyRule | undefined> {
    const result = await this.pool.query<LearnedPolicyRuleRow>(
      `UPDATE learned_policy_rules SET status=$2, updated_at=NOW() WHERE id=$1
       RETURNING id, scope_type, scope_key, rule, rationale, confidence, support_count, positive_evidence,
                 negative_evidence, status, teacher_model, evidence_ids, created_at, updated_at, version`,
      [id, status],
    );
    const row = result.rows[0];
    return row ? toLearnedPolicyRule(row) : undefined;
  }

  async deleteLearnedPolicyRule(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM learned_policy_rules WHERE id=$1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async saveStreamEvent(event: StreamEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO stream_events (id, occurred_at, type, summary, importance, confidence, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         occurred_at=EXCLUDED.occurred_at, type=EXCLUDED.type, summary=EXCLUDED.summary,
         importance=EXCLUDED.importance, confidence=EXCLUDED.confidence, payload=EXCLUDED.payload`,
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

  async startOrResumeStreamSession(session: StreamSession, staleBefore: number): Promise<StreamSession> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // A transactional advisory lock makes restart races deterministic even
      // before the partial unique index can reject a second live session.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [session.channel]);
      await client.query(
        `UPDATE stream_sessions SET status='interrupted', ended_at=last_seen_at
         WHERE channel=$1 AND status='live' AND last_seen_at <= $2`,
        [session.channel, new Date(staleBefore)],
      );
      const active = await client.query<StreamSessionRow>(
        `SELECT id, channel, started_at, last_seen_at, ended_at, initial_category, initial_stream_context, status, summary
         FROM stream_sessions WHERE channel=$1 AND status='live'
         ORDER BY started_at DESC, id ASC LIMIT 1 FOR UPDATE`,
        [session.channel],
      );
      if (active.rows[0]) {
        await client.query('COMMIT');
        return mapStreamSession(active.rows[0]);
      }
      await client.query(
        `INSERT INTO stream_sessions
         (id, channel, started_at, last_seen_at, ended_at, initial_category, initial_stream_context, status, summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [session.id, session.channel, new Date(session.startedAt), new Date(session.lastSeenAt), session.endedAt ? new Date(session.endedAt) : null,
          session.initialCategory ?? null, session.initialStreamContext ?? null, session.status, session.summary ?? null],
      );
      await client.query('COMMIT');
      return structuredClone(session);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async saveStreamSession(session: StreamSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO stream_sessions
       (id, channel, started_at, last_seen_at, ended_at, initial_category, initial_stream_context, status, summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at, ended_at=EXCLUDED.ended_at,
       initial_category=EXCLUDED.initial_category, initial_stream_context=EXCLUDED.initial_stream_context,
       status=EXCLUDED.status, summary=EXCLUDED.summary`,
      [session.id, session.channel, new Date(session.startedAt), new Date(session.lastSeenAt), session.endedAt ? new Date(session.endedAt) : null,
        session.initialCategory ?? null, session.initialStreamContext ?? null, session.status, session.summary ?? null],
    );
  }

  async getStreamSession(id: string): Promise<StreamSession | undefined> {
    const result = await this.pool.query<StreamSessionRow>(
      `SELECT id, channel, started_at, last_seen_at, ended_at, initial_category, initial_stream_context, status, summary
       FROM stream_sessions WHERE id=$1`,
      [id],
    );
    return result.rows[0] ? mapStreamSession(result.rows[0]) : undefined;
  }

  async listStreamSessions(channel: string, limit: number): Promise<StreamSession[]> {
    const result = await this.pool.query<StreamSessionRow>(
      `SELECT id, channel, started_at, last_seen_at, ended_at, initial_category, initial_stream_context, status, summary
       FROM stream_sessions WHERE channel=$1 ORDER BY started_at DESC, id ASC LIMIT $2`,
      [channel.toLowerCase(), limit],
    );
    return result.rows.map(mapStreamSession);
  }

  async withStreamerMemoryTransaction<T>(
    channel: string,
    operation: (transaction: StreamerMemoryTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // A Live reconnect can overlap a previous tool call. Serializing by
      // channel keeps merge/reconciliation read-modify-write operations safe.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [channel.toLowerCase()]);
      const transaction: StreamerMemoryTransaction = {
        getStreamerMemory: async (id) => {
          const result = await client.query<StreamerMemoryRow>(`${STREAMER_MEMORY_SELECT} WHERE id=$1`, [id]);
          return result.rows[0] ? mapStreamerMemory(result.rows[0]) : undefined;
        },
        findActiveStreamerMemoryByDedupeKey: async (memoryChannel, dedupeKey) => {
          const result = await client.query<StreamerMemoryRow>(
            `${STREAMER_MEMORY_SELECT} WHERE channel=$1 AND dedupe_key=$2 AND status='active' LIMIT 1`,
            [memoryChannel.toLowerCase(), dedupeKey],
          );
          return result.rows[0] ? mapStreamerMemory(result.rows[0]) : undefined;
        },
        saveStreamerMemory: async (memory) => this.saveStreamerMemoryWithClient(client, memory),
      };
      const result = await operation(transaction);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async saveStreamerMemory(memory: StreamerMemory): Promise<void> {
    await this.saveStreamerMemoryWithClient(this.pool, memory);
  }

  private async saveStreamerMemoryWithClient(client: Pool | PoolClient, memory: StreamerMemory): Promise<void> {
    await client.query(
      `INSERT INTO streamer_memories
       (id, channel, type, summary, details, entities, tags, importance, confidence, occurred_at,
        created_at, updated_at, last_seen_at, confirmation_count, source_session_id, source_event_id,
        status, expires_at, resolved_at, superseded_by, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type, summary=EXCLUDED.summary, details=EXCLUDED.details,
       entities=EXCLUDED.entities, tags=EXCLUDED.tags, importance=EXCLUDED.importance, confidence=EXCLUDED.confidence,
       occurred_at=EXCLUDED.occurred_at, updated_at=EXCLUDED.updated_at, last_seen_at=EXCLUDED.last_seen_at,
       confirmation_count=EXCLUDED.confirmation_count, source_session_id=EXCLUDED.source_session_id,
       source_event_id=EXCLUDED.source_event_id, status=EXCLUDED.status, expires_at=EXCLUDED.expires_at,
       resolved_at=EXCLUDED.resolved_at, superseded_by=EXCLUDED.superseded_by, dedupe_key=EXCLUDED.dedupe_key`,
      streamerMemoryParams(memory),
    );
  }

  async getStreamerMemory(id: string): Promise<StreamerMemory | undefined> {
    const result = await this.pool.query<StreamerMemoryRow>(`${STREAMER_MEMORY_SELECT} WHERE id=$1`, [id]);
    return result.rows[0] ? mapStreamerMemory(result.rows[0]) : undefined;
  }

  async listStreamerMemories(channel: string, limit: number): Promise<StreamerMemory[]> {
    const result = await this.pool.query<StreamerMemoryRow>(
      `${STREAMER_MEMORY_SELECT} WHERE channel=$1 ORDER BY updated_at DESC, importance DESC, id ASC LIMIT $2`,
      [channel.toLowerCase(), limit],
    );
    return result.rows.map(mapStreamerMemory);
  }

  async findActiveStreamerMemoryByDedupeKey(channel: string, dedupeKey: string): Promise<StreamerMemory | undefined> {
    const result = await this.pool.query<StreamerMemoryRow>(
      `${STREAMER_MEMORY_SELECT} WHERE channel=$1 AND dedupe_key=$2 AND status='active' LIMIT 1`,
      [channel.toLowerCase(), dedupeKey],
    );
    return result.rows[0] ? mapStreamerMemory(result.rows[0]) : undefined;
  }

  async expireStreamerMemories(channel: string, now: number): Promise<number> {
    const result = await this.pool.query(
      `UPDATE streamer_memories SET status='expired', updated_at=$2
       WHERE channel=$1 AND status='active' AND expires_at IS NOT NULL AND expires_at <= $2`,
      [channel.toLowerCase(), new Date(now)],
    );
    return result.rowCount ?? 0;
  }

  async deleteStreamerMemory(id: string, channel?: string): Promise<boolean> {
    const result = channel
      ? await this.pool.query('DELETE FROM streamer_memories WHERE id=$1 AND channel=$2', [id, channel.toLowerCase()])
      : await this.pool.query('DELETE FROM streamer_memories WHERE id=$1', [id]);
    return Boolean(result.rowCount);
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

interface StreamSessionRow {
  id: string;
  channel: string;
  started_at: Date;
  last_seen_at: Date;
  ended_at: Date | null;
  initial_category: string | null;
  initial_stream_context: string | null;
  status: StreamSession['status'];
  summary: string | null;
}

interface StreamerMemoryRow {
  id: string;
  channel: string;
  type: StreamerMemory['type'];
  summary: string;
  details: Record<string, unknown> | null;
  entities: string[];
  tags: string[];
  importance: number;
  confidence: number;
  occurred_at: Date | null;
  created_at: Date;
  updated_at: Date;
  last_seen_at: Date;
  confirmation_count: number;
  source_session_id: string | null;
  source_event_id: string | null;
  status: StreamerMemory['status'];
  expires_at: Date | null;
  resolved_at: Date | null;
  superseded_by: string | null;
  dedupe_key: string;
}

const STREAMER_MEMORY_SELECT = `SELECT id, channel, type, summary, details, entities, tags, importance, confidence,
  occurred_at, created_at, updated_at, last_seen_at, confirmation_count, source_session_id, source_event_id,
  status, expires_at, resolved_at, superseded_by, dedupe_key FROM streamer_memories`;

function mapStreamSession(row: StreamSessionRow): StreamSession {
  return {
    id: row.id,
    channel: row.channel,
    startedAt: row.started_at.getTime(),
    lastSeenAt: row.last_seen_at.getTime(),
    ...(row.ended_at ? { endedAt: row.ended_at.getTime() } : {}),
    ...(row.initial_category ? { initialCategory: row.initial_category } : {}),
    ...(row.initial_stream_context ? { initialStreamContext: row.initial_stream_context } : {}),
    status: row.status,
    ...(row.summary ? { summary: row.summary } : {}),
  };
}

function mapStreamerMemory(row: StreamerMemoryRow): StreamerMemory {
  return {
    id: row.id,
    channel: row.channel,
    type: row.type,
    summary: row.summary,
    ...(row.details ? { details: row.details } : {}),
    entities: row.entities,
    tags: row.tags,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    ...(row.occurred_at ? { occurredAt: row.occurred_at.getTime() } : {}),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    lastSeenAt: row.last_seen_at.getTime(),
    confirmationCount: Number(row.confirmation_count),
    ...(row.source_session_id ? { sourceSessionId: row.source_session_id } : {}),
    ...(row.source_event_id ? { sourceEventId: row.source_event_id } : {}),
    status: row.status,
    ...(row.expires_at ? { expiresAt: row.expires_at.getTime() } : {}),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at.getTime() } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    dedupeKey: row.dedupe_key,
  };
}

interface SentMessageMotiveRow {
  id: string; created_at: Date; username: string; message: string; event_id: string;
  trigger_kind: SentMessageMotiveRecord['triggerKind']; motive: string; source_type: string;
  source_ref: string | null; source_validated: boolean; validated_source_type: string | null;
  learned_rule_ids: string[];
}

function toSentMessageMotive(row: SentMessageMotiveRow): SentMessageMotiveRecord {
  return {
    id: row.id, createdAt: row.created_at.getTime(), username: row.username, message: row.message,
    eventId: row.event_id, triggerKind: row.trigger_kind, motive: row.motive, sourceType: row.source_type,
    sourceValidated: row.source_validated, learnedRuleIds: row.learned_rule_ids,
    ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
    ...(row.validated_source_type ? { validatedSourceType: row.validated_source_type } : {}),
  };
}

interface MessageVerdictRow {
  id: string; created_at: Date; username: string; message: string; verdict: string;
  note: string | null; event_summary: string | null; event_id: string | null; processed_at: Date | null;
  reaction_id: string | null; link_kind: string | null;
}

function toMessageVerdict(row: MessageVerdictRow): MessageVerdictRecord {
  return {
    id: row.id,
    createdAt: row.created_at.getTime(),
    username: row.username,
    message: row.message,
    verdict: row.verdict === 'good' ? 'good' : 'bad',
    ...(row.note ? { note: row.note } : {}),
    ...(row.event_summary ? { eventSummary: row.event_summary } : {}),
    ...(row.event_id ? { eventId: row.event_id } : {}),
    ...(row.processed_at ? { processedAt: row.processed_at.getTime() } : {}),
    ...(row.reaction_id ? { reactionId: row.reaction_id } : {}),
    linkKind: row.link_kind === 'exact' || row.link_kind === 'lost' ? row.link_kind : 'legacy',
  };
}

interface LearnedPolicyRuleRow {
  id: string; scope_type: string; scope_key: string; rule: string; rationale: string;
  confidence: string | number; support_count: number; positive_evidence: number;
  negative_evidence: number; status: string; teacher_model: string; evidence_ids: unknown;
  created_at: Date; updated_at: Date; version: number;
}

function toLearnedPolicyRule(row: LearnedPolicyRuleRow): LearnedPolicyRule {
  return {
    id: row.id,
    scopeType: row.scope_type as LearnedRuleScope,
    scopeKey: row.scope_key,
    rule: row.rule,
    rationale: row.rationale,
    confidence: Number(row.confidence),
    supportCount: Number(row.support_count),
    positiveEvidence: Number(row.positive_evidence),
    negativeEvidence: Number(row.negative_evidence),
    status: row.status as LearnedRuleStatus,
    teacherModel: row.teacher_model,
    evidenceIds: Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : [],
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    version: Number(row.version),
  };
}

function streamerMemoryParams(memory: StreamerMemory): unknown[] {
  return [
    memory.id, memory.channel, memory.type, memory.summary, memory.details ?? null, memory.entities, memory.tags,
    memory.importance, memory.confidence, memory.occurredAt ? new Date(memory.occurredAt) : null,
    new Date(memory.createdAt), new Date(memory.updatedAt), new Date(memory.lastSeenAt), memory.confirmationCount,
    memory.sourceSessionId ?? null, memory.sourceEventId ?? null, memory.status,
    memory.expiresAt ? new Date(memory.expiresAt) : null, memory.resolvedAt ? new Date(memory.resolvedAt) : null,
    memory.supersededBy ?? null, memory.dedupeKey,
  ];
}
