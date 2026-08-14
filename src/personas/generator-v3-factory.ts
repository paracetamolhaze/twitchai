import type { PersonaBlueprint, RelativeBlueprint, TimelineBlueprint, FactBlueprint, OpinionBlueprint } from './generator-v3-data';
import type { BotPersona, PersonaDisclosure } from './types';

export interface CompactVoice {
  averageWords: number;
  openings: string[];
  endings: string[];
  favorite: string[];
  rare: string[];
  avoided: string[];
  fillers: string[];
  abbreviations: string[];
  typos: string[];
  punctuation: string;
  capitalization: string;
  laughs: string[];
  emoji: string[];
  emotes: string[];
  profanity: number;
  examples: string[];
}

export interface CompactBehavior {
  instructions: string;
  words: { min: number; max: number };
  metrics: {
    reactionProbability: number;
    uppercaseProbability: number;
    questionProbability: number;
    emojiProbability: number;
    slangLevel: number;
    sarcasmLevel: number;
    toxicityLimit: number;
    temperature: number;
  };
  minimumIntervalMs: number;
  mistakes: string[];
  hesitations: string[];
  triggers: string[];
  blindSpots: string[];
  chatFrequency: BotPersona['behavior']['activity']['chatFrequency'];
  directReply: number;
  selectivity: number;
  preferredEvents: string[];
  ignoredEvents: string[];
  delay: { min: number; max: number };
}

export interface CompactBlueprint {
  username: string;
  firstName: string;
  preferredName: string;
  lastName?: string;
  birthDate: string;
  birthplace: { country: string; city: string };
  grewUpIn?: { country: string; city: string };
  currentLocation: { country: string; city: string };
  languages: Array<{ language: string; level: string }>;
  occupation: string;
  education: string;
  relationshipStatus: string;
  nicknameOrigin: string;
  familyBackground: string;
  family: RelativeBlueprint[];
  timeline: TimelineBlueprint[];
  facts: FactBlueprint[];
  opinions: OpinionBlueprint[];
  knowledge: PersonaBlueprint['knowledge'];
  character: PersonaBlueprint['character'];
  interests: PersonaBlueprint['interests'];
  voice: CompactVoice;
  behavior: CompactBehavior;
  disclosure: PersonaDisclosure;
  twitch: PersonaBlueprint['streamerRelationship'];
}

export function definePersona(input: CompactBlueprint): PersonaBlueprint {
  if (input.voice.examples.length < 15) throw new Error(`Persona ${input.username} needs at least 15 distinct chat examples`);
  const {
    reactionProbability,
    uppercaseProbability,
    questionProbability,
    emojiProbability,
    slangLevel,
    sarcasmLevel,
    toxicityLimit,
    temperature,
  } = input.behavior.metrics;
  return {
    username: input.username,
    firstName: input.firstName,
    preferredName: input.preferredName,
    ...(input.lastName ? { lastName: input.lastName } : {}),
    birthDate: input.birthDate,
    birthplace: input.birthplace,
    grewUpIn: input.grewUpIn ?? input.birthplace,
    currentLocation: input.currentLocation,
    languages: input.languages,
    occupation: input.occupation,
    education: input.education,
    relationshipStatus: input.relationshipStatus,
    nicknameOrigin: input.nicknameOrigin,
    familyBackground: input.familyBackground,
    family: input.family,
    timeline: input.timeline,
    facts: input.facts,
    opinions: input.opinions,
    knowledge: input.knowledge,
    character: input.character,
    interests: input.interests,
    speech: {
      averageMessageWords: input.voice.averageWords,
      openingPatterns: input.voice.openings,
      endingPatterns: input.voice.endings,
      vocabulary: [...new Set([...input.voice.favorite, ...input.voice.fillers, ...input.voice.abbreviations])],
      favoriteExpressions: input.voice.favorite,
      rareExpressions: input.voice.rare,
      avoidedExpressions: [...new Set(input.voice.avoided)],
      fillerWords: input.voice.fillers,
      abbreviations: input.voice.abbreviations,
      typoStyle: input.voice.typos,
      punctuationStyle: input.voice.punctuation,
      capitalizationStyle: input.voice.capitalization,
      laughStyles: input.voice.laughs,
      emojiPreferences: input.voice.emoji,
      twitchEmotes: input.voice.emotes,
      profanityLevel: input.voice.profanity,
      messageExamples: input.voice.examples,
    },
    behavior: {
      styleInstructions: input.behavior.instructions,
      verbosity: { minWords: input.behavior.words.min, maxWords: input.behavior.words.max },
      reactionProbability,
      uppercaseProbability,
      questionProbability,
      emojiProbability,
      slangLevel,
      sarcasmLevel,
      toxicityLimit,
      temperature,
      minimumIntervalMs: input.behavior.minimumIntervalMs,
      imperfections: {
        typingMistakes: input.behavior.mistakes,
        hesitations: input.behavior.hesitations,
        emotionalTriggers: input.behavior.triggers,
        blindSpots: input.behavior.blindSpots,
      },
      activity: {
        chatFrequency: input.behavior.chatFrequency,
        directReplyLikelihood: input.behavior.directReply,
        eventSelectivity: input.behavior.selectivity,
        preferredEventTypes: input.behavior.preferredEvents,
        ignoredEventTypes: input.behavior.ignoredEvents,
        averageDelayMs: { min: input.behavior.delay.min, max: input.behavior.delay.max },
      },
    },
    disclosure: input.disclosure,
    streamerRelationship: input.twitch,
  };
}
