import { createHash } from 'node:crypto';
import { Logger } from '../logger';
import { AppRepository, BotAccountRecord } from '../persistence/repository';
import { BotPersona } from '../personas/types';
import {
  emptySuppliedSources,
  MindContext,
  ObservationStats,
  PersonaMindRecord,
  PersonaMindStore,
} from '../personas/persona-mind';
import { shortlistCandidates } from '../reaction/candidate-shortlist';
import { emptyProvenancePools, ProvenancePools, ProvenanceVerdict, validateMotiveProvenance } from '../reaction/motive-provenance';
import { NaturalnessGuard } from '../reaction/naturalness-guard';
import { ReactionBotCandidate } from '../reaction/types';
import { StreamEvent } from '../stream-brain/types';

/**
 * Offline replay of a recorded evening through the decision pipeline's deterministic layers —
 * shortlisting, mind slices, observation, naturalness, provenance — with the model swapped out.
 *
 * Two structural guarantees, enforced by construction rather than by care:
 *
 *  1. Nothing can reach Twitch. This module and its CLI never import a sender, a bot manager, or
 *     anything from src/twitch — there is no send path to accidentally call. A "reaction" here is a
 *     line in the report.
 *  2. Nothing can reach the production database as a write. Every repository handed to the replay
 *     is wrapped in readOnlyRepository, which replaces every non-read method with a throw; the
 *     mind store — the one layer that persists as a side effect of observing — runs against an
 *     in-memory sandbox copy of the minds instead.
 *
 * The default brain is a deterministic mock: same events in, same report out, forever — which is
 * what makes a replay diffable across code changes. --live swaps in a real model via the CLI for
 * comparing model behaviour on identical evidence, and changes neither guarantee.
 */

const READ_METHOD_PREFIXES = ['list', 'get', 'find', 'healthCheck'];

/** Methods allowed through the read-only wall. `close` releases the pool; everything else must be a read. */
function isReadMethod(name: string): boolean {
  return name === 'close' || READ_METHOD_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Every mutating repository method replaced with a throw. Note `initialize` is blocked too: on the
 * Postgres implementation it runs migrations, which is a write path however innocent it looks.
 */
export function readOnlyRepository(repository: AppRepository): AppRepository {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      if (!isReadMethod(property)) {
        // Async so the failure surfaces as a rejection, matching the promise-returning interface it
        // stands in for — a sync throw inside a fire-and-forget call site would escape any .catch.
        return async () => { throw new Error(`replay_write_blocked:${property}`); };
      }
      return value.bind(target);
    },
  });
}

/** In-memory copy of the minds, so observation during replay mutates the copy and only the copy. */
function sandboxMindRepository(minds: PersonaMindRecord[]): {
  listPersonaMinds(): Promise<PersonaMindRecord[]>;
  savePersonaMind(record: PersonaMindRecord): Promise<void>;
  deletePersonaMind(personaId: string): Promise<boolean>;
} {
  const store = new Map(minds.map((mind) => [mind.personaId, structuredClone(mind)]));
  return {
    listPersonaMinds: async () => [...store.values()].map((mind) => structuredClone(mind)),
    savePersonaMind: async (record) => { store.set(record.personaId, structuredClone(record)); },
    deletePersonaMind: async (personaId) => store.delete(personaId),
  };
}

export interface ReplayBrainInput {
  event: StreamEvent;
  offered: ReactionBotCandidate[];
  mindContext?: MindContext;
}

export interface ReplayBrainReaction {
  username: string;
  message: string;
  motive?: string;
  sourceType?: string;
  sourceRef?: string;
}

export type ReplayBrain = (input: ReplayBrainInput) => Promise<ReplayBrainReaction[]>;

/**
 * The default brain: no network, no key, no randomness. Selection is a hash of the event id over
 * the offered list; the claimed source is the first thing the mind slice actually supplied for the
 * selected persona, so provenance validation exercises its confirm path — and claiming a source on
 * an empty slice exercises its reject path, which is equally the point.
 */
export const mockReplayBrain: ReplayBrain = async ({ event, offered, mindContext }) => {
  if (offered.length === 0) return [];
  const digest = createHash('sha256').update(event.id).digest();
  const chosen = offered[digest.readUInt32BE(0) % offered.length]!;
  const supplied = mindContext?.supplied[chosen.username] ?? emptySuppliedSources();
  const sourced: Array<{ sourceType: string; ref: string }> = [
    ...supplied.curiosity.map((ref) => ({ sourceType: 'curiosity', ref })),
    ...supplied.open_loop.map((ref) => ({ sourceType: 'open_loop', ref })),
    ...supplied.current_life.map((ref) => ({ sourceType: 'current_life', ref })),
    ...supplied.knowledge_gap.map((ref) => ({ sourceType: 'knowledge_gap', ref })),
  ];
  const source = sourced[0];
  return [{
    username: chosen.username,
    message: `[replay] ${event.summary.slice(0, 80)}`,
    motive: source ? 'ask' : 'react',
    sourceType: source?.sourceType ?? 'event_emotion',
    ...(source ? { sourceRef: source.ref.slice(0, 100) } : {}),
  }];
};

export interface ReplayReactionOutcome {
  username: string;
  message: string;
  motive?: string;
  sourceType?: string;
  sourceRef?: string;
  naturalness: 'ok' | string;
  provenance: ProvenanceVerdict;
  /** What the coordinator would have done with it. */
  outcome: 'would_send' | 'naturalness_rejected' | 'invalid_motive_source';
}

export interface ReplayEventOutcome {
  eventId: string;
  timestamp: number;
  type: string;
  summary: string;
  offered: string[];
  observation: ObservationStats;
  reactions: ReplayReactionOutcome[];
}

export interface ReplayResult {
  events: number;
  wouldSend: number;
  naturalnessRejected: number;
  invalidMotiveSource: number;
  observation: { considered: number; observed: number; memoryWrites: number; knowledgeUpdates: number; loopsResolved: number };
  outcomes: ReplayEventOutcome[];
}

export interface ReplayOptions {
  repository: AppRepository;
  brain?: ReplayBrain;
  /** How many of the most recent stored events to replay, oldest first. */
  limit?: number;
  logger?: Logger;
}

export async function runReplay(options: ReplayOptions): Promise<ReplayResult> {
  const repository = readOnlyRepository(options.repository);
  const brain = options.brain ?? mockReplayBrain;
  const limit = options.limit ?? 50;
  const logger = options.logger ?? new Logger('REPLAY', 'warn');

  const [personas, bots, minds, storedEvents] = await Promise.all([
    repository.listPersonas(),
    repository.listBots(),
    repository.listPersonaMinds(),
    repository.listStreamEvents(limit),
  ]);
  const personaById = new Map(personas.map((persona) => [persona.id, persona]));
  const candidates = bots
    .map((bot) => toCandidate(bot, personaById.get(bot.personaId)))
    .filter((candidate): candidate is ReactionBotCandidate => candidate !== undefined);
  const events = [...storedEvents].sort((left, right) => left.timestamp - right.timestamp);

  const mind = new PersonaMindStore(sandboxMindRepository(minds), logger);
  await mind.load();
  await mind.ensureSeeded(candidates.map(({ username, persona }) => ({ username, persona })));
  const guard = new NaturalnessGuard();

  const result: ReplayResult = {
    events: events.length,
    wouldSend: 0,
    naturalnessRejected: 0,
    invalidMotiveSource: 0,
    observation: { considered: 0, observed: 0, memoryWrites: 0, knowledgeUpdates: 0, loopsResolved: 0 },
    outcomes: [],
  };

  for (const event of events) {
    const shortlist = shortlistCandidates(candidates, event);
    const offered = shortlist.shortlisted;
    const offeredUsernames = offered.map((candidate) => candidate.username);
    const mindContext = mind.forEvent(event, offeredUsernames);
    const pools = new Map<string, ProvenancePools>(offered.map((candidate) => [
      candidate.username.toLowerCase(),
      {
        mind: mindContext?.supplied[candidate.username] ?? emptySuppliedSources(),
        memories: [],
        expertise: candidate.persona.knowledge.expertise,
        opinions: candidate.persona.opinions.map((opinion) => `${opinion.topic}: ${opinion.stance}`),
        hadRecentChat: false,
      },
    ]));

    const reactions = await brain({ event, offered, ...(mindContext ? { mindContext } : {}) });
    const reactionOutcomes: ReplayReactionOutcome[] = reactions.map((reaction) => {
      const naturalness = guard.check({ message: reaction.message, event });
      const provenance = validateMotiveProvenance(
        reaction,
        pools.get(reaction.username.toLowerCase()) ?? emptyProvenancePools(),
      );
      const fabricated = !provenance.sourceValidated
        && (provenance.validationReason === 'ref_matches_nothing' || provenance.validationReason === 'no_source_supplied');
      const outcome = !naturalness.ok
        ? 'naturalness_rejected' as const
        : fabricated
          ? 'invalid_motive_source' as const
          : 'would_send' as const;
      if (outcome === 'would_send') result.wouldSend += 1;
      else if (outcome === 'naturalness_rejected') result.naturalnessRejected += 1;
      else result.invalidMotiveSource += 1;
      return {
        username: reaction.username,
        message: reaction.message,
        naturalness: naturalness.ok ? 'ok' : naturalness.reason!,
        provenance,
        outcome,
        ...(reaction.motive ? { motive: reaction.motive } : {}),
        ...(reaction.sourceType ? { sourceType: reaction.sourceType } : {}),
        ...(reaction.sourceRef ? { sourceRef: reaction.sourceRef } : {}),
      };
    });

    // Observation runs after the decision, mirroring the live coordinator's ordering — and against
    // the sandbox minds, so a replayed evening teaches the copies, never production.
    const observation = await mind.observeEvent(event, candidates.map((candidate) => candidate.username));
    result.observation.considered += observation.considered;
    result.observation.observed += observation.observed;
    result.observation.memoryWrites += observation.memoryWrites;
    result.observation.knowledgeUpdates += observation.knowledgeUpdates;
    result.observation.loopsResolved += observation.loopsResolved;

    result.outcomes.push({
      eventId: event.id,
      timestamp: event.timestamp,
      type: event.type,
      summary: event.summary,
      offered: offeredUsernames,
      observation,
      reactions: reactionOutcomes,
    });
  }

  return result;
}

function toCandidate(bot: BotAccountRecord, persona: BotPersona | undefined): ReactionBotCandidate | undefined {
  if (!persona || !bot.enabled) return undefined;
  // Everyone present and connected: a replay asks "what would the room have done", not "who
  // happened to be disconnected that night" — connection state is not recorded per event anyway.
  return {
    username: bot.username,
    persona,
    enabled: true,
    connectionState: 'CONNECTED',
    chatConnected: true,
  };
}
