import 'dotenv/config';
import { z } from 'zod';
import { OpenRouterBrainClient } from '../brain/openrouter-brain.client';
import { BRAIN_DECISION_RESPONSE_SCHEMA } from '../brain/gemini-brain.service';
import { Logger } from '../logger';
import { PostgresRepository } from '../persistence/postgres-repository';
import { mockReplayBrain, ReplayBrain, ReplayResult, runReplay } from './replay';

/**
 * npm run replay [-- --limit 50 --live --model some/model]
 *
 * Default is the deterministic mock: no model, no key, no cost, same output for the same stored
 * events every time. --live is an explicit opt-in that replays the same evenings through a real
 * model (--model or REPLAY_BRAIN_MODEL, falling back to BRAIN_MODEL) — for asking "would a
 * different model have spoken differently on identical evidence". Either way the production
 * database is opened read-only and no send path exists in the process.
 */

interface CliArgs {
  live: boolean;
  model?: string;
  limit: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { live: false, limit: 50, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--live') args.live = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--model') args.model = argv[++index];
    else if (arg === '--limit') args.limit = Math.max(1, Math.min(500, Number(argv[++index]) || 50));
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

const liveReactionSchema = z.object({
  reactions: z.array(z.object({
    username: z.string(),
    message: z.string(),
    motive: z.string().optional(),
    sourceType: z.string().optional(),
    sourceRef: z.string().optional(),
  }).passthrough()).default([]),
}).passthrough();

/**
 * One stateless interaction per event — no conversation chain, no bootstrap. Deliberately simpler
 * than the production Brain: replay compares model judgement on identical evidence, not the whole
 * session protocol.
 */
function liveBrain(model: string, apiKey: string, logger: Logger): ReplayBrain {
  const client = new OpenRouterBrainClient({ apiKey, logger, appName: 'twitchai-replay' });
  return async ({ event, offered, mindContext }) => {
    const input = JSON.stringify({
      event: { type: event.type, summary: event.summary, speech: event.speech, importance: event.importance },
      availableBots: offered.map((candidate) => candidate.username),
      personas: offered.map((candidate) => ({
        username: candidate.username,
        identity: candidate.persona.description.slice(0, 300),
        expertise: candidate.persona.knowledge.expertise,
      })),
      ...(mindContext ? { mindContext: { guidance: mindContext.guidance, byPersona: mindContext.byPersona } } : {}),
    });
    const response = await client.create({
      kind: 'decision',
      model,
      input,
      systemInstruction: 'You decide which (if any) of the available viewer accounts reacts to this Twitch stream moment, '
        + 'and write the reaction in casual Russian Twitch chat register. Silence (empty reactions) is a valid answer. '
        + 'Report motive and sourceType honestly; use sourceType none when the message has no personal origin.',
      responseSchema: BRAIN_DECISION_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      thinkingLevel: 'low',
      maxOutputTokens: 2_048,
      store: true,
    });
    if (!response.outputText) return [];
    try {
      return liveReactionSchema.parse(JSON.parse(response.outputText)).reactions;
    } catch {
      logger.warn('Live replay decision unparseable', { eventId: event.id });
      return [];
    }
  };
}

function printReport(result: ReplayResult): void {
  for (const outcome of result.outcomes) {
    const time = new Date(outcome.timestamp).toISOString().slice(11, 19);
    console.log(`\n[${time}] ${outcome.type} — ${outcome.summary}`);
    console.log(`  offered: ${outcome.offered.join(', ') || '(nobody)'}`);
    console.log(`  observed: ${outcome.observation.observed}/${outcome.observation.considered}`
      + ` (memory writes: ${outcome.observation.memoryWrites}, knowledge: ${outcome.observation.knowledgeUpdates})`);
    for (const reaction of outcome.reactions) {
      const source = reaction.sourceType
        ? ` [${reaction.motive ?? '?'}/${reaction.sourceType}${reaction.sourceRef ? `(${reaction.sourceRef})` : ''}]`
        : '';
      const verdict = reaction.outcome === 'would_send'
        ? `provenance=${reaction.provenance.validationReason}`
        : `REJECTED: ${reaction.outcome === 'naturalness_rejected' ? reaction.naturalness : 'invalid_motive_source'}`;
      console.log(`  ${reaction.username}: "${reaction.message}"${source} — ${verdict}`);
    }
    if (outcome.reactions.length === 0) console.log('  (silence)');
  }
  console.log(`\n=== ${result.events} events: ${result.wouldSend} would send, `
    + `${result.naturalnessRejected} naturalness-rejected, ${result.invalidMotiveSource} invalid source; `
    + `observation ${result.observation.observed}/${result.observation.considered}, `
    + `${result.observation.memoryWrites} memory writes, ${result.observation.loopsResolved} loops resolved ===`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL is required (read-only access; no writes are possible from replay).');
    process.exit(2);
  }
  const logger = new Logger('REPLAY', 'warn');
  let brain: ReplayBrain = mockReplayBrain;
  if (args.live) {
    const apiKey = process.env['OPENROUTER_API_KEY'];
    const model = args.model ?? process.env['REPLAY_BRAIN_MODEL'] ?? process.env['BRAIN_MODEL'];
    if (!apiKey || !model) {
      console.error('--live requires OPENROUTER_API_KEY and a model (--model / REPLAY_BRAIN_MODEL / BRAIN_MODEL).');
      process.exit(2);
    }
    brain = liveBrain(model, apiKey, logger);
    console.log(`Replaying LIVE against ${model} — model cost applies; Twitch and DB writes remain impossible.`);
  } else {
    console.log('Replaying with the deterministic mock brain (no model calls). Use --live --model to compare a real model.');
  }

  const repository = new PostgresRepository(databaseUrl, databaseUrl.includes('railway') || databaseUrl.includes('sslmode=require'));
  try {
    const result = await runReplay({ repository, brain, limit: args.limit, logger });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printReport(result);
  } finally {
    await repository.close();
  }
}

void main().catch((cause) => {
  console.error('Replay failed:', cause instanceof Error ? cause.message : cause);
  process.exit(1);
});
