export const PERSONA_SCHEMA_VERSION = 2 as const;
export const PERSONA_GENERATION_VERSION = 3 as const;

export const PERSONA_EDITABLE_PATHS = [
  'name', 'description', 'identity.firstName', 'identity.preferredName', 'identity.nickname', 'identity.nicknameOrigin',
  'identity.birthDate', 'identity.birthplace', 'identity.grewUpIn', 'identity.currentLocation', 'identity.languages',
  'identity.occupation', 'identity.education', 'identity.relationshipStatus', 'familyBackground', 'family', 'timeline',
  'facts', 'opinions', 'knowledge', 'character', 'interests', 'speech', 'behavior', 'disclosure',
  'streamerRelationship', 'relationships',
] as const;
export type PersonaEditablePath = typeof PERSONA_EDITABLE_PATHS[number];

/**
 * Manual changes to these fields can make a newly generated surrounding canon
 * inconsistent even when the exact overridden field is preserved. They are
 * therefore never safe to apply as part of a bulk regeneration.
 */
export const SENSITIVE_PERSONA_REGENERATION_OVERRIDE_PATHS = [
  'name',
  'description',
  'identity.firstName',
  'identity.preferredName',
  'identity.nickname',
  'identity.nicknameOrigin',
  'identity.birthDate',
  'identity.birthplace',
  'identity.grewUpIn',
  'identity.currentLocation',
  'identity.languages',
  'identity.occupation',
  'identity.education',
  'identity.relationshipStatus',
  'familyBackground',
  'family',
  'timeline',
  'facts',
  'opinions',
  'disclosure',
  'relationships',
] as const satisfies readonly PersonaEditablePath[];

export type PersonaSource = 'generated' | 'manual';

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
  preferredName?: string;
  nickname?: string;
  nicknameOrigin?: string;
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
  | 'automotive'
  | 'animals'
  | 'art'
  | 'biology'
  | 'law'
  | 'money'
  | 'sport'
  | 'imperfection'
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
  openingPatterns: string[];
  endingPatterns: string[];
  vocabulary: string[];
  favoriteExpressions: string[];
  rareExpressions: string[];
  avoidedExpressions: string[];
  fillerWords: string[];
  abbreviations: string[];
  typoStyle: string[];
  punctuationStyle: string;
  capitalizationStyle: string;
  laughStyles: string[];
  emojiPreferences: string[];
  twitchEmotes: string[];
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
  /**
   * Canon and audit only; deliberately not in the generation payload. A number the model is shown
   * is a number it obeys, and a catalogue averaging 0.73 stacked on top of a cooldown the backend
   * had already enforced meant a moment could be refused twice for the same reason. chatFrequency
   * says how talkative a person is without reading as a per-event probability of silence.
   */
  eventSelectivity: number;
  /**
   * Free-text labels the catalogue authors chose ('football', 'gossip', 'dota-analysis'), not
   * StreamEventType values, so they line up with an emitted event type only by coincidence. The
   * fit signal that actually fires is a topical match against interests and expertise; see
   * `attentionFor` in the reaction coordinator.
   */
  preferredEventTypes: string[];
  ignoredEventTypes: string[];
  /** @deprecated Retained only to read existing v3 persona records; reaction scheduling ignores it. */
  averageDelayMs: { min: number; max: number };
}

export interface PersonaBehavior {
  styleInstructions: string;
  verbosity: { minWords: number; maxWords: number };
  /**
   * Canon only. These describe a character on paper and are read by the audit tooling, not by the
   * live path: one Brain call decides for every account at once, so a per-persona temperature or
   * emoji probability has nowhere to apply, and a probability the model is merely shown is a
   * probability it ignores. What actually shapes behaviour is minimumIntervalMs (enforced by the
   * policy guard), activity.chatFrequency, the topical fit derived from interests and expertise,
   * and the speech statistics in the generation snapshot.
   */
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

export type PersonaDisclosureLevel = 'open' | 'moderate' | 'private';

export interface PersonaDisclosure {
  defaultLevel: PersonaDisclosureLevel;
  privatePerson: boolean;
  topics: {
    family: PersonaDisclosureLevel;
    work: PersonaDisclosureLevel;
    relationships: PersonaDisclosureLevel;
    money: PersonaDisclosureLevel;
    location: PersonaDisclosureLevel;
  };
}

export interface BotPersona {
  schemaVersion: typeof PERSONA_SCHEMA_VERSION;
  generationVersion: number;
  source: PersonaSource;
  generatedFromUsername?: string;
  manuallyEdited: boolean;
  manualOverrides: PersonaEditablePath[];
  /** True when v2 predates override metadata and needs explicit operator review before v3 replacement. */
  legacyManualReviewRequired: boolean;
  /** Marks the biography as operator-authored fiction, never real personal data. */
  fictionalPersona: true;
  id: string;
  name: string;
  description: string;
  spokenAliases?: string[];
  identity: PersonaIdentity;
  familyBackground: string;
  family: PersonaRelative[];
  timeline: PersonaLifeEvent[];
  facts: PersonaFact[];
  opinions: PersonaOpinion[];
  knowledge: PersonaKnowledgeBoundaries;
  character: PersonaCharacter;
  interests: PersonaInterests;
  speech: SpeechFingerprint;
  behavior: PersonaBehavior;
  disclosure: PersonaDisclosure;
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

export const PERSONA_MEMORY_TYPES = [
  'stream_event', 'conversation', 'viewer', 'streamer', 'self', 'relationship',
] as const;
export type PersonaMemoryType = (typeof PERSONA_MEMORY_TYPES)[number];

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

/**
 * The operator's judgement on one message the accounts sent.
 *
 * Rules in the instruction carry taste badly — an em dash survived three separate attempts to
 * forbid it — while examples carry it well. A verdict here becomes an example the decision layer
 * reads: these are the messages this channel wanted, and these are the ones it did not.
 */
export interface MessageVerdictRecord {
  id: string;
  createdAt: number;
  username: string;
  message: string;
  verdict: 'good' | 'bad';
  /** Optional note in the operator's own words, which says more than the verdict alone. */
  note?: string;
  /** What the message was answering, when it is still known. */
  eventSummary?: string;
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
  quickSummary: string;
  completeness: number;
  uniqueness: number;
  consistency: number;
  mostSimilarPersonaId?: string;
  mostSimilarUsername?: string;
  similarityReasons: string[];
  qualityWarnings: string[];
}

export interface PersonaValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface PersonaSimilarityPair {
  leftPersonaId: string;
  rightPersonaId: string;
  leftUsername?: string;
  rightUsername?: string;
  similarity: number;
  reasons: string[];
}

/** Backend-only statistics for the fixed production cohort. */
export interface PersonaGenderDistribution {
  male: number;
  female: number;
  malePercentage: number;
  femalePercentage: number;
  femaleUsernames: string[];
}

/**
 * Verification record for an identity that was deliberately rebuilt as part
 * of the production cohort rebalance. It never travels to Gemini.
 */
export interface PersonaIdentityChangeAudit {
  username: string;
  canonicalName: string;
  status: 'matched' | 'diverged' | 'missing';
  observed?: {
    firstName: string;
    preferredName?: string;
  };
}

export interface PersonaAuditReport {
  accountCount: number;
  personaCount: number;
  uniquePersonaCount: number;
  uniqueSpeechFingerprintCount: number;
  /** Backend-only cohort audit metadata; never included in model context. */
  genderDistribution: PersonaGenderDistribution;
  /** Backend-only verification of the seven intentionally rebuilt identities. */
  identityChanges: PersonaIdentityChangeAudit[];
  countryOfBirthDistribution: Record<string, number>;
  currentCountryDistribution: Record<string, number>;
  currentCityDistribution: Record<string, number>;
  occupationDistribution: Record<string, number>;
  behaviorRanges: Record<string, { min: number; max: number }>;
  structureRanges: Record<string, { min: number; max: number }>;
  maximumSimilarity: number;
  averageSimilarity: number;
  mostSimilarPairs: PersonaSimilarityPair[];
  coherenceErrors: PersonaValidationIssue[];
  coherenceWarnings: PersonaValidationIssue[];
  duplicateNicknameOrigins: string[];
  duplicateRelativeNames: string[];
  duplicateFavoriteExpressions: string[];
  duplicateBiographyEvents: string[];
  duplicateSpeechExamples: string[];
}
