export const STREAMER_MEMORY_TYPES = [
  'fact',
  'preference',
  'person',
  'relationship',
  'plan',
  'promise',
  'result',
  'place',
  'trip',
  'running_joke',
  'important_event',
  'recurring_context',
  'other',
] as const;

export type StreamerMemoryType = (typeof STREAMER_MEMORY_TYPES)[number];

export const STREAMER_MEMORY_STATUSES = ['active', 'resolved', 'superseded', 'expired'] as const;
export type StreamerMemoryStatus = (typeof STREAMER_MEMORY_STATUSES)[number];

export const STREAM_SESSION_STATUSES = ['live', 'ended', 'interrupted'] as const;
export type StreamSessionStatus = (typeof STREAM_SESSION_STATUSES)[number];

/** A single Twitch broadcast. It is channel-scoped, not persona-scoped. */
export interface StreamSession {
  id: string;
  channel: string;
  startedAt: number;
  /** Last observed activity; used to avoid reviving a dead session forever. */
  lastSeenAt: number;
  endedAt?: number;
  initialCategory?: string;
  initialStreamContext?: string;
  status: StreamSessionStatus;
  summary?: string;
}

/** Durable, public, stream-relevant knowledge about one channel. */
export interface StreamerMemory {
  id: string;
  channel: string;
  type: StreamerMemoryType;
  summary: string;
  details?: Record<string, unknown>;
  entities: string[];
  tags: string[];
  importance: number;
  confidence: number;
  occurredAt?: number;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  confirmationCount: number;
  sourceSessionId?: string;
  sourceEventId?: string;
  status: StreamerMemoryStatus;
  expiresAt?: number;
  resolvedAt?: number;
  supersededBy?: string;
  /** Internal deterministic identity for merge/reconfirmation. */
  dedupeKey: string;
}

/** Durable memory candidate proposed by the stateful Brain and validated by the backend. */
export interface StreamerMemoryCandidate {
  type: StreamerMemoryType;
  summary: string;
  details?: Record<string, unknown>;
  entities?: string[];
  tags?: string[];
  importance: number;
  confidence: number;
  occurredAt?: number | string;
  /** Absolute time, as epoch milliseconds or an ISO string. */
  expiresAt?: number | string | null;
  /** A simpler relative expiry hint for an operator or Brain proposal. */
  expiresInHours?: number | null;
  sourceEventId?: string;
  /** Marks an existing active memory as resolved once this one is saved. */
  resolvesMemoryId?: string;
  /** Marks an existing active memory as superseded once this one is saved. */
  supersedesMemoryId?: string;
}

export interface RecordStreamerMemoriesInput {
  memories: StreamerMemoryCandidate[];
}

export interface StreamerMemoryRecordAccepted {
  outcome: 'created' | 'merged';
  memory: StreamerMemory;
}

export interface StreamerMemoryRecordRejected {
  index: number;
  reason: string;
}

export interface StreamerMemoryRecordResult {
  accepted: StreamerMemoryRecordAccepted[];
  rejected: StreamerMemoryRecordRejected[];
}

export interface StartStreamSessionInput {
  channel: string;
  initialCategory?: string;
  initialStreamContext?: string;
}

export interface GlobalMemoryRetrievalInput {
  channel: string;
  query?: string;
  entities?: string[];
  tags?: string[];
  limit?: number;
  includeResolved?: boolean;
}

export interface StreamerMemoryListInput {
  channel: string;
  type?: StreamerMemoryType;
  status?: StreamerMemoryStatus;
  search?: string;
  limit?: number;
}

export interface UpdateStreamerMemoryInput {
  id: string;
  channel?: string;
  summary?: string;
  details?: Record<string, unknown>;
  entities?: string[];
  tags?: string[];
  importance?: number;
  confidence?: number;
  occurredAt?: number | null;
  expiresAt?: number | null;
  status?: Exclude<StreamerMemoryStatus, 'superseded'>;
}

export interface GlobalStreamerMemoryStats {
  channel: string;
  total: number;
  active: number;
  resolved: number;
  superseded: number;
  expired: number;
  duplicateMerges: number;
  averageImportance: number;
  averageConfidence: number;
}
