import { StreamEvent } from '../stream-brain/types';

export interface ReactionExample {
  id: string;
  timestamp: number;
  game: string;
  streamContext: string;
  eventType: StreamEvent['type'];
  event: string;
  transcript?: string;
  chatMessages: string[];
}
