import 'dotenv/config';
import { Pool } from 'pg';
import { runMigrations } from './run-migrations';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'false' ? undefined : { rejectUnauthorized: true },
  });
  try {
    await runMigrations(pool);
    console.log('Database migrations applied.');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
