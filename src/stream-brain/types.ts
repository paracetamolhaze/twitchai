export const STREAM_EVENT_TYPES = [
  'speech',
  'gameplay',
  'reaction',
  'funny',
  'fail',
  'win',
  'loss',
  'surprise',
  'conversation',
  'irl',
  'other',
] as const;

export type StreamEventType = (typeof STREAM_EVENT_TYPES)[number];

export type StreamEventSource = 'gemini-live' | 'chat' | 'fallback-transcription';

export interface StreamEvent {
  id: string;
  timestamp: number;
  type: StreamEventType;
  summary: string;
  speech?: string;
  visualContext?: string;
  gameContext?: string;
  emotion?: string;
  category?: string;
  importance: number;
  confidence: number;
  source: StreamEventSource;
  directMentions: string[];
}

export interface ChatMessage {
  id: string;
  timestamp: number;
  username: string;
  displayName: string;
  message: string;
  kind: 'viewer' | 'bot' | 'system';
}

export interface StreamContextSnapshot {
  channel: string;
  category: string;
  streamContext: string;
  isLive: boolean;
  recentChat: ChatMessage[];
  recentEvents: StreamEvent[];
  botUsernames: string[];
  updatedAt: number;
}

export interface StreamBrainStatus {
  state: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR' | 'DISABLED';
  mediaConnected: boolean;
  geminiConnected: boolean;
  model?: string;
  sessionStartedAt?: number;
  lastEventAt?: number;
  lastError?: string;
}

export type StreamEventCandidate = Omit<
  StreamEvent,
  'id' | 'timestamp' | 'source' | 'category' | 'directMentions'
> & {
  timestamp?: number;
  directMentions?: string[];
};
