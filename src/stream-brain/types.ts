export const STREAM_EVENT_TYPES = [
  'speech',
  'conversation',
  'greeting',
  'gameplay',
  // This channel is mostly IRL, and the vocabulary was built around games, so a walk through a
  // city had to be labelled as gameplay or 'other'. These name what actually happens on it.
  'food',
  'place',
  'purchase',
  'travel',
  'stranger',
  'mishap',
  'irl',
  'visual',
  'reaction',
  'question',
  'direct_mention',
  'funny',
  'fail',
  'win',
  'loss',
  'surprise',
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
  /** Present only for chat-originated direct questions and follow-up threads. */
  viewerUsername?: string;
}

export interface ChatMessage {
  id: string;
  timestamp: number;
  username: string;
  displayName: string;
  message: string;
  kind: 'viewer' | 'bot' | 'system';
}

/** One transcribed utterance, as words rather than as perception's description of them. */
export interface SpokenLine {
  timestamp: number;
  text: string;
}

export interface StreamContextSnapshot {
  channel: string;
  category: string;
  streamContext: string;
  isLive: boolean;
  recentChat: ChatMessage[];
  recentEvents: StreamEvent[];
  recentSpeech: SpokenLine[];
  botUsernames: string[];
  updatedAt: number;
}

export type GeminiClientState = 'STOPPED' | 'CONNECTING' | 'CONNECTED' | 'ERROR' | 'FATAL_CONFIG_ERROR';

export interface GeminiOutboundTraceEntry {
  at: number;
  type: string;
  bytes?: number;
}

export interface GeminiLiveDiagnostics {
  state: GeminiClientState;
  connected: boolean;
  stable: boolean;
  sessionActive: boolean;
  sessionStartedAt?: number;
  lastCloseCode?: number;
  lastCloseReason?: string;
  lastCloseWasClean?: boolean;
  lastSessionAgeMs?: number;
  lastOutbound?: string;
  lastToolCall?: string;
  lastToolResponse?: string;
  lastMediaInput?: 'audio' | 'video';
  outboundTrace: GeminiOutboundTraceEntry[];
  resumeAttempts: number;
  freshReconnects: number;
  audioChunksSent: number;
  videoFramesSent: number;
  transcriptsReceived: number;
  protocolErrorsInWindow: number;
  /** Model turns completed. Each one re-bills the retained context, so this drives Live cost. */
  modelTurns: number;
  /** Usage reports received. Far above modelTurns means the token total is double-counted. */
  usageReports: number;
  /** Whether retention is bounded by our values or left to the much larger service default. */
  contextWindowMode: 'explicit' | 'service_default';
  responseModality: 'text' | 'audio';
  /** Sessions remade because they went deaf while still connected and fed. */
  stallRecoveries: number;
  /** How long ago the session last produced a transcript or an event. */
  msSincePerceptionOutput?: number;
}

export interface StreamBrainStatus {
  state: 'STOPPED' | 'OFFLINE' | 'CONNECTING' | 'CONNECTED' | 'ERROR' | 'FATAL_CONFIG_ERROR' | 'DISABLED';
  mediaState: 'STOPPED' | 'CONNECTING' | 'STREAMING' | 'OFFLINE' | 'ERROR';
  geminiState: 'STOPPED' | 'CONNECTING' | 'CONNECTED' | 'ERROR' | 'FATAL_CONFIG_ERROR' | 'DISABLED';
  mediaConnected: boolean;
  geminiConnected: boolean;
  geminiStable: boolean;
  geminiSessionActive: boolean;
  geminiSessionReason: 'twitch_live' | 'twitch_offline' | 'media_connecting' | 'media_error' | 'fatal_error' | 'application_stopped' | 'disabled';
  model?: string;
  sessionStartedAt?: number;
  lastEventAt?: number;
  lastError?: string;
  lastCloseCode?: number;
  lastCloseReason?: string;
  lastCloseWasClean?: boolean;
  lastSessionAgeMs?: number;
  lastOutbound?: string;
  lastToolCall?: string;
  lastToolResponse?: string;
  lastMediaInput?: 'audio' | 'video';
  outboundTrace?: GeminiOutboundTraceEntry[];
  protocolErrorsInWindow?: number;
  resumeAttempts?: number;
  freshReconnects?: number;
  audioChunksSent?: number;
  videoFramesSent?: number;
  transcriptsReceived?: number;
  modelTurns?: number;
  usageReports?: number;
  contextWindowMode?: 'explicit' | 'service_default';
  responseModality?: 'text' | 'audio';
  stallRecoveries?: number;
  msSincePerceptionOutput?: number;
  /** Whisper running beside or instead of Live, so the two can be compared on one stream. */
  transcription?: {
    mode: 'gemini' | 'shadow' | 'whisper';
    model: string;
    segmentsSent: number;
    transcriptsReceived: number;
    audioSecondsSent: number;
    silenceSecondsSkipped: number;
    failures: number;
    lastTranscript?: string;
    lastLatencyMs?: number;
  };
  spokenMentionsDetected?: number;
  eligibleBots?: number;
}

export type StreamEventCandidate = Omit<
  StreamEvent,
  'id' | 'timestamp' | 'source' | 'category' | 'directMentions'
> & {
  timestamp?: number;
  directMentions?: string[];
};
