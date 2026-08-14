export const PERSONA_SCHEMA_VERSION = 2 as const;

export interface PersonaLocation {
  country: string;
  city: string;
}

export interface PersonaLanguage {
  language: string;
  level: string;
}

export interface PersonaIdentity {
  firstName: string;
  nickname?: string;
  /** ISO YYYY-MM-DD. Age is derived at read time and is never persisted separately. */
  birthDate?: string;
  birthplace?: PersonaLocation;
  grewUpIn?: PersonaLocation;
  currentLocation?: PersonaLocation;
  languages: PersonaLanguage[];
  occupation?: string;
  education?: string;
  relationshipStatus?: string;
}

export type PersonaRelativeKind =
  | 'mother'
  | 'father'
  | 'brother'
  | 'sister'
  | 'uncle'
  | 'aunt'
  | 'grandmother'
  | 'grandfather'
  | 'cousin'
  | 'daughter'
  | 'son'
  | 'other';

export interface PersonaRelative {
  id: string;
  relation: PersonaRelativeKind;
  name: string;
  birthDate?: string;
  occupation?: string;
  city?: string;
  relationshipDescription?: string;
  facts: string[];
}

export interface PersonaLifeEvent {
  id: string;
  year?: number;
  title: string;
  description: string;
  emotionalWeight: number;
  tags: string[];
}

export type PersonaFactCategory =
  | 'family'
  | 'childhood'
  | 'education'
  | 'work'
  | 'gaming'
  | 'food'
  | 'music'
  | 'travel'
  | 'technology'
  | 'relationships'
  | 'habit'
  | 'preference'
  | 'story'
  | 'other';

export interface PersonaFact {
  id: string;
  category: PersonaFactCategory;
  fact: string;
  importance: number;
  privateByDefault?: boolean;
  tags: string[];
}

export interface PersonaOpinion {
  id: string;
  topic: string;
  stance: string;
  strength: number;
  reasoning?: string;
  immutable: boolean;
  tags: string[];
}

export interface PersonaKnowledgeBoundaries {
  expertise: string[];
  familiarTopics: string[];
  weakTopics: string[];
  unknownTopics: string[];
}

export interface SpeechFingerprint {
  averageMessageWords: number;
  vocabulary: string[];
  favoriteExpressions: string[];
  rareExpressions: string[];
  avoidedExpressions: string[];
  fillerWords: string[];
  typoStyle: string[];
  punctuationStyle: string;
  capitalizationStyle: string;
  laughStyles: string[];
  emojiPreferences: string[];
  profanityLevel: number;
  messageExamples: string[];
}

export interface PersonaCharacter {
  summary: string;
  traits: string[];
  strengths: string[];
  flaws: string[];
  humor: string;
  conflictStyle: string;
}

export interface PersonaImperfections {
  typingMistakes: string[];
  hesitations: string[];
  emotionalTriggers: string[];
  blindSpots: string[];
}

export interface PersonaActivityPattern {
  chatFrequency: 'very-low' | 'low' | 'medium' | 'high';
  directReplyLikelihood: number;
  eventSelectivity: number;
  preferredEventTypes: string[];
  averageDelayMs: { min: number; max: number };
}

export interface PersonaBehavior {
  styleInstructions: string;
  verbosity: { minWords: number; maxWords: number };
  reactionProbability: number;
  uppercaseProbability: number;
  questionProbability: number;
  emojiProbability: number;
  slangLevel: number;
  sarcasmLevel: number;
  toxicityLimit: number;
  temperature: number;
  minimumIntervalMs: number;
  imperfections: PersonaImperfections;
  activity: PersonaActivityPattern;
}

export interface PersonaInterests {
  games: string[];
  music: string[];
  food: string[];
  other: string[];
}

export interface StreamerRelationship {
  firstSeen?: string;
  familiarity: number;
  supportiveness: number;
  teasingLevel: number;
  favoriteStreamTypes: string[];
  recurringReferences: string[];
  rememberedStreamerMoments: string[];
}

export interface PersonaRelationship {
  targetPersonaId: string;
  familiarity: number;
  sentiment: number;
  notes: string[];
}

export interface BotPersona {
  schemaVersion: typeof PERSONA_SCHEMA_VERSION;
  /** Marks the biography as operator-authored fiction, never real personal data. */
  fictionalPersona: true;
  id: string;
  name: string;
  description: string;
  identity: PersonaIdentity;
  family: PersonaRelative[];
  timeline: PersonaLifeEvent[];
  facts: PersonaFact[];
  opinions: PersonaOpinion[];
  knowledge: PersonaKnowledgeBoundaries;
  character: PersonaCharacter;
  interests: PersonaInterests;
  speech: SpeechFingerprint;
  behavior: PersonaBehavior;
  streamerRelationship: StreamerRelationship;
  relationships: PersonaRelationship[];
}

export type PersonaMood = 'neutral' | 'good' | 'tired' | 'annoyed' | 'excited' | 'focused';

export interface PersonaRuntimeState {
  mood: PersonaMood;
  engagement: number;
  sessionMessageCount: number;
  lastActiveAt?: number;
}

export type PersonaMemoryType = 'stream_event' | 'conversation' | 'viewer' | 'streamer' | 'self' | 'relationship';

export interface PersonaMemoryItem {
  id: string;
  personaId: string;
  createdAt: number;
  type: PersonaMemoryType;
  summary: string;
  importance: number;
  tags: string[];
  viewerUsername?: string;
  eventId?: string;
  expiresAt?: number;
}

export interface PersonaConversationMessage {
  id: string;
  personaId: string;
  viewerUsername: string;
  role: 'viewer' | 'persona';
  message: string;
  createdAt: number;
  expiresAt: number;
}

export interface BotMessageRecord {
  id: string;
  username: string;
  message: string;
  eventId?: string;
  sentAt: number;
}

export interface PersonaSummary {
  id: string;
  name: string;
  firstName: string;
  age?: number;
  city?: string;
  occupation?: string;
  completeness: number;
}
