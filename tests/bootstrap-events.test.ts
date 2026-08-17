import { describe, expect, it } from 'vitest';
import { partitionBootstrapEvents } from '../src/brain/bootstrap-events';
import { StreamEvent } from '../src/stream-brain/types';

const SESSION_STARTED_AT = 1_700_000_000_000;

function event(offsetMs: number, summary: string, importance = 0.7): StreamEvent {
  return {
    id: `event${offsetMs}`,
    timestamp: SESSION_STARTED_AT + offsetMs,
    type: 'conversation',
    summary,
    importance,
    confidence: 0.9,
    source: 'transcription',
    directMentions: [],
  };
}

/**
 * The live failure this exists for: a stream started at 20:35:38, the bootstrap handed the model 25
 * events from a previous evening in a field named recentMeaningfulEvents, the first thing this
 * session observed was a Dota draft screen, and nine seconds later an account announced that they
 * had finally got to the computers. Nobody had driven anywhere on camera.
 */
describe('what the bootstrap says this session has seen', () => {
  // Newest first, exactly as `SELECT ... ORDER BY occurred_at DESC` hands them over.
  const stored = [
    event(60_000, 'S: ну что, первая катка'),
    event(-3_500_000, 'S: пошли отсюда, тут дорого'),
    event(-3_600_000, 'S: заказываем на всех, сашими берём'),
  ];

  it('puts an earlier stream in the background list and tonight in the evidence list', () => {
    const { currentSessionEvents, earlierStreamEvents } = partitionBootstrapEvents(stored, SESSION_STARTED_AT);
    expect(currentSessionEvents.map((item) => item.summary)).toEqual(['S: ну что, первая катка']);
    expect(earlierStreamEvents).toHaveLength(2);
    expect(earlierStreamEvents.every((item) => item.timestamp < SESSION_STARTED_AT)).toBe(true);
  });

  it('leaves the evidence list empty at the start of a stream, when nothing has been seen yet', () => {
    // This is the exact state at 20:35:38, and it is the state in which the model must not be able
    // to read a restaurant as something happening now.
    const { currentSessionEvents, earlierStreamEvents } = partitionBootstrapEvents(
      stored.filter((item) => item.timestamp < SESSION_STARTED_AT),
      SESSION_STARTED_AT,
    );
    expect(currentSessionEvents).toEqual([]);
    expect(earlierStreamEvents).toHaveLength(2);
  });

  it('keeps an event exactly at the session start as part of this session', () => {
    const { currentSessionEvents } = partitionBootstrapEvents([event(0, 'S: погнали')], SESSION_STARTED_AT);
    expect(currentSessionEvents).toHaveLength(1);
  });

  it('drops nothing meaningful and reorders each list oldest-first', () => {
    const { earlierStreamEvents } = partitionBootstrapEvents(stored, SESSION_STARTED_AT);
    expect(earlierStreamEvents[0]?.timestamp).toBeLessThan(earlierStreamEvents[1]!.timestamp);
  });

  it('still filters out the unimportant, and caps each list separately', () => {
    const noisy = [
      ...Array.from({ length: 40 }, (_, index) => event(index * 1_000, `сейчас ${index}`)),
      ...Array.from({ length: 40 }, (_, index) => event(-1_000_000 - index * 1_000, `раньше ${index}`)),
      event(500, 'проходной момент', 0.4),
    ];
    const { currentSessionEvents, earlierStreamEvents } = partitionBootstrapEvents(noisy, SESSION_STARTED_AT);
    expect(currentSessionEvents).toHaveLength(25);
    expect(earlierStreamEvents).toHaveLength(15);
    expect([...currentSessionEvents, ...earlierStreamEvents].map((item) => item.summary))
      .not.toContain('проходной момент');
  });
});
