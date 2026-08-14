import { z } from 'zod';
import {
  BotPersona,
  PERSONA_EDITABLE_PATHS,
  PERSONA_GENERATION_VERSION,
  PERSONA_SCHEMA_VERSION,
  PersonaSummary,
} from './types';

const nonEmpty = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();
const probability = z.number().min(0).max(1);
const stringList = (maxItems = 50, maxLength = 160) => z.array(z.string().trim().min(1).max(maxLength)).max(maxItems);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

export const personaLocationSchema = z.object({
  country: z.string().trim().max(80),
  city: z.string().trim().max(100),
}).strict();

export const personaIdentitySchema = z.object({
  firstName: z.string().trim().max(100),
  preferredName: optionalText(100),
  nickname: optionalText(100),
  nicknameOrigin: optionalText(1_000),
  birthDate: isoDate,
  birthplace: personaLocationSchema.optional(),
  grewUpIn: personaLocationSchema.optional(),
  currentLocation: personaLocationSchema.optional(),
  languages: z.array(z.object({ language: nonEmpty(80), level: nonEmpty(80) }).strict()).max(12),
  occupation: optionalText(160),
  education: optionalText(300),
  relationshipStatus: optionalText(120),
}).strict();

export const personaRelativeSchema = z.object({
  id: nonEmpty(100),
  relation: z.enum(['mother', 'father', 'brother', 'sister', 'uncle', 'aunt', 'grandmother', 'grandfather', 'cousin', 'daughter', 'son', 'other']),
  name: nonEmpty(120),
  birthDate: isoDate,
  occupation: optionalText(160),
  city: optionalText(100),
  relationshipDescription: optionalText(500),
  facts: stringList(20, 300),
}).strict();

export const personaLifeEventSchema = z.object({
  id: nonEmpty(100),
  year: z.number().int().min(1900).max(2200).optional(),
  title: nonEmpty(200),
  description: nonEmpty(1_000),
  emotionalWeight: probability,
  tags: stringList(20, 80),
}).strict();

export const personaFactSchema = z.object({
  id: nonEmpty(100),
  category: z.enum(['family', 'childhood', 'education', 'work', 'gaming', 'food', 'music', 'travel', 'technology', 'automotive', 'animals', 'art', 'biology', 'law', 'money', 'sport', 'imperfection', 'relationships', 'habit', 'preference', 'story', 'other']),
  fact: nonEmpty(600),
  importance: probability,
  privateByDefault: z.boolean().optional(),
  tags: stringList(20, 80),
}).strict();

export const personaOpinionSchema = z.object({
  id: nonEmpty(100),
  topic: nonEmpty(160),
  stance: nonEmpty(600),
  strength: probability,
  reasoning: optionalText(600),
  immutable: z.boolean(),
  tags: stringList(20, 80),
}).strict();

export const speechFingerprintSchema = z.object({
  averageMessageWords: z.number().int().min(1).max(80),
  openingPatterns: stringList(30, 160),
  endingPatterns: stringList(30, 160),
  vocabulary: stringList(80, 100),
  favoriteExpressions: stringList(30, 160),
  rareExpressions: stringList(30, 160),
  avoidedExpressions: stringList(30, 160),
  fillerWords: stringList(30, 80),
  abbreviations: stringList(30, 80),
  typoStyle: stringList(20, 200),
  punctuationStyle: nonEmpty(300),
  capitalizationStyle: nonEmpty(300),
  laughStyles: stringList(20, 80),
  emojiPreferences: stringList(20, 40),
  twitchEmotes: stringList(20, 80),
  profanityLevel: probability,
  messageExamples: stringList(20, 400),
}).strict();

const activitySchema = z.object({
  chatFrequency: z.enum(['very-low', 'low', 'medium', 'high']),
  directReplyLikelihood: probability,
  eventSelectivity: probability,
  preferredEventTypes: stringList(20, 80),
  ignoredEventTypes: stringList(20, 80),
  averageDelayMs: z.object({
    min: z.number().int().min(0).max(300_000),
    max: z.number().int().min(0).max(300_000),
  }).strict(),
}).strict();

export const personaRelationshipSchema = z.object({
  targetPersonaId: nonEmpty(80),
  familiarity: probability,
  sentiment: z.number().min(-1).max(1),
  notes: stringList(30, 300),
}).strict();

export const personaBehaviorSchema = z.object({
  styleInstructions: nonEmpty(2_000),
  verbosity: z.object({
    minWords: z.number().int().min(1).max(50),
    maxWords: z.number().int().min(1).max(100),
  }).strict(),
  reactionProbability: probability,
  uppercaseProbability: probability,
  questionProbability: probability,
  emojiProbability: probability,
  slangLevel: probability,
  sarcasmLevel: probability,
  toxicityLimit: probability,
  temperature: z.number().min(0).max(2),
  minimumIntervalMs: z.number().int().min(1_000).max(3_600_000),
  imperfections: z.object({
    typingMistakes: stringList(20, 200),
    hesitations: stringList(20, 200),
    emotionalTriggers: stringList(20, 200),
    blindSpots: stringList(20, 200),
  }).strict(),
  activity: activitySchema,
}).strict();

export const personaSchema: z.ZodType<BotPersona> = z.object({
  schemaVersion: z.literal(PERSONA_SCHEMA_VERSION),
  generationVersion: z.number().int().min(0).max(10_000),
  source: z.enum(['generated', 'manual']),
  generatedFromUsername: optionalText(100),
  manuallyEdited: z.boolean(),
  manualOverrides: z.array(z.enum(PERSONA_EDITABLE_PATHS)).max(PERSONA_EDITABLE_PATHS.length),
  legacyManualReviewRequired: z.boolean(),
  fictionalPersona: z.literal(true),
  id: nonEmpty(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: nonEmpty(120),
  description: nonEmpty(1_000),
  identity: personaIdentitySchema,
  familyBackground: z.string().trim().max(2_000),
  family: z.array(personaRelativeSchema).max(30),
  timeline: z.array(personaLifeEventSchema).max(100),
  facts: z.array(personaFactSchema).max(500),
  opinions: z.array(personaOpinionSchema).max(100),
  knowledge: z.object({
    expertise: stringList(40, 120),
    familiarTopics: stringList(60, 120),
    weakTopics: stringList(60, 120),
    unknownTopics: stringList(60, 120),
  }).strict(),
  character: z.object({
    summary: nonEmpty(800),
    traits: stringList(30, 160),
    strengths: stringList(30, 160),
    flaws: stringList(30, 160),
    humor: nonEmpty(300),
    conflictStyle: nonEmpty(300),
  }).strict(),
  interests: z.object({
    games: stringList(50, 120),
    music: stringList(50, 120),
    food: stringList(50, 120),
    other: stringList(50, 120),
  }).strict(),
  speech: speechFingerprintSchema,
  behavior: personaBehaviorSchema,
  disclosure: z.object({
    defaultLevel: z.enum(['open', 'moderate', 'private']),
    privatePerson: z.boolean(),
    topics: z.object({
      family: z.enum(['open', 'moderate', 'private']),
      work: z.enum(['open', 'moderate', 'private']),
      relationships: z.enum(['open', 'moderate', 'private']),
      money: z.enum(['open', 'moderate', 'private']),
      location: z.enum(['open', 'moderate', 'private']),
    }).strict(),
  }).strict(),
  streamerRelationship: z.object({
    firstSeen: optionalText(80),
    familiarity: probability,
    supportiveness: probability,
    teasingLevel: probability,
    favoriteStreamTypes: stringList(30, 120),
    recurringReferences: stringList(30, 300),
    rememberedStreamerMoments: stringList(50, 500),
  }).strict(),
  relationships: z.array(personaRelationshipSchema).max(100),
  spokenAliases: stringList(10, 80).optional(),
}).strict();

export function upgradePersona(input: unknown, fallbackIndex = 0): BotPersona {
  const parsed = personaSchema.safeParse(input);
  if (parsed.success) return structuredClone(parsed.data);

  const raw = record(input);
  const id = slug(text(raw.id) || `persona-${fallbackIndex + 1}`);
  const name = text(raw.name) || `Новая личность ${fallbackIndex + 1}`;
  const seed = stableHash(id) + fallbackIndex;
  const identityRaw = record(raw.identity);
  const behaviorRaw = record(raw.behavior);
  const legacyInterests = stringArray(raw.interests);
  const persona: BotPersona = {
    schemaVersion: PERSONA_SCHEMA_VERSION,
    generationVersion: integer(raw.generationVersion, 0, 0, 10_000),
    source: raw.source === 'generated' ? 'generated' : 'manual',
    ...optional('generatedFromUsername', textOrUndefined(raw.generatedFromUsername)),
    manuallyEdited: typeof raw.manuallyEdited === 'boolean' ? raw.manuallyEdited : true,
    manualOverrides: stringArray(raw.manualOverrides).filter(isPersonaEditablePath),
    legacyManualReviewRequired: raw.legacyManualReviewRequired === true,
    fictionalPersona: true,
    id,
    name,
    description: text(raw.description) || 'Вымышленный постоянный зритель; биография пока не заполнена.',
    identity: {
      firstName: text(identityRaw.firstName) || name.split(/\s+/)[0] || '',
      ...optional('preferredName', textOrUndefined(identityRaw.preferredName)),
      ...optional('nickname', textOrUndefined(identityRaw.nickname)),
      ...optional('nicknameOrigin', textOrUndefined(identityRaw.nicknameOrigin)),
      ...optional('birthDate', validIsoDate(identityRaw.birthDate)),
      ...optional('birthplace', locationOrUndefined(identityRaw.birthplace)),
      ...optional('grewUpIn', locationOrUndefined(identityRaw.grewUpIn)),
      ...optional('currentLocation', locationOrUndefined(identityRaw.currentLocation)),
      languages: validItems(identityRaw.languages, z.object({ language: nonEmpty(80), level: nonEmpty(80) }).strict()),
      ...optional('occupation', textOrUndefined(identityRaw.occupation)),
      ...optional('education', textOrUndefined(identityRaw.education)),
      ...optional('relationshipStatus', textOrUndefined(identityRaw.relationshipStatus)),
    },
    familyBackground: text(raw.familyBackground),
    family: validItems(raw.family, personaRelativeSchema),
    timeline: validItems(raw.timeline, personaLifeEventSchema),
    facts: validItems(raw.facts, personaFactSchema),
    opinions: validItems(raw.opinions, personaOpinionSchema),
    knowledge: mergeKnowledge(raw.knowledge),
    character: mergeCharacter(raw.character, text(raw.description)),
    interests: mergeInterests(raw.interests, legacyInterests),
    speech: mergeSpeech(raw.speech, raw, seed),
    behavior: mergeBehavior(behaviorRaw, raw, seed),
    disclosure: mergeDisclosure(raw.disclosure),
    streamerRelationship: mergeStreamerRelationship(raw.streamerRelationship),
    relationships: validItems(raw.relationships, personaRelationshipSchema),
    ...(raw.spokenAliases ? { spokenAliases: stringArray(raw.spokenAliases) } : {}),
  };
  return personaSchema.parse(persona);
}

export function createBlankPersona(id: string, name = 'Новая личность'): BotPersona {
  return upgradePersona({
    id,
    name,
    generationVersion: PERSONA_GENERATION_VERSION,
    source: 'manual',
    manuallyEdited: true,
    manualOverrides: [],
    legacyManualReviewRequired: false,
    description: 'Вымышленный постоянный зритель; заполните устойчивую биографию.',
    identity: { firstName: name.split(/\s+/)[0] ?? '', languages: [] },
  });
}

export function ageFromBirthDate(birthDate: string | undefined, now = new Date()): number | undefined {
  if (!birthDate) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const birthday = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(birthday.getTime()) || birthday.getUTCFullYear() !== year || birthday.getUTCMonth() !== month - 1 || birthday.getUTCDate() !== day) return undefined;
  let age = now.getUTCFullYear() - year;
  if (now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day)) age -= 1;
  return age >= 0 && age <= 130 ? age : undefined;
}

export function personaCompleteness(persona: BotPersona): number {
  const sections = [
    Boolean(persona.identity.firstName && persona.identity.birthDate),
    Boolean(persona.identity.birthplace?.city),
    Boolean(persona.identity.currentLocation?.city && persona.identity.occupation),
    persona.family.length > 0,
    persona.timeline.length > 1,
    persona.facts.length > 2,
    persona.opinions.length > 1,
    persona.knowledge.expertise.length + persona.knowledge.weakTopics.length + persona.knowledge.unknownTopics.length > 2,
    persona.speech.favoriteExpressions.length > 0 && persona.speech.messageExamples.length > 1,
    persona.streamerRelationship.favoriteStreamTypes.length > 0,
  ];
  return Math.round((sections.filter(Boolean).length / sections.length) * 100);
}

export function personaSummary(persona: BotPersona, now = new Date()): PersonaSummary {
  const age = ageFromBirthDate(persona.identity.birthDate, now);
  return {
    id: persona.id,
    name: persona.name,
    firstName: persona.identity.firstName,
    ...(age !== undefined ? { age } : {}),
    ...(persona.identity.currentLocation?.city ? { city: persona.identity.currentLocation.city } : {}),
    ...(persona.identity.occupation ? { occupation: persona.identity.occupation } : {}),
    quickSummary: buildQuickPersonaSummary(persona, now),
    completeness: personaCompleteness(persona),
    uniqueness: 100,
    consistency: 100,
    similarityReasons: [],
    qualityWarnings: [],
  };
}

export function buildQuickPersonaSummary(persona: BotPersona, now = new Date()): string {
  const age = ageFromBirthDate(persona.identity.birthDate, now);
  const identity = [
    persona.identity.preferredName && persona.identity.preferredName !== persona.identity.firstName
      ? `${persona.identity.firstName} «${persona.identity.preferredName}»`
      : persona.identity.firstName,
    age === undefined ? undefined : `${age}`,
  ].filter(Boolean).join(', ');
  const birth = persona.identity.birthplace?.city ? `Родился(ась) в ${persona.identity.birthplace.city}.` : '';
  const current = persona.identity.currentLocation?.city
    ? `Сейчас живёт в ${persona.identity.currentLocation.city}${persona.identity.occupation ? ` и работает: ${persona.identity.occupation}` : ''}.`
    : persona.identity.occupation ? `Работает: ${persona.identity.occupation}.` : '';
  return [identity, birth, current, persona.character.summary, persona.streamerRelationship.favoriteStreamTypes.length
    ? `На Twitch чаще выбирает: ${persona.streamerRelationship.favoriteStreamTypes.join(', ')}.` : ''].filter(Boolean).join('\n');
}

function mergeKnowledge(value: unknown): BotPersona['knowledge'] {
  const raw = record(value);
  return {
    expertise: stringArray(raw.expertise),
    familiarTopics: stringArray(raw.familiarTopics),
    weakTopics: stringArray(raw.weakTopics),
    unknownTopics: stringArray(raw.unknownTopics),
  };
}

function mergeCharacter(value: unknown, description: string): BotPersona['character'] {
  const raw = record(value);
  return {
    summary: text(raw.summary) || description || 'Характер пока не описан.',
    traits: stringArray(raw.traits),
    strengths: stringArray(raw.strengths),
    flaws: stringArray(raw.flaws),
    humor: text(raw.humor) || 'естественный, без навязчивых шуток',
    conflictStyle: text(raw.conflictStyle) || 'не раздувает конфликт',
  };
}

function mergeInterests(value: unknown, legacy: string[]): BotPersona['interests'] {
  const raw = record(value);
  if (Array.isArray(value)) return { games: legacy, music: [], food: [], other: [] };
  return {
    games: stringArray(raw.games),
    music: stringArray(raw.music),
    food: stringArray(raw.food),
    other: stringArray(raw.other),
  };
}

function mergeSpeech(value: unknown, legacy: Record<string, unknown>, seed: number): BotPersona['speech'] {
  const raw = record(value);
  const vocabulary = stringArray(raw.vocabulary);
  return {
    averageMessageWords: integer(raw.averageMessageWords, integer(record(legacy.verbosity).maxWords, 8, 1, 80), 1, 80),
    openingPatterns: stringArray(raw.openingPatterns),
    endingPatterns: stringArray(raw.endingPatterns),
    vocabulary,
    favoriteExpressions: stringArray(raw.favoriteExpressions),
    rareExpressions: stringArray(raw.rareExpressions),
    avoidedExpressions: stringArray(raw.avoidedExpressions),
    fillerWords: stringArray(raw.fillerWords),
    abbreviations: stringArray(raw.abbreviations),
    typoStyle: stringArray(raw.typoStyle),
    punctuationStyle: text(raw.punctuationStyle) || (seed % 2 ? 'короткие фразы, точка редко' : 'обычная пунктуация без канцелярита'),
    capitalizationStyle: text(raw.capitalizationStyle) || (seed % 3 ? 'обычный регистр' : 'иногда капс на сильных эмоциях'),
    laughStyles: stringArray(raw.laughStyles),
    emojiPreferences: stringArray(raw.emojiPreferences),
    twitchEmotes: stringArray(raw.twitchEmotes),
    profanityLevel: bounded(raw.profanityLevel, bounded(legacy.toxicityLimit, 0.05)),
    messageExamples: stringArray(raw.messageExamples),
  };
}

function mergeBehavior(value: Record<string, unknown>, legacy: Record<string, unknown>, seed: number): BotPersona['behavior'] {
  const source = { ...legacy, ...value };
  const verbosity = record(source.verbosity);
  const imperfections = record(source.imperfections);
  const activity = record(source.activity);
  const delay = record(activity.averageDelayMs);
  const minWords = integer(verbosity.minWords, 2 + seed % 3, 1, 50);
  const maxWords = Math.max(minWords, integer(verbosity.maxWords, 10 + seed % 7, 1, 100));
  const minDelay = integer(delay.min, 1_200 + seed % 1_800, 0, 300_000);
  return {
    styleInstructions: text(source.styleInstructions) || 'Пиши как обычный зритель, не раскрывай биографию без причины.',
    verbosity: { minWords, maxWords },
    reactionProbability: bounded(source.reactionProbability, 0.35 + (seed % 25) / 100),
    uppercaseProbability: bounded(source.uppercaseProbability, (seed % 12) / 100),
    questionProbability: bounded(source.questionProbability, 0.08 + (seed % 18) / 100),
    emojiProbability: bounded(source.emojiProbability, (seed % 10) / 100),
    slangLevel: bounded(source.slangLevel, 0.25 + (seed % 45) / 100),
    sarcasmLevel: bounded(source.sarcasmLevel, 0.1 + (seed % 45) / 100),
    toxicityLimit: bounded(source.toxicityLimit, 0.05),
    temperature: number(source.temperature, 0.75 + (seed % 20) / 100),
    minimumIntervalMs: integer(source.minimumIntervalMs, 55_000 + (seed % 30_000), 1_000, 3_600_000),
    imperfections: {
      typingMistakes: stringArray(imperfections.typingMistakes),
      hesitations: stringArray(imperfections.hesitations),
      emotionalTriggers: stringArray(imperfections.emotionalTriggers),
      blindSpots: stringArray(imperfections.blindSpots),
    },
    activity: {
      chatFrequency: activityFrequency(activity.chatFrequency, seed),
      directReplyLikelihood: bounded(activity.directReplyLikelihood, 0.65 + (seed % 30) / 100),
      eventSelectivity: bounded(activity.eventSelectivity, 0.45 + (seed % 45) / 100),
      preferredEventTypes: stringArray(activity.preferredEventTypes),
      ignoredEventTypes: stringArray(activity.ignoredEventTypes),
      averageDelayMs: { min: minDelay, max: Math.max(minDelay, integer(delay.max, minDelay + 4_000, 0, 300_000)) },
    },
  };
}

function mergeDisclosure(value: unknown): BotPersona['disclosure'] {
  const raw = record(value);
  const topics = record(raw.topics);
  const level = (candidate: unknown, fallback: BotPersona['disclosure']['defaultLevel']) =>
    candidate === 'open' || candidate === 'moderate' || candidate === 'private' ? candidate : fallback;
  const defaultLevel = level(raw.defaultLevel, 'moderate');
  return {
    defaultLevel,
    privatePerson: typeof raw.privatePerson === 'boolean' ? raw.privatePerson : defaultLevel === 'private',
    topics: {
      family: level(topics.family, defaultLevel),
      work: level(topics.work, defaultLevel),
      relationships: level(topics.relationships, 'private'),
      money: level(topics.money, 'private'),
      location: level(topics.location, defaultLevel),
    },
  };
}

function mergeStreamerRelationship(value: unknown): BotPersona['streamerRelationship'] {
  const raw = record(value);
  return {
    ...optional('firstSeen', textOrUndefined(raw.firstSeen)),
    familiarity: bounded(raw.familiarity, 0.2),
    supportiveness: bounded(raw.supportiveness, 0.55),
    teasingLevel: bounded(raw.teasingLevel, 0.2),
    favoriteStreamTypes: stringArray(raw.favoriteStreamTypes),
    recurringReferences: stringArray(raw.recurringReferences),
    rememberedStreamerMoments: stringArray(raw.rememberedStreamerMoments),
  };
}

function locationOrUndefined(value: unknown): { country: string; city: string } | undefined {
  const parsed = personaLocationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function validIsoDate(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function validItems<T>(value: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

function isPersonaEditablePath(value: string): value is BotPersona['manualOverrides'][number] {
  return (PERSONA_EDITABLE_PATHS as readonly string[]).includes(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function textOrUndefined(value: unknown): string | undefined { return text(value) || undefined; }
function number(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function bounded(value: unknown, fallback: number): number { return Math.min(1, Math.max(0, number(value, fallback))); }
function integer(value: unknown, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(number(value, fallback))));
}
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: V };
}
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'persona';
}
function stableHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}
function activityFrequency(value: unknown, seed: number): BotPersona['behavior']['activity']['chatFrequency'] {
  if (value === 'very-low' || value === 'low' || value === 'medium' || value === 'high') return value;
  return (['very-low', 'low', 'medium', 'high'] as const)[seed % 4]!;
}
