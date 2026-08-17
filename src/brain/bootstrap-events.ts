import { StreamEvent } from '../stream-brain/types';

export type BootstrapEvent = Pick<StreamEvent, 'id' | 'timestamp' | 'type' | 'summary' | 'importance'>;

export interface PartitionedBootstrapEvents {
  /** Observed during this session: evidence that something actually happened tonight. */
  currentSessionEvents: BootstrapEvent[];
  /** Observed on an earlier stream: background about these people, never evidence. */
  earlierStreamEvents: BootstrapEvent[];
}

export interface BootstrapEventLimits {
  currentSession?: number;
  earlierStreams?: number;
  minimumImportance?: number;
}

/**
 * Splits stored events on the session boundary.
 *
 * The bootstrap used to send one list, filled from `SELECT payload FROM stream_events ORDER BY
 * occurred_at DESC LIMIT 50` with no filter on session, channel or age, under the name
 * recentMeaningfulEvents. On a stream that began at 20:35:38 it carried 25 events from a previous
 * evening at a restaurant; the first thing the new session observed was a Dota draft screen, and
 * nine seconds later an account wrote "доехали до компов наконец-то" — a drive nobody had seen,
 * invented to join two states the payload presented as consecutive.
 *
 * Nothing is dropped and nothing is renamed away: the same events go to the model, in two lists
 * whose names say what they are worth. Newest-first in, oldest-first out, because that is the order
 * a reader expects a history in.
 */
export function partitionBootstrapEvents(
  newestFirst: StreamEvent[],
  sessionStartedAt: number,
  limits: BootstrapEventLimits = {},
): PartitionedBootstrapEvents {
  const minimumImportance = limits.minimumImportance ?? 0.6;
  const meaningful = newestFirst.filter((event) => event.importance >= minimumImportance);
  const take = (events: StreamEvent[], limit: number): BootstrapEvent[] => events
    .slice(0, limit)
    .reverse()
    .map(({ id, timestamp, type, summary, importance }) => ({ id, timestamp, type, summary, importance }));
  return {
    currentSessionEvents: take(
      meaningful.filter((event) => event.timestamp >= sessionStartedAt),
      limits.currentSession ?? 25,
    ),
    earlierStreamEvents: take(
      meaningful.filter((event) => event.timestamp < sessionStartedAt),
      limits.earlierStreams ?? 15,
    ),
  };
}
