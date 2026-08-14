import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BotMessageRecord, BotPersona } from '../personas/types';
import { upgradePersona } from '../personas/schema';
import { normalizeChannel } from '../config';
import { PostgresRepository } from './postgres-repository';

const legacyMessageSchema = z.object({
  role: z.string(), content: z.string(), time: z.number().optional(),
}).passthrough();
const legacyConfigSchema = z.object({
  personas: z.record(z.object({ role: z.string().optional(), sys: z.string().optional() }).passthrough()).default({}),
  botHistories: z.record(z.array(legacyMessageSchema)).default({}),
  transcriptHistory: z.array(z.object({
    timestamp: z.number().optional(),
    responses: z.array(z.object({ username: z.string(), message: z.string() })).default([]),
  }).passthrough()).default([]),
}).passthrough();

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run db:import:legacy -- C:\\path\\to\\config-channel.json');
  const source = legacyConfigSchema.parse(JSON.parse(await readFile(path.resolve(file), 'utf8')));
  const repository = new PostgresRepository(databaseUrl, process.env.DATABASE_SSL !== 'false');
  await repository.initialize();
  try {
    const existingBots = new Map((await repository.listBots()).map((bot) => [bot.username, bot]));
    let personasImported = 0;
    let messagesImported = 0;
    const knownMessages = new Map<string, Set<string>>();
    const importedStats = new Map<string, { count: number; lastMessage: string; lastReactionAt: number }>();

    for (const [rawUsername, config] of Object.entries(source.personas)) {
      const username = rawUsername.toLowerCase();
      const persona = legacyPersona(username, config.role, config.sys);
      await repository.upsertPersona(persona);
      const previous = existingBots.get(username);
      await repository.upsertBot({
        username,
        personaId: persona.id,
        enabled: previous?.enabled ?? true,
        connectionState: 'DISCONNECTED',
        chatConnected: false,
        messagesSent: previous?.messagesSent ?? 0,
        ...(previous?.lastMessage ? { lastMessage: previous.lastMessage } : {}),
        ...(previous?.lastReactionAt ? { lastReactionAt: previous.lastReactionAt } : {}),
      });
      personasImported += 1;
    }

    const save = async (usernameValue: string, message: string, sentAt: number): Promise<void> => {
      const username = usernameValue.toLowerCase();
      const normalized = message.trim();
      if (!username || !normalized) return;
      let known = knownMessages.get(username);
      if (!known) {
        known = new Set((await repository.listBotMessages(username, 1_000)).map((item) => item.message.trim().toLowerCase()));
        knownMessages.set(username, known);
      }
      if (known.has(normalized.toLowerCase())) return;
      const record: BotMessageRecord = { id: randomUUID(), username, message: normalized, sentAt };
      await repository.saveBotMessage(record);
      known.add(normalized.toLowerCase());
      const stats = importedStats.get(username);
      if (!stats || sentAt >= stats.lastReactionAt) {
        importedStats.set(username, { count: (stats?.count ?? 0) + 1, lastMessage: normalized, lastReactionAt: sentAt });
      } else {
        stats.count += 1;
      }
      messagesImported += 1;
    };

    for (const [username, messages] of Object.entries(source.botHistories)) {
      for (const [index, message] of messages.entries()) {
        if (message.role !== 'assistant') continue;
        await save(username, message.content, message.time ?? Date.now() - (messages.length - index) * 1_000);
      }
    }
    for (const transcript of source.transcriptHistory) {
      for (const response of transcript.responses) await save(response.username, response.message, transcript.timestamp ?? Date.now());
    }
    const botsAfterPersonaImport = new Map((await repository.listBots()).map((bot) => [bot.username, bot]));
    for (const [username, stats] of importedStats) {
      const previous = botsAfterPersonaImport.get(username);
      const persona = previous ? undefined : legacyPersona(username);
      if (persona) await repository.upsertPersona(persona);
      await repository.upsertBot({
        username,
        personaId: previous?.personaId ?? persona!.id,
        enabled: previous?.enabled ?? true,
        connectionState: 'DISCONNECTED',
        chatConnected: false,
        messagesSent: Math.max(previous?.messagesSent ?? 0, stats.count),
        lastMessage: stats.lastMessage,
        lastReactionAt: stats.lastReactionAt,
      });
    }
    const channel = process.env.LEGACY_CHANNEL ? normalizeChannel(process.env.LEGACY_CHANNEL) : '';
    if (channel) await repository.setSettings({ channel });
    console.log(`Imported ${personasImported} legacy personas and ${messagesImported} unique bot messages into PostgreSQL.`);
    console.log('Legacy Markov chains and uncoupled real-chat samples were intentionally not imported into ReactionMemory.');
  } finally {
    await repository.close();
  }
}

function legacyPersona(username: string, role?: string, instructions?: string): BotPersona {
  return upgradePersona({
    id: `legacy-${username.replace(/[^a-z0-9_-]/g, '-').slice(0, 60)}`,
    name: `Импортированная персона: ${username}`,
    description: role ? `Персона из старой версии (${role}).` : 'Персона из старой версии.',
    styleInstructions: instructions?.trim() || 'Сохраняй старый стиль, но не выдумывай личные факты без заполненного canon.',
    interests: [],
    verbosity: { minWords: 2, maxWords: 14 },
    reactionProbability: 0.4,
    minimumIntervalMs: 60_000,
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
