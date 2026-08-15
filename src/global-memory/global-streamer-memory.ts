import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Logger } from '../logger';
import { AppRepository, StreamerMemoryTransaction } from '../persistence/repository';
import { UsageTracker } from '../usage/usage-tracker';
import {
  GlobalMemoryRetrievalInput,
  GlobalStreamerMemoryStats,
  RecordStreamerMemoriesInput,
  StartStreamSessionInput,
  STREAMER_MEMORY_TYPES,
  StreamerMemory,
  StreamerMemoryCandidate,
  StreamerMemoryListInput,
  StreamerMemoryRecordAccepted,
  StreamerMemoryRecordRejected,
  StreamerMemoryRecordResult,
  StreamSession,
  UpdateStreamerMemoryInput,
} from './types';

const MIN_IMPORTANCE = 0.5;
const MIN_CONFIDENCE = 0.6;
const MAX_SUMMARY_LENGTH = 800;
const MAX_DETAILS_LENGTH = 4_000;
const MAX_LIST_LIMIT = 200;
const MAX_RETRIEVAL_CANDIDATES = 1_000;
const MAX_RETRIEVAL_LIMIT = 12;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export interface GlobalStreamerMemoryOptions {
  repository: AppRepository;
  usage: UsageTracker;
  logger?: Logger;
  now?: () => number;
  startupLimit?: number;
  retrievalLimit?: number;
  /** A live session without any heartbeat is considered stale after this interval. */
  staleSessionMs?: number;
  minImportance?: number;
  minConfidence?: number;
}

interface ValidatedCandidate {
  type: StreamerMemory['type'];
  summary: string;
  details?: Record<string, unknown>;
  entities: string[];
  tags: string[];
  importance: number;
  confidence: number;
  occurredAt?: number;
  expiresAt?: number;
  sourceEventId?: string;
  resolvesMemoryId?: string;
  supersedesMemoryId?: string;
  dedupeKey: string;
}

interface StagedStreamerMemoryRecord {
  accepted: StreamerMemoryRecordAccepted;
  /** Existing records reconciled by this accepted candidate. */
  referenceUpdates: StreamerMemory[];
}

/**
 * Channel-wide, durable memory. It deliberately has no model client: the
 * already connected Gemini Live session decides what to submit and this layer
 * only validates, persists, retrieves and reconciles it deterministically.
 */
export class GlobalStreamerMemory extends EventEmitter {
  private readonly now: () => number;
  private readonly logger?: Logger;
  private readonly startupLimit: number;
  private readonly retrievalLimit: number;
  private readonly minImportance: number;
  private readonly minConfidence: number;
  private readonly staleSessionMs: number;
  private currentSession?: StreamSession;
  private sessionMutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: GlobalStreamerMemoryOptions) {
    super();
    this.now = options.now ?? Date.now;
    this.logger = options.logger?.child('MEMORY');
    this.startupLimit = bounded(options.startupLimit ?? 12, 1, 15);
    this.retrievalLimit = bounded(options.retrievalLimit ?? 8, 1, MAX_RETRIEVAL_LIMIT);
    this.minImportance = clamp(options.minImportance ?? MIN_IMPORTANCE);
    this.minConfidence = clamp(options.minConfidence ?? MIN_CONFIDENCE);
    this.staleSessionMs = bounded(options.staleSessionMs ?? 20 * 60_000, 60_000, 6 * HOUR_MS);
  }

  get activeSession(): StreamSession | undefined {
    return this.currentSession ? structuredClone(this.currentSession) : undefined;
  }

  async startOrResumeSession(input: StartStreamSessionInput): Promise<StreamSession> {
    return this.serializeSessionMutation(() => this.startOrResumeSessionInternal(input));
  }

  private async startOrResumeSessionInternal(input: StartStreamSessionInput): Promise<StreamSession> {
    const channel = normalizeChannel(input.channel);
    if (!channel) throw new Error('A Twitch channel is required for a stream session');

    if (this.currentSession?.status === 'live' && this.currentSession.channel === channel) {
      return structuredClone(this.currentSession);
    }
    if (this.currentSession?.status === 'live') await this.endCurrentSessionInternal('interrupted');

    const now = this.now();
    const requested: StreamSession = {
      id: randomUUID(),
      channel,
      startedAt: now,
      lastSeenAt: now,
      ...(cleanOptionalText(input.initialCategory, 160) ? { initialCategory: cleanOptionalText(input.initialCategory, 160) } : {}),
      ...(cleanOptionalText(input.initialStreamContext, 1_000) ? { initialStreamContext: cleanOptionalText(input.initialStreamContext, 1_000) } : {}),
      status: 'live',
    };
    const session = await this.options.repository.startOrResumeStreamSession(requested, now - this.staleSessionMs);
    const active = { ...session, lastSeenAt: now };
    await this.options.repository.saveStreamSession(active);
    this.currentSession = structuredClone(active);
    this.logger?.info(active.id === requested.id ? 'Stream session started' : 'Stream session resumed', {
      sessionId: active.id,
      channel: active.channel,
    });
    this.emitSafely('session', { action: active.id === requested.id ? 'started' : 'resumed', session: clone(active) });
    return structuredClone(active);
  }

  async endCurrentSession(status: 'ended' | 'interrupted' = 'ended'): Promise<StreamSession | undefined> {
    return this.serializeSessionMutation(() => this.endCurrentSessionInternal(status));
  }

  private async endCurrentSessionInternal(status: 'ended' | 'interrupted' = 'ended'): Promise<StreamSession | undefined> {
    if (!this.currentSession || this.currentSession.status !== 'live') return undefined;
    const now = this.now();
    const sessionMemories = (await this.options.repository.listStreamerMemories(this.currentSession.channel, MAX_LIST_LIMIT))
      .filter((memory) => memory.sourceSessionId === this.currentSession?.id);
    const summary = deterministicSessionSummary(this.currentSession, sessionMemories);
    const ended: StreamSession = {
      ...this.currentSession,
      status,
      endedAt: now,
      lastSeenAt: now,
      ...(summary ? { summary } : {}),
    };
    await this.options.repository.saveStreamSession(ended);
    this.currentSession = undefined;
    this.logger?.info('Stream session ended', { sessionId: ended.id, channel: ended.channel, status });
    this.emitSafely('session', { action: status, session: clone(ended) });
    return structuredClone(ended);
  }

  /** Call from ordinary stream activity to keep restart recovery accurate. */
  async touchCurrentSession(): Promise<StreamSession | undefined> {
    return this.serializeSessionMutation(() => this.touchCurrentSessionInternal());
  }

  private async touchCurrentSessionInternal(): Promise<StreamSession | undefined> {
    if (!this.currentSession || this.currentSession.status !== 'live') return undefined;
    const touched = { ...this.currentSession, lastSeenAt: this.now() };
    await this.options.repository.saveStreamSession(touched);
    this.currentSession = touched;
    return clone(touched);
  }

  /** Validates and persists durable memory proposed by the stateful Brain. */
  async recordFromBrain(input: RecordStreamerMemoriesInput): Promise<StreamerMemoryRecordResult> {
    return this.serializeSessionMutation(() => this.recordFromBrainInternal(input));
  }

  private async recordFromBrainInternal(input: RecordStreamerMemoriesInput): Promise<StreamerMemoryRecordResult> {
    this.options.usage.recordMemoryToolCall();
    const candidates = Array.isArray(input?.memories) ? input.memories : [];
    const rejected: StreamerMemoryRecordRejected[] = [];
    if (!this.currentSession || this.currentSession.status !== 'live') {
      return {
        accepted: [],
        rejected: candidates.map((_, index) => ({ index, reason: 'no_active_stream_session' })),
      };
    }
    await this.touchCurrentSessionInternal();
    const session = this.currentSession;
    if (!session || session.status !== 'live') {
      return {
        accepted: [],
        rejected: candidates.map((_, index) => ({ index, reason: 'no_active_stream_session' })),
      };
    }

    // Syntax and policy validation stays item-scoped. The remaining valid
    // entries are committed as one transaction so a later reference failure
    // cannot leave earlier memory writes visible on their own.
    const validated: Array<{ index: number; value: ValidatedCandidate }> = [];
    for (const [index, candidate] of candidates.entries()) {
      const result = this.validateCandidate(candidate);
      if ('reason' in result) rejected.push({ index, reason: result.reason });
      else validated.push({ index, value: result });
    }

    if (!validated.length) return { accepted: [], rejected: rejected.sort((left, right) => left.index - right.index) };

    try {
      const committed = await this.options.repository.withStreamerMemoryTransaction(session.channel, async (transaction) => {
        const accepted: Array<{ index: number; result: StreamerMemoryRecordAccepted; referenceUpdates: StreamerMemory[] }> = [];
        const referenceRejected: StreamerMemoryRecordRejected[] = [];
        for (const { index, value } of validated) {
          const stored = await this.saveOrMergeInTransaction(transaction, session, value);
          if ('reason' in stored) {
            referenceRejected.push({ index, reason: stored.reason });
            continue;
          }
          accepted.push({ index, result: stored.accepted, referenceUpdates: stored.referenceUpdates });
        }
        return { accepted, rejected: referenceRejected };
      });

      for (const entry of committed.accepted) {
        if (entry.result.outcome === 'created') {
          this.options.usage.recordMemoryCreated();
          this.logger?.info('Streamer memory created', {
            id: entry.result.memory.id, type: entry.result.memory.type, importance: entry.result.memory.importance,
          });
          this.emitSafely('memory', { action: 'created', memory: clone(entry.result.memory) });
        } else {
          this.options.usage.recordMemoryMerged();
          this.logger?.info('Streamer memory merged', {
            id: entry.result.memory.id, type: entry.result.memory.type, confidence: entry.result.memory.confidence,
          });
          this.emitSafely('memory', { action: 'merged', memory: clone(entry.result.memory) });
        }
        for (const updated of entry.referenceUpdates) {
          if (updated.status === 'superseded') {
            this.options.usage.recordMemorySuperseded();
            this.logger?.info('Streamer memory superseded', { oldMemoryId: updated.id, newMemoryId: updated.supersededBy });
            this.emitSafely('memory', { action: 'superseded', memory: clone(updated) });
          } else {
            this.emitSafely('memory', { action: 'updated', memory: clone(updated) });
          }
        }
      }
      return {
        accepted: committed.accepted.map((entry) => entry.result),
        rejected: [...rejected, ...committed.rejected].sort((left, right) => left.index - right.index),
      };
    } catch (cause) {
      // The repository transaction guarantees none of the accepted candidates
      // nor their resolve/supersede links survive this failure.
      this.logger?.warn('Streamer memory batch persistence failed', { count: validated.length, cause });
      return {
        accepted: [],
        rejected: [...rejected, ...validated.map(({ index }) => ({ index, reason: 'persistence_failed' as const }))]
          .sort((left, right) => left.index - right.index),
      };
    }
  }

  async startupSnapshot(channel: string, limit = this.startupLimit): Promise<StreamerMemory[]> {
    const normalizedChannel = normalizeChannel(channel);
    if (!normalizedChannel) return [];
    await this.refreshExpiry(normalizedChannel);
    const memories = await this.options.repository.listStreamerMemories(normalizedChannel, MAX_RETRIEVAL_CANDIDATES);
    return memories
      .filter((memory) => memory.status === 'active')
      .sort((left, right) => startupScore(right) - startupScore(left)
        || right.lastSeenAt - left.lastSeenAt || left.id.localeCompare(right.id))
      .slice(0, bounded(limit, 1, 15))
      .map(clone);
  }

  async retrieve(input: GlobalMemoryRetrievalInput): Promise<StreamerMemory[]> {
    const channel = normalizeChannel(input.channel);
    if (!channel) return [];
    await this.refreshExpiry(channel);
    const safeLimit = bounded(input.limit ?? this.retrievalLimit, 1, MAX_RETRIEVAL_LIMIT);
    const queryTokens = memoryTokens(input.query ?? '');
    const entities = normalizeValues(input.entities ?? []);
    const tags = normalizeTags(input.tags ?? []);
    const hasSignal = queryTokens.size > 0 || entities.length > 0 || tags.length > 0;
    const now = this.now();
    const memories = await this.options.repository.listStreamerMemories(channel, MAX_RETRIEVAL_CANDIDATES);
    const matches = memories
      .filter((memory) => memory.status === 'active' || (input.includeResolved && memory.status === 'resolved'))
      .map((memory) => ({ memory, score: retrievalScore(memory, queryTokens, entities, tags, now) }))
      .filter(({ score }) => !hasSignal || score.relevance > 0)
      .sort((left, right) => right.score.total - left.score.total
        || right.memory.lastSeenAt - left.memory.lastSeenAt || left.memory.id.localeCompare(right.memory.id))
      .slice(0, safeLimit)
      .map(({ memory }) => clone(memory));
    this.options.usage.recordMemoryRetrieval();
    this.logger?.debug('Streamer memory retrieved', { channel, returned: matches.length });
    return matches;
  }

  async list(input: StreamerMemoryListInput): Promise<StreamerMemory[]> {
    const channel = normalizeChannel(input.channel);
    if (!channel) return [];
    await this.refreshExpiry(channel);
    const searchTokens = memoryTokens(input.search ?? '');
    const memories = await this.options.repository.listStreamerMemories(channel, MAX_LIST_LIMIT);
    return memories
      .filter((memory) => !input.type || memory.type === input.type)
      .filter((memory) => !input.status || memory.status === input.status)
      .filter((memory) => searchTokens.size === 0 || tokenOverlap(searchTokens, memoryTokens(memoryText(memory))) > 0)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .slice(0, bounded(input.limit ?? 50, 1, MAX_LIST_LIMIT))
      .map(clone);
  }

  async updateMemory(input: UpdateStreamerMemoryInput): Promise<StreamerMemory | undefined> {
    const existing = await this.options.repository.getStreamerMemory(input.id);
    if (!existing || (input.channel && existing.channel !== normalizeChannel(input.channel))) return undefined;
    const nextEntities = input.entities === undefined ? existing.entities : normalizeValues(input.entities);
    const nextTags = input.tags === undefined ? existing.tags : normalizeTags(input.tags);
    const candidateText = [
      input.summary,
      input.details ? stableJson(input.details) : '',
      ...(input.entities ?? []),
      ...(input.tags ?? []),
    ].filter(Boolean).join('\n');
    if (candidateText && containsSensitiveData(candidateText)) return undefined;
    const summary = input.summary === undefined ? existing.summary : cleanText(input.summary, MAX_SUMMARY_LENGTH);
    if (!summary) return undefined;
    const details = input.details === undefined ? existing.details : cleanDetails(input.details);
    if (input.details !== undefined && !details) return undefined;
    const importance = input.importance === undefined ? existing.importance : input.importance;
    const confidence = input.confidence === undefined ? existing.confidence : input.confidence;
    if (!isUnitInterval(importance) || !isUnitInterval(confidence)) return undefined;
    const now = this.now();
    const nextStatus = input.status ?? existing.status;
    // A confirmed replacement is historical evidence. It must not become
    // active again through the general dashboard edit/restore path.
    if (existing.status === 'superseded' && nextStatus === 'active') return undefined;
    const updated: StreamerMemory = {
      ...existing,
      summary,
      ...(details ? { details } : {}),
      ...(details ? {} : { details: undefined }),
      entities: nextEntities,
      tags: nextTags,
      importance,
      confidence,
      ...(input.occurredAt === null ? { occurredAt: undefined } : input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      ...(input.expiresAt === null ? { expiresAt: undefined } : input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      status: nextStatus,
      ...(nextStatus === 'resolved' ? { resolvedAt: now } : {}),
      ...(nextStatus === 'active' ? { resolvedAt: undefined, supersededBy: undefined } : {}),
      updatedAt: now,
      dedupeKey: memoryDedupeKey({
        type: existing.type,
        summary,
        entities: nextEntities,
        tags: nextTags,
      }),
    };
    if (updated.status === 'active') {
      const duplicate = await this.options.repository.findActiveStreamerMemoryByDedupeKey(updated.channel, updated.dedupeKey);
      if (duplicate && duplicate.id !== updated.id) return undefined;
    }
    try {
      await this.options.repository.saveStreamerMemory(removeUndefined(updated));
    } catch (cause) {
      // A concurrent manual edit can race the unique active-dedupe index.
      // This is a controlled rejection, not an API-visible generic failure.
      this.logger?.warn('Streamer memory update rejected', { id: existing.id, cause });
      return undefined;
    }
    this.emitSafely('memory', { action: 'updated', memory: clone(removeUndefined(updated)) });
    return clone(removeUndefined(updated));
  }

  async deleteMemory(id: string, channel?: string): Promise<boolean> {
    return this.options.repository.deleteStreamerMemory(id, channel ? normalizeChannel(channel) : undefined);
  }

  async resolveMemory(id: string, channel?: string): Promise<StreamerMemory | undefined> {
    return this.updateMemory({ id, ...(channel ? { channel } : {}), status: 'resolved' });
  }

  async supersedeMemory(oldMemoryId: string, newMemoryId: string, channel?: string): Promise<StreamerMemory | undefined> {
    if (oldMemoryId === newMemoryId) return undefined;
    const [oldMemory, replacement] = await Promise.all([
      this.options.repository.getStreamerMemory(oldMemoryId),
      this.options.repository.getStreamerMemory(newMemoryId),
    ]);
    const normalizedChannel = channel ? normalizeChannel(channel) : undefined;
    if (!oldMemory || !replacement || !isActiveSameChannel(oldMemory, replacement.channel)
      || replacement.status !== 'active' || !areCompatibleSupersession(oldMemory, replacement)
      || (normalizedChannel && oldMemory.channel !== normalizedChannel)) return undefined;
    const superseded: StreamerMemory = {
      ...oldMemory,
      status: 'superseded',
      supersededBy: replacement.id,
      updatedAt: this.now(),
    };
    await this.options.repository.saveStreamerMemory(superseded);
    this.options.usage.recordMemorySuperseded();
    this.logger?.info('Streamer memory superseded', { oldMemoryId, newMemoryId });
    this.emitSafely('memory', { action: 'superseded', memory: clone(superseded) });
    return clone(superseded);
  }

  async stats(channel: string): Promise<GlobalStreamerMemoryStats> {
    const normalizedChannel = normalizeChannel(channel);
    if (!normalizedChannel) return emptyStats(channel);
    await this.refreshExpiry(normalizedChannel);
    const memories = await this.options.repository.listStreamerMemories(normalizedChannel, MAX_RETRIEVAL_CANDIDATES);
    const totals = memories.reduce((result, memory) => {
      result.total += 1;
      result[memory.status] += 1;
      result.importance += memory.importance;
      result.confidence += memory.confidence;
      result.duplicateMerges += Math.max(0, memory.confirmationCount - 1);
      return result;
    }, { total: 0, active: 0, resolved: 0, superseded: 0, expired: 0, importance: 0, confidence: 0, duplicateMerges: 0 });
    return {
      channel: normalizedChannel,
      total: totals.total,
      active: totals.active,
      resolved: totals.resolved,
      superseded: totals.superseded,
      expired: totals.expired,
      duplicateMerges: totals.duplicateMerges,
      averageImportance: totals.total ? totals.importance / totals.total : 0,
      averageConfidence: totals.total ? totals.confidence / totals.total : 0,
    };
  }

  private async saveOrMergeInTransaction(
    transaction: StreamerMemoryTransaction,
    session: StreamSession,
    value: ValidatedCandidate,
  ): Promise<StagedStreamerMemoryRecord | { reason: 'invalid_reference' }> {
    const now = this.now();
    const existing = await transaction.findActiveStreamerMemoryByDedupeKey(session.channel, value.dedupeKey);
    let memory: StreamerMemory;
    let outcome: StreamerMemoryRecordAccepted['outcome'];
    if (existing) {
      memory = {
        ...existing,
        importance: Math.max(existing.importance, value.importance),
        confidence: mergedConfidence(existing.confidence, value.confidence),
        lastSeenAt: now,
        updatedAt: now,
        confirmationCount: existing.confirmationCount + 1,
        ...(value.expiresAt && (!existing.expiresAt || value.expiresAt > existing.expiresAt) ? { expiresAt: value.expiresAt } : {}),
      };
      outcome = 'merged';
    } else {
      memory = {
        id: randomUUID(),
        channel: session.channel,
        type: value.type,
        summary: value.summary,
        ...(value.details ? { details: value.details } : {}),
        entities: value.entities,
        tags: value.tags,
        importance: value.importance,
        confidence: value.confidence,
        ...(value.occurredAt ? { occurredAt: value.occurredAt } : {}),
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        confirmationCount: 1,
        sourceSessionId: session.id,
        ...(value.sourceEventId ? { sourceEventId: value.sourceEventId } : {}),
        status: 'active',
        ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
        dedupeKey: value.dedupeKey,
      };
      outcome = 'created';
    }

    const references = await this.validateReferencesInTransaction(transaction, memory, value, now);
    if ('reason' in references) return references;
    await transaction.saveStreamerMemory(memory);
    for (const update of references.updates) await transaction.saveStreamerMemory(update);
    return {
      accepted: { outcome, memory: clone(memory) },
      referenceUpdates: references.updates.map(clone),
    };
  }

  private async validateReferencesInTransaction(
    transaction: StreamerMemoryTransaction,
    memory: StreamerMemory,
    candidate: ValidatedCandidate,
    now: number,
  ): Promise<{ updates: StreamerMemory[] } | { reason: 'invalid_reference' }> {
    if (candidate.resolvesMemoryId && candidate.supersedesMemoryId
      && candidate.resolvesMemoryId === candidate.supersedesMemoryId
      && candidate.resolvesMemoryId !== memory.id) return { reason: 'invalid_reference' };

    const updates: StreamerMemory[] = [];
    if (candidate.resolvesMemoryId && candidate.resolvesMemoryId !== memory.id) {
      const target = await transaction.getStreamerMemory(candidate.resolvesMemoryId);
      if (!isActiveSameChannel(target, memory.channel)) return { reason: 'invalid_reference' };
      updates.push({ ...target, status: 'resolved', resolvedAt: now, updatedAt: now });
    }
    if (candidate.supersedesMemoryId && candidate.supersedesMemoryId !== memory.id) {
      const target = await transaction.getStreamerMemory(candidate.supersedesMemoryId);
      if (!isActiveSameChannel(target, memory.channel) || !areCompatibleSupersession(target, memory)) {
        return { reason: 'invalid_reference' };
      }
      updates.push({ ...target, status: 'superseded', supersededBy: memory.id, updatedAt: now });
    }
    return { updates };
  }

  private validateCandidate(candidate: StreamerMemoryCandidate): ValidatedCandidate | { reason: string } {
    if (!candidate || typeof candidate !== 'object') return { reason: 'invalid_memory' };
    if (!STREAMER_MEMORY_TYPES.includes(candidate.type)) return { reason: 'invalid_type' };
    const summary = cleanText(candidate.summary, MAX_SUMMARY_LENGTH);
    if (!summary) return { reason: 'invalid_summary' };
    const details = candidate.details === undefined ? undefined : cleanDetails(candidate.details);
    if (candidate.details !== undefined && !details) return { reason: 'invalid_details' };
    const sensitiveValue = [summary, details ? stableJson(details) : '', ...(candidate.entities ?? []), ...(candidate.tags ?? [])].join('\n');
    if (containsSensitiveData(sensitiveValue)) return { reason: 'sensitive_data' };
    if (!isUnitInterval(candidate.importance) || candidate.importance < this.minImportance) return { reason: 'low_importance' };
    if (!isUnitInterval(candidate.confidence) || candidate.confidence < this.minConfidence) return { reason: 'low_confidence' };
    const occurredAt = candidate.occurredAt === undefined ? undefined : parseTimestamp(candidate.occurredAt);
    if (candidate.occurredAt !== undefined && (!occurredAt || occurredAt > this.now() + 5 * 60_000)) return { reason: 'invalid_occurred_at' };
    const expiresAt = parseExpiry(candidate, this.now());
    if ('reason' in expiresAt) return expiresAt;
    const entities = normalizeValues(candidate.entities ?? []);
    const tags = normalizeTags(candidate.tags ?? []);
    return {
      type: candidate.type,
      summary,
      ...(details ? { details } : {}),
      entities,
      tags,
      importance: candidate.importance,
      confidence: candidate.confidence,
      ...(occurredAt ? { occurredAt } : {}),
      ...(expiresAt.value ? { expiresAt: expiresAt.value } : {}),
      ...(cleanOptionalText(candidate.sourceEventId, 200) ? { sourceEventId: cleanOptionalText(candidate.sourceEventId, 200) } : {}),
      ...(cleanOptionalText(candidate.resolvesMemoryId, 100) ? { resolvesMemoryId: cleanOptionalText(candidate.resolvesMemoryId, 100) } : {}),
      ...(cleanOptionalText(candidate.supersedesMemoryId, 100) ? { supersedesMemoryId: cleanOptionalText(candidate.supersedesMemoryId, 100) } : {}),
      dedupeKey: memoryDedupeKey({ type: candidate.type, summary, entities, tags }),
    };
  }

  private async serializeSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionMutationTail;
    let release: (() => void) | undefined;
    this.sessionMutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async refreshExpiry(channel: string): Promise<void> {
    const expired = await this.options.repository.expireStreamerMemories(channel, this.now());
    if (expired) this.logger?.info('Streamer memories expired', { channel, expired });
  }

  private emitSafely(event: string, payload: unknown): void {
    try {
      this.emit(event, payload);
    } catch (cause) {
      this.logger?.warn('Global memory listener failed', { event, cause });
    }
  }
}

function parseExpiry(candidate: StreamerMemoryCandidate, now: number): { value?: number } | { reason: string } {
  if (candidate.expiresAt !== undefined && candidate.expiresInHours !== undefined && candidate.expiresInHours !== null) {
    return { reason: 'ambiguous_expiry' };
  }
  if (candidate.expiresAt !== undefined && candidate.expiresAt !== null) {
    const value = parseTimestamp(candidate.expiresAt);
    if (!value || value <= now) return { reason: 'invalid_expiry' };
    return { value };
  }
  if (candidate.expiresInHours !== undefined && candidate.expiresInHours !== null) {
    if (!Number.isFinite(candidate.expiresInHours) || candidate.expiresInHours <= 0 || candidate.expiresInHours > 24 * 366) {
      return { reason: 'invalid_expiry' };
    }
    return { value: now + candidate.expiresInHours * HOUR_MS };
  }
  return {};
}

function retrievalScore(
  memory: StreamerMemory,
  queryTokens: Set<string>,
  entities: string[],
  tags: string[],
  now: number,
): { relevance: number; total: number } {
  const memoryTokenSet = memoryTokens(memoryText(memory));
  const textRelevance = tokenOverlap(queryTokens, memoryTokenSet);
  const entityMatches = entities.filter((entity) => memory.entities.some((candidate) => normalizeValue(candidate) === normalizeValue(entity))).length;
  const tagMatches = tags.filter((tag) => memory.tags.includes(tag)).length;
  const relevance = textRelevance + entityMatches * 0.8 + tagMatches * 0.45;
  const ageDays = Math.max(0, now - memory.lastSeenAt) / DAY_MS;
  const recency = 1 / (1 + ageDays / 30);
  return { relevance, total: relevance * 4 + memory.importance * 0.6 + memory.confidence * 0.45 + recency * 0.25 };
}

function startupScore(memory: StreamerMemory): number {
  const continuityBonus = ['plan', 'promise', 'person', 'relationship', 'running_joke', 'trip'].includes(memory.type) ? 0.25 : 0;
  return memory.importance * 0.75 + memory.confidence * 0.25 + continuityBonus;
}

function deterministicSessionSummary(session: StreamSession, memories: StreamerMemory[]): string | undefined {
  const highlights = memories
    .sort((left, right) => right.importance - left.importance || right.confidence - left.confidence
      || left.id.localeCompare(right.id))
    .slice(0, 5)
    .map((memory) => `- ${memory.summary}`);
  if (!highlights.length) return undefined;
  const date = new Date(session.startedAt).toISOString().slice(0, 10);
  const heading = `${session.initialCategory ?? 'Stream'} — ${date}`;
  return cleanText([heading, ...highlights].join('\n'), 2_000);
}

function mergedConfidence(current: number, confirmation: number): number {
  const strongest = Math.max(current, confirmation);
  return Math.min(1, strongest + (1 - strongest) * 0.12);
}

function memoryDedupeKey(input: Pick<StreamerMemory, 'type' | 'summary' | 'entities' | 'tags'>): string {
  return [
    input.type,
    normalizeDedupeText(input.summary),
    [...new Set(input.entities.map(normalizeValue).filter(Boolean))].sort().join(','),
    [...new Set(input.tags.map(normalizeValue).filter(Boolean))].sort().join(','),
  ].join('|');
}

function memoryText(memory: StreamerMemory): string {
  return [memory.type, memory.summary, memory.entities.join(' '), memory.tags.join(' ')].join(' ');
}

function isActiveSameChannel(memory: StreamerMemory | undefined, channel: string): memory is StreamerMemory {
  return Boolean(memory && memory.status === 'active' && memory.channel === channel);
}

function areCompatibleSupersession(previous: StreamerMemory, replacement: StreamerMemory): boolean {
  if (previous.type === replacement.type) return true;
  const previousTerms = new Set([...previous.entities, ...previous.tags].map(normalizeValue).filter(Boolean));
  const replacementTerms = [...replacement.entities, ...replacement.tags].map(normalizeValue).filter(Boolean);
  return replacementTerms.some((term) => previousTerms.has(term));
}

function memoryTokens(value: string): Set<string> {
  const words = value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((word) => word.length >= 3 && !MEMORY_STOP_WORDS.has(word)).flatMap((word) => [word, stem(word)]));
}

function tokenOverlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let matched = 0;
  for (const token of left) if (right.has(token)) matched += token.length >= 5 ? 1.2 : 1;
  return matched / Math.max(2, Math.sqrt(left.size * right.size));
}

function normalizeChannel(value: string | undefined): string {
  return cleanText(value, 100).toLowerCase().replace(/^#/, '');
}

function normalizeDedupeText(value: string): string {
  return normalizeValue(value).replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

function normalizeValue(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeValues(values: string[]): string[] {
  return [...new Set(values.map((value) => cleanText(value, 160)).filter(Boolean))].slice(0, 20);
}

function normalizeTags(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizeValue(value)).filter(Boolean))].slice(0, 30);
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanOptionalText(value: unknown, maxLength: number): string | undefined {
  const text = cleanText(value, maxLength);
  return text || undefined;
}

function cleanDetails(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const text = stableJson(value);
  if (text.length > MAX_DETAILS_LENGTH || containsSensitiveData(text)) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === 'string') return cleanText(nested, 1_000);
    if (typeof nested === 'number' || typeof nested === 'boolean' || nested === null) return nested;
    if (Array.isArray(nested)) return nested.slice(0, 50);
    return nested;
  }) ?? '';
}

function parseTimestamp(value: number | string): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
function bounded(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Math.floor(value))); }
function stem(word: string): string { return word.length > 5 ? word.slice(0, Math.max(4, word.length - 2)) : word; }
function clone<T>(value: T): T { return structuredClone(value); }

function removeUndefined(memory: StreamerMemory): StreamerMemory {
  return Object.fromEntries(Object.entries(memory).filter(([, value]) => value !== undefined)) as StreamerMemory;
}

function emptyStats(channel: string): GlobalStreamerMemoryStats {
  return {
    channel: normalizeChannel(channel), total: 0, active: 0, resolved: 0, superseded: 0,
    expired: 0, duplicateMerges: 0, averageImportance: 0, averageConfidence: 0,
  };
}

function containsSensitiveData(value: string): boolean {
  return SENSITIVE_MEMORY_PATTERNS.some((pattern) => pattern.test(value));
}

const SENSITIVE_MEMORY_PATTERNS = [
  /(?:password|passcode|парол[ья]|api[\s_-]*key|ключ[а-я\s_-]*api|secret|секрет|private[\s_-]*key|oauth|access[\s_-]*token|refresh[\s_-]*token|bearer\s+[a-z0-9._-]+)/iu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?:\+?\d[\s().-]?){10,}/u,
  /\b(?:\d[ -]?){13,19}\b/u,
  /(?:passport|паспорт(?:ные)?\s+(?:данные|номер)?|ssn|инн)\b/iu,
  /(?:улица|ул\.?|проспект|пр-т|переулок|дом|квартира|подъезд|street|st\.?|avenue|ave\.?|road|rd\.?|apartment|apt\.?)\s*\d/iu,
  // Durable memory must not profile sensitive personal traits from a stream.
  /(?:medical|health|diagnos(?:is|ed)|disease|illness|disability|pregnan(?:t|cy)|medication|mental[\s-]*health|\u0437\u0434\u043e\u0440\u043e\u0432\u044c\u0435|\u0434\u0438\u0430\u0433\u043d\u043e\u0437|\u0431\u043e\u043b\u0435\u0437\u043d|\u0438\u043d\u0432\u0430\u043b\u0438\u0434\u043d|\u0431\u0435\u0440\u0435\u043c\u0435\u043d\u043d)/iu,
  /(?:race|ethnic(?:ity)?|nationality|citizenship|\u0440\u0430\u0441\u0430|\u044d\u0442\u043d\u0438\u0447|\u043d\u0430\u0446\u0438\u043e\u043d\u0430\u043b\u044c\u043d\u043e\u0441\u0442|\u0433\u0440\u0430\u0436\u0434\u0430\u043d\u0441\u0442\u0432)/iu,
  /(?:religion|religious|muslim|christian|jewish|hindu|buddhist|atheist|\u0440\u0435\u043b\u0438\u0433\u0438|\u043c\u0443\u0441\u0443\u043b\u044c\u043c\u0430\u043d|\u0445\u0440\u0438\u0441\u0442\u0438\u0430\u043d|\u0438\u0443\u0434\u0435\u0439|\u0430\u0442\u0435\u0438\u0441\u0442)/iu,
  /(?:sexual[\s-]*orientation|\blgbt\b|\bgay\b|lesbian|bisexual|queer|\u0441\u0435\u043a\u0441\u0443\u0430\u043b\u044c\u043d\u0430\u044f\s+\u043e\u0440\u0438\u0435\u043d\u0442\u0430\u0446|\u0433\u0435\u0439|\u043b\u0435\u0441\u0431\u0438)/iu,
  /(?:political[\s-]*(?:affiliation|party)|\b(?:democrat|republican|communist)\b|\u043f\u043e\u043b\u0438\u0442\u0438\u0447\u0435\u0441\u043a\u0430\u044f\s+(?:\u043f\u0430\u0440\u0442\u0438\u044f|\u043f\u043e\u0437\u0438\u0446\u0438\u044f|\u043f\u0440\u0438\u043d\u0430\u0434\u043b\u0435\u0436\u043d\u043e\u0441\u0442\u044c))/iu,
];

const MEMORY_STOP_WORDS = new Set([
  'это', 'как', 'что', 'его', 'её', 'она', 'они', 'для', 'или', 'уже', 'ещё', 'был', 'была', 'были',
  'про', 'при', 'где', 'когда', 'так', 'там', 'тут', 'the', 'and', 'with', 'from', 'that', 'this', 'streamer',
]);
