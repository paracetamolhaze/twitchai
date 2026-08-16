import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool, PoolClient } from 'pg';

const MIGRATIONS = [
  '001_initial.sql',
  '002_twitch_oauth.sql',
  '003_twitch_oauth_credential_version.sql',
  '004_deep_personas.sql',
  '005_deep_persona_generation_v3.sql',
  '006_global_streamer_memory.sql',
  '007_bot_message_event_id_text.sql',
];

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(8436172201)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    for (const name of MIGRATIONS) await applyMigration(client, name);
  } finally {
    await client.query('SELECT pg_advisory_unlock(8436172201)').catch(() => undefined);
    client.release();
  }
}

async function applyMigration(client: PoolClient, name: string): Promise<void> {
  const exists = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
  if (exists.rowCount) return;
  const sql = await readFile(path.resolve(process.cwd(), 'migrations', name), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
