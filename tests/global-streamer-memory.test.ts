import { describe, expect, it } from 'vitest';
import { GlobalStreamerMemory } from '../src/global-memory/global-streamer-memory';
import { Logger } from '../src/logger';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { StreamerMemoryTransaction } from '../src/persistence/repository';
import { StreamSession } from '../src/global-memory/types';
import { PersonaMemory } from '../src/personas/persona-memory';
import { UsageTracker } from '../src/usage/usage-tracker';

class FailingBatchRepository extends MemoryRepository {
  private failNextBatch = false;

  failOnce(): void { this.failNextBatch = true; }

  override async withStreamerMemoryTransaction<T>(
    channel: string,
    operation: (transaction: StreamerMemoryTransaction) => Promise<T>,
  ): Promise<T> {
    if (!this.failNextBatch) return super.withStreamerMemoryTransaction(channel, operation);
    this.failNextBatch = false;
    return super.withStreamerMemoryTransaction(channel, async (transaction) => {
      await operation(transaction);
      throw new Error('simulated write failure after reference update');
    });
  }
}

class DelayedStartRepository extends MemoryRepository {
  private releaseStart?: () => void;
  private markStartEntered: () => void = () => undefined;
  private readonly startEntered = new Promise<void>((resolve) => { this.markStartEntered = resolve; });

  override async startOrResumeStreamSession(session: StreamSession, staleBefore: number): Promise<StreamSession> {
    this.markStartEntered();
    await new Promise<void>((resolve) => { this.releaseStart = resolve; });
    return super.startOrResumeStreamSession(session, staleBefore);
  }

  async waitForStart(): Promise<void> { await this.startEntered; }
  release(): void { this.releaseStart?.(); }
}

describe('GlobalStreamerMemory', () => {
  it('keeps an important plan across sessions even when no bot reacts', async () => {
    let now = Date.UTC(2026, 7, 14, 18, 0, 0);
    const repository = new MemoryRepository();
    const memory = new GlobalStreamerMemory({
      repository,
      usage: new UsageTracker(),
      logger: new Logger('TEST', 'error'),
      now: () => now,
    });

    const firstSession = await memory.startOrResumeSession({
      channel: 'streamer',
      initialCategory: 'Just Chatting',
      initialStreamContext: 'вечерний IRL',
    });
    const stored = await memory.recordFromBrain({
      memories: [{
        type: 'plan',
        summary: 'Стример завтра летит в Таиланд.',
        entities: ['Таиланд'],
        tags: ['поездка', 'план'],
        importance: 0.82,
        confidence: 0.96,
        expiresInHours: 72,
      }],
    });

    expect(stored.rejected).toEqual([]);
    expect(stored.accepted).toHaveLength(1);
    expect(stored.accepted[0]).toMatchObject({ outcome: 'created', memory: { sourceSessionId: firstSession.id, type: 'plan' } });

    await memory.endCurrentSession('ended');
    now += 24 * 60 * 60_000;
    await memory.startOrResumeSession({ channel: 'streamer', initialCategory: 'Travel & Outdoors' });

    expect(await memory.startupSnapshot('streamer')).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'plan', summary: 'Стример завтра летит в Таиланд.' }),
    ]));
  });
  it('merges reconfirmed facts and rejects sensitive memory proposals', async () => {
    let now = Date.UTC(2026, 7, 14, 18, 0, 0);
    const repository = new MemoryRepository();
    const memory = new GlobalStreamerMemory({ repository, usage: new UsageTracker(), logger: new Logger('TEST', 'error'), now: () => now });
    await memory.startOrResumeSession({ channel: 'streamer' });
    const candidate = {
      type: 'preference' as const,
      summary: 'Streamer likes padel.',
      entities: ['padel'],
      tags: ['sport'],
      importance: 0.8,
      confidence: 0.8,
    };

    expect((await memory.recordFromBrain({ memories: [candidate] })).accepted[0]?.outcome).toBe('created');
    now += 1_000;
    const second = await memory.recordFromBrain({ memories: [candidate, {
      ...candidate,
      summary: 'Contact support@example.com for the password',
    }, {
      ...candidate,
      summary: 'Streamer disclosed a medical diagnosis.',
    }] });

    expect(second.accepted[0]).toMatchObject({ outcome: 'merged', memory: { confirmationCount: 2 } });
    expect(second.rejected).toEqual([
      { index: 1, reason: 'sensitive_data' },
      { index: 2, reason: 'sensitive_data' },
    ]);
    expect(await memory.list({ channel: 'streamer' })).toHaveLength(1);
  });

  it('supersedes conflicting facts and excludes expired plans from retrieval', async () => {
    let now = Date.UTC(2026, 7, 14, 18, 0, 0);
    const repository = new MemoryRepository();
    const memory = new GlobalStreamerMemory({ repository, usage: new UsageTracker(), logger: new Logger('TEST', 'error'), now: () => now });
    await memory.startOrResumeSession({ channel: 'streamer' });
    const old = (await memory.recordFromBrain({ memories: [{
      type: 'place', summary: 'Streamer is currently in Almaty.', entities: ['Almaty'], tags: ['location'], importance: 0.8, confidence: 0.9,
    }] })).accepted[0]?.memory;
    expect(old).toBeDefined();
    await memory.recordFromBrain({ memories: [{
      type: 'place', summary: 'Streamer moved to Astana.', entities: ['Astana'], tags: ['location'], importance: 0.9, confidence: 0.95,
      supersedesMemoryId: old?.id,
    }, {
      type: 'plan', summary: 'Streamer plays a tournament today.', entities: ['tournament'], tags: ['plan'], importance: 0.8, confidence: 0.9,
      expiresInHours: 1,
    }] });

    expect((await memory.list({ channel: 'streamer', status: 'superseded' }))[0]?.supersededBy).toBeTruthy();
    now += 2 * 60 * 60_000;
    expect(await memory.retrieve({ channel: 'streamer', query: 'tournament' })).toEqual([]);
    expect((await memory.stats('streamer')).expired).toBe(1);
  });

  it('rolls back a whole batch when a save after a supersede reference fails', async () => {
    const repository = new FailingBatchRepository();
    const memory = new GlobalStreamerMemory({ repository, usage: new UsageTracker(), logger: new Logger('TEST', 'error') });
    await memory.startOrResumeSession({ channel: 'streamer' });
    const old = (await memory.recordFromBrain({ memories: [{
      type: 'place', summary: 'Streamer is in Almaty.', entities: ['Almaty'], tags: ['location'], importance: 0.8, confidence: 0.9,
    }] })).accepted[0]?.memory;
    expect(old).toBeDefined();

    repository.failOnce();
    const result = await memory.recordFromBrain({ memories: [{
      type: 'place', summary: 'Streamer is in Astana.', entities: ['Astana'], tags: ['location'], importance: 0.9, confidence: 0.9,
      supersedesMemoryId: old?.id,
    }, {
      type: 'plan', summary: 'Streamer will travel tomorrow.', entities: ['travel'], tags: ['plan'], importance: 0.8, confidence: 0.8,
    }] });

    expect(result).toMatchObject({ accepted: [], rejected: [
      { index: 0, reason: 'persistence_failed' },
      { index: 1, reason: 'persistence_failed' },
    ] });
    expect(await memory.list({ channel: 'streamer', status: 'active' })).toEqual([
      expect.objectContaining({ id: old?.id, summary: 'Streamer is in Almaty.' }),
    ]);
    expect(await memory.list({ channel: 'streamer', status: 'superseded' })).toEqual([]);
  });

  it('ends a session when OFFLINE is queued while STREAMING start is still in flight', async () => {
    const repository = new DelayedStartRepository();
    const memory = new GlobalStreamerMemory({ repository, usage: new UsageTracker(), logger: new Logger('TEST', 'error') });
    const starting = memory.startOrResumeSession({ channel: 'streamer' });
    await repository.waitForStart();
    const ending = memory.endCurrentSession('ended');
    repository.release();

    await starting;
    expect(await ending).toMatchObject({ status: 'ended' });
    expect(memory.activeSession).toBeUndefined();
  });

  it('retrieves only a relevant running joke from a 1000-record channel memory and keeps persona conversations separate', async () => {
    let now = Date.UTC(2026, 7, 14, 18, 0, 0);
    const repository = new MemoryRepository();
    const memory = new GlobalStreamerMemory({ repository, usage: new UsageTracker(), logger: new Logger('TEST', 'error'), now: () => now });
    const personaMemory = new PersonaMemory(repository, { now: () => now });
    await memory.startOrResumeSession({ channel: 'streamer' });

    await memory.recordFromBrain({ memories: [{
      type: 'running_joke', summary: 'Artem still owes the streamer dinner after losing the bet.',
      entities: ['Artem'], tags: ['friend', 'irl', 'running-joke'], importance: 0.84, confidence: 0.93,
    }, {
      type: 'preference', summary: 'Streamer likes padel.',
      entities: ['padel'], tags: ['sport'], importance: 0.72, confidence: 0.9,
    }] });
    await personaMemory.addConversation({
      personaId: 'bot-a', viewerUsername: 'viewer', role: 'viewer', message: 'Private conversation for bot A only.',
    });

    now += 1_000;
    for (let index = 0; index < 998; index += 1) {
      await repository.saveStreamerMemory({
        id: `archive-${index}`, channel: 'streamer', type: 'fact', summary: `Unrelated archive note ${index}`,
        entities: [`archive-${index}`], tags: ['archive'], importance: 0.5, confidence: 0.7,
        createdAt: now, updatedAt: now, lastSeenAt: now, confirmationCount: 1, status: 'active',
        dedupeKey: `archive|${index}`,
      });
    }

    const retrieved = await memory.retrieve({
      channel: 'streamer', query: 'Artem appears on IRL', entities: ['Artem'], tags: ['irl'], limit: 2,
    });

    expect(await repository.listStreamerMemories('streamer', 1_000)).toHaveLength(1_000);
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]).toMatchObject({ type: 'running_joke', entities: ['Artem'] });
    expect(retrieved.some((item) => item.summary.includes('padel'))).toBe(false);
    expect(await personaMemory.conversation('bot-a', 'viewer')).toHaveLength(1);
    expect((await memory.list({ channel: 'streamer', search: 'Private conversation' }))).toEqual([]);
  });
});
