import { Pool } from 'pg';
import { ReactionExample } from '../learning/types';
import { BotMessageRecord, BotPersona } from '../personas/types';
import { StreamEvent } from '../stream-brain/types';
import { UsageSnapshot } from '../usage/usage-tracker';
import { AppRepository, BotAccountRecord } from './repository';
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
    const result = await this.pool.query<{ config: BotPersona }>('SELECT config FROM personas ORDER BY id');
    return result.rows.map((row) => row.config);
  }

  async upsertPersona(persona: BotPersona): Promise<void> {
    await this.pool.query(
      `INSERT INTO personas (id, config, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`,
      [persona.id, persona],
    );
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
}
