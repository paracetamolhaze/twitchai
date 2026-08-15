import { StreamerMemoryType } from '../global-memory/types';
import { ReactionExample } from '../learning/types';
import { PersonaMemoryType } from '../personas/types';
import { ChatMessage, StreamEvent } from '../stream-brain/types';

export type BrainThinkingLevel = 'low' | 'medium' | 'high';

export interface BrainPersonaSnapshot {
  username: string;
  preferredName: string;
  shortIdentity: string;
  character: string;
  activityPattern: {
    chatFrequency: 'very-low' | 'low' | 'medium' | 'high';
    directReplyLikelihood: number;
    eventSelectivity: number;
    preferredEventTypes?: string[];
    ignoredEventTypes?: string[];
  };
  speechFingerprint: string;
  expertise: string[];
  interests: string[];
  relationshipToStreamer: string;
  disclosureBoundaries: string;
}

export interface BrainBootstrap {
  channel: string;
  category: string;
  streamContext: string;
  startedAt: number;
  availableBots: string[];
  personas: BrainPersonaSnapshot[];
  globalMemories: Array<{
    type: StreamerMemoryType;
    summary: string;
    importance: number;
    confidence: number;
    entities: string[];
  }>;
  recentMeaningfulEvents: Array<Pick<StreamEvent, 'id' | 'timestamp' | 'type' | 'summary' | 'importance'>>;
  recentChat: Array<Pick<ChatMessage, 'timestamp' | 'username' | 'message' | 'kind'>>;
}

export interface BrainTargetedPersonaContext {
  username: string;
  relevantCanon: Array<{ kind: string; value: string }>;
  relevantMemories: Array<{ type: string; summary: string; importance: number }>;
  recentConversation: Array<{ role: 'viewer' | 'persona'; message: string }>;
  recentMessages: string[];
  personalResponseGuidance: string;
}

export interface BrainDynamicDelta {
  type: 'BOT_STATUS_UPDATE' | 'PERSONA_UPDATED' | 'CATEGORY_CHANGED' | 'MEMORY_ADDED' | 'CONTEXT_UPDATED';
  summary: string;
  payload?: Record<string, unknown>;
}

export interface BrainEventInput {
  triggerKind: 'external_stream_event';
  event: StreamEvent;
  availableBots: string[];
  recentChatDelta: Array<Pick<ChatMessage, 'timestamp' | 'username' | 'message' | 'kind'>>;
  targetedPersonaContext: BrainTargetedPersonaContext[];
  reactionExamples: ReactionExample[];
  deltas: BrainDynamicDelta[];
  constraints: {
    maxReactions: number;
    maxMessageBytes: number;
    globalSlotsAvailable: number;
    expiresAt: number;
  };
  mergedEventIds?: string[];
}

/**
 * One candidate's compact context for a Persona Drive opportunity — a small persona profile plus
 * runtime state and a handful of recalled memories, never the full targeted context an external
 * direct mention gets (see PersonaContextBuilder.build). Keeps a drive call cheap by construction.
 */
export interface BrainDriveCandidate {
  username: string;
  profile: BrainPersonaSnapshot;
  mood: string;
  engagement: number;
  sessionMessageCount: number;
  recalledMemories: Array<{ type: string; summary: string; importance: number }>;
  recentOwnMessages: string[];
}

/**
 * Internal spontaneous-initiation opportunity — never an observed StreamEvent. Gemini 3.1 Live
 * never sees or creates this; it only ever reaches Gemini 3.7 Brain via GeminiBrainService.
 * evaluateDriveOpportunity.
 */
export interface BrainDriveOpportunityInput {
  triggerKind: 'persona_drive';
  channel: string;
  category: string;
  streamContext: string;
  candidates: BrainDriveCandidate[];
  recentChat: Array<Pick<ChatMessage, 'timestamp' | 'username' | 'message' | 'kind'>>;
  deltas: BrainDynamicDelta[];
}

export interface BrainReaction {
  username: string;
  message: string;
}

export type BrainMemoryUpdate =
  | {
      scope: 'global';
      type: StreamerMemoryType;
      summary: string;
      importance: number;
      confidence: number;
      entities?: string[];
      tags?: string[];
    }
  | {
      scope: 'persona';
      username: string;
      type: PersonaMemoryType;
      summary: string;
      importance: number;
      confidence: number;
      tags?: string[];
      viewerUsername?: string;
    };

export interface BrainDecision {
  reactions: BrainReaction[];
  memoryUpdates: BrainMemoryUpdate[];
}

export interface BrainInteractionUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
}

export interface GeminiBrainStatus {
  state: 'OFFLINE' | 'STARTING' | 'READY' | 'THINKING' | 'ERROR';
  model: string;
  thinkingLevel: BrainThinkingLevel;
  sessionStartedAt?: number;
  interactionStartedAt?: number;
  previousInteractionId?: string;
  interactions: number;
  decisions: number;
  silentDecisions: number;
  generatedReactions: number;
  averageLatencyMs: number;
  lastLatencyMs?: number;
  lastError?: string;
  rebuiltSessions: number;
  rollovers: number;
  contextTokens: number;
  bootstrapChars: number;
  bootstrapInputTokens: number;
}
