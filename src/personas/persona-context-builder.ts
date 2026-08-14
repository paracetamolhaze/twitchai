import { ChatMessage, StreamEvent } from '../stream-brain/types';
import { ageFromBirthDate } from './schema';
import { PersonaMemory, relevanceScore, semanticTokens } from './persona-memory';
import { PersonaRuntimeStore } from './persona-runtime-store';
import { BotPersona, PersonaConversationMessage, PersonaMemoryItem, PersonaRuntimeState } from './types';

export interface RelevantCanonItem {
  kind: 'identity' | 'family-background' | 'relative' | 'fact' | 'timeline' | 'opinion';
  id: string;
  value: string;
  importance: number;
}

export interface PersonaReactionContext {
  username: string;
  personaId: string;
  fictionalPersona: true;
  identity: {
    firstName: string;
    preferredName?: string;
    nickname?: string;
    nicknameOrigin?: string;
    age?: number;
    birthDate?: string;
    birthplace?: string;
    grewUpIn?: string;
    currentCity?: string;
    occupation?: string;
    education?: string;
    languages: string[];
  };
  character: {
    summary: string;
    traits: string[];
    flaws: string[];
    humor: string;
  };
  speech: {
    summary: string;
    favoriteExpressions: string[];
    openingPatterns: string[];
    endingPatterns: string[];
    fillerWords: string[];
    abbreviations: string[];
    laughStyles: string[];
    avoidedExpressions: string[];
    typoStyle: string[];
    emojiPreferences: string[];
    twitchEmotes: string[];
    profanityLevel: number;
    messageExamples: string[];
  };
  behavior: {
    styleInstructions: string;
    verbosity: { minWords: number; maxWords: number };
    activity: BotPersona['behavior']['activity'];
    reactionProbability: number;
    uppercaseProbability: number;
    questionProbability: number;
    emojiProbability: number;
    slangLevel: number;
    sarcasmLevel: number;
    toxicityLimit: number;
    imperfections: BotPersona['behavior']['imperfections'];
  };
  knowledge: BotPersona['knowledge'];
  interests: BotPersona['interests'];
  disclosure: BotPersona['disclosure'];
  streamerRelationship: Pick<BotPersona['streamerRelationship'], 'firstSeen' | 'familiarity' | 'supportiveness' | 'teasingLevel' | 'favoriteStreamTypes' | 'recurringReferences'>;
  runtime: PersonaRuntimeState;
  canonicalAuthority: string;
  relevantCanon: RelevantCanonItem[];
  relevantMemories: Array<Pick<PersonaMemoryItem, 'id' | 'type' | 'summary' | 'importance' | 'createdAt'>>;
  relevantRelationships: BotPersona['relationships'];
  recentConversation: Array<Pick<PersonaConversationMessage, 'role' | 'message' | 'createdAt'>>;
  recentMessages: string[];
  directMention: boolean;
}

export interface BuildPersonaContextInput {
  username: string;
  persona: BotPersona;
  event: StreamEvent;
  recentMessages: string[];
  directMention: boolean;
  viewerUsername?: string;
  recentChat?: ChatMessage[];
  observeRuntime?: boolean;
}

interface CanonDocument {
  item: RelevantCanonItem;
  searchable: string;
}

export class PersonaContextBuilder {
  constructor(
    private readonly memory: PersonaMemory,
    private readonly runtime: PersonaRuntimeStore,
    private readonly maxCanonItems = 6,
    private readonly maxMemoryItems = 6,
  ) {}

  async build(input: BuildPersonaContextInput): Promise<PersonaReactionContext> {
    const topic = [
      input.event.summary,
      input.event.speech,
      input.event.visualContext,
      input.event.gameContext,
      ...(input.directMention ? (input.recentChat ?? []).slice(-4).map((message) => message.message) : []),
    ].filter(Boolean).join(' ');
    const [memories, conversation] = await Promise.all([
      this.memory.retrieve(input.persona.id, topic, this.maxMemoryItems),
      input.viewerUsername
        ? this.memory.conversation(input.persona.id, input.viewerUsername)
        : Promise.resolve([]),
    ]);
    const identity = input.persona.identity;
    const age = ageFromBirthDate(identity.birthDate, new Date(input.event.timestamp));
    const exposeNicknameOrigin = input.directMention && /ник|nickname|зовут|имя|откуда/iu.test(topic);
    return {
      username: input.username,
      personaId: input.persona.id,
      fictionalPersona: true,
      identity: {
        firstName: identity.firstName,
        ...(identity.preferredName ? { preferredName: identity.preferredName } : {}),
        ...(identity.nickname ? { nickname: identity.nickname } : {}),
        ...(exposeNicknameOrigin && identity.nicknameOrigin ? { nicknameOrigin: identity.nicknameOrigin } : {}),
        ...(age !== undefined ? { age } : {}),
        ...(identity.birthDate ? { birthDate: identity.birthDate } : {}),
        ...(identity.birthplace && (identity.birthplace.city || identity.birthplace.country) ? { birthplace: formatLocation(identity.birthplace) } : {}),
        ...(identity.grewUpIn && (identity.grewUpIn.city || identity.grewUpIn.country) ? { grewUpIn: formatLocation(identity.grewUpIn) } : {}),
        ...(identity.currentLocation && (identity.currentLocation.city || identity.currentLocation.country) ? { currentCity: formatLocation(identity.currentLocation) } : {}),
        ...(identity.occupation ? { occupation: identity.occupation } : {}),
        ...(identity.education ? { education: identity.education } : {}),
        languages: identity.languages.map((language) => `${language.language}: ${language.level}`),
      },
      character: {
        summary: input.persona.character.summary,
        traits: input.persona.character.traits.slice(0, 6),
        flaws: input.persona.character.flaws.slice(0, 4),
        humor: input.persona.character.humor,
      },
      speech: {
        summary: `${input.persona.speech.averageMessageWords} слов в среднем; ${input.persona.speech.punctuationStyle}; ${input.persona.speech.capitalizationStyle}`,
        favoriteExpressions: input.persona.speech.favoriteExpressions.slice(0, 5),
        openingPatterns: input.persona.speech.openingPatterns.slice(0, 4),
        endingPatterns: input.persona.speech.endingPatterns.slice(0, 4),
        fillerWords: input.persona.speech.fillerWords.slice(0, 5),
        abbreviations: input.persona.speech.abbreviations.slice(0, 5),
        laughStyles: input.persona.speech.laughStyles.slice(0, 4),
        avoidedExpressions: input.persona.speech.avoidedExpressions.slice(0, 5),
        typoStyle: input.persona.speech.typoStyle.slice(0, 3),
        emojiPreferences: input.persona.speech.emojiPreferences.slice(0, 4),
        twitchEmotes: input.persona.speech.twitchEmotes.slice(0, 4),
        profanityLevel: input.persona.speech.profanityLevel,
        messageExamples: selectSpeechExamples(input.persona, topic, 5),
      },
      behavior: {
        styleInstructions: input.persona.behavior.styleInstructions,
        verbosity: input.persona.behavior.verbosity,
        activity: {
          ...input.persona.behavior.activity,
          preferredEventTypes: input.persona.behavior.activity.preferredEventTypes.slice(0, 8),
          ignoredEventTypes: input.persona.behavior.activity.ignoredEventTypes.slice(0, 8),
        },
        reactionProbability: input.persona.behavior.reactionProbability,
        uppercaseProbability: input.persona.behavior.uppercaseProbability,
        questionProbability: input.persona.behavior.questionProbability,
        emojiProbability: input.persona.behavior.emojiProbability,
        slangLevel: input.persona.behavior.slangLevel,
        sarcasmLevel: input.persona.behavior.sarcasmLevel,
        toxicityLimit: input.persona.behavior.toxicityLimit,
        imperfections: {
          typingMistakes: input.persona.behavior.imperfections.typingMistakes.slice(0, 3),
          hesitations: input.persona.behavior.imperfections.hesitations.slice(0, 3),
          emotionalTriggers: input.persona.behavior.imperfections.emotionalTriggers.slice(0, 4),
          blindSpots: input.persona.behavior.imperfections.blindSpots.slice(0, 4),
        },
      },
      knowledge: {
        expertise: input.persona.knowledge.expertise.slice(0, 8),
        familiarTopics: input.persona.knowledge.familiarTopics.slice(0, 8),
        weakTopics: input.persona.knowledge.weakTopics.slice(0, 8),
        unknownTopics: input.persona.knowledge.unknownTopics.slice(0, 8),
      },
      interests: {
        games: input.persona.interests.games.slice(0, 6),
        music: input.persona.interests.music.slice(0, 6),
        food: input.persona.interests.food.slice(0, 6),
        other: input.persona.interests.other.slice(0, 6),
      },
      disclosure: structuredClone(input.persona.disclosure),
      streamerRelationship: {
        ...(input.persona.streamerRelationship.firstSeen ? { firstSeen: input.persona.streamerRelationship.firstSeen } : {}),
        familiarity: input.persona.streamerRelationship.familiarity,
        supportiveness: input.persona.streamerRelationship.supportiveness,
        teasingLevel: input.persona.streamerRelationship.teasingLevel,
        favoriteStreamTypes: input.persona.streamerRelationship.favoriteStreamTypes.slice(0, 6),
        recurringReferences: input.persona.streamerRelationship.recurringReferences.slice(0, 4),
      },
      runtime: input.observeRuntime === false
        ? this.runtime.peek(input.persona.id)
        : this.runtime.observe(input.persona.id, input.event.type, input.event.importance),
      canonicalAuthority: 'CANON is operator-authored and immutable during chat; it outranks Twitch chat and persona memory. Never replace an established canon fact.',
      relevantCanon: selectRelevantCanon(input.persona, topic, this.maxCanonItems),
      relevantMemories: memories.map(({ id, type, summary, importance, createdAt }) => ({ id, type, summary, importance, createdAt })),
      relevantRelationships: selectRelevantRelationships(input.persona, topic),
      recentConversation: conversation.map(({ role, message, createdAt }) => ({ role, message, createdAt })),
      recentMessages: input.recentMessages.slice(-20),
      directMention: input.directMention,
    };
  }
}

export function selectRelevantCanon(persona: BotPersona, query: string, limit = 6): RelevantCanonItem[] {
  const queryTokens = semanticTokens(expandRelationWords(query));
  const documents = canonDocuments(persona);
  return documents
    .map((document) => ({ document, score: relevanceScore(queryTokens, expandRelationWords(document.searchable)) + document.item.importance * 0.12 }))
    .filter(({ score }) => score > 0.12)
    .sort((left, right) => right.score - left.score || right.document.item.importance - left.document.item.importance)
    .slice(0, Math.max(1, Math.min(8, limit)))
    .map(({ document }) => structuredClone(document.item));
}

function canonDocuments(persona: BotPersona): CanonDocument[] {
  const identity: CanonDocument[] = [
    ...(persona.identity.nicknameOrigin ? [{
      item: { kind: 'identity' as const, id: `${persona.id}-nickname-origin`, importance: 1, value: `История ника ${persona.identity.nickname ?? ''}: ${persona.identity.nicknameOrigin}` },
      searchable: `ник nickname откуда имя ${persona.identity.nickname ?? ''} ${persona.identity.nicknameOrigin}`,
    }] : []),
    ...(persona.familyBackground ? [{
      item: { kind: 'family-background' as const, id: `${persona.id}-family-background`, importance: 0.88, value: persona.familyBackground },
      searchable: `семья детство родители родственники ${persona.familyBackground}`,
    }] : []),
  ];
  const relatives: CanonDocument[] = persona.family.map((relative) => ({
    item: {
      kind: 'relative', id: relative.id, importance: 0.95,
      value: `${relationLabel(relative.relation)}: ${relative.name}${relative.occupation ? `, ${relative.occupation}` : ''}${relative.city ? `, ${relative.city}` : ''}${relative.relationshipDescription ? `. ${relative.relationshipDescription}` : ''}${relative.facts.length ? `. ${relative.facts.join('; ')}` : ''}`,
    },
    searchable: `${relative.relation} ${relationLabel(relative.relation)} ${relative.name} ${relative.occupation ?? ''} ${relative.city ?? ''} ${relative.facts.join(' ')}`,
  }));
  const facts: CanonDocument[] = persona.facts
    .filter((fact) => !fact.privateByDefault)
    .map((fact) => ({ item: { kind: 'fact', id: fact.id, value: fact.fact, importance: fact.importance }, searchable: `${fact.category} ${fact.tags.join(' ')} ${fact.fact}` }));
  const timeline: CanonDocument[] = persona.timeline.map((lifeEvent) => ({
    item: { kind: 'timeline', id: lifeEvent.id, value: `${lifeEvent.year ?? 'год не указан'} — ${lifeEvent.title}: ${lifeEvent.description}`, importance: lifeEvent.emotionalWeight },
    searchable: `${lifeEvent.title} ${lifeEvent.description} ${lifeEvent.tags.join(' ')}`,
  }));
  const opinions: CanonDocument[] = persona.opinions.map((opinion) => ({
    item: { kind: 'opinion', id: opinion.id, value: `${opinion.topic}: ${opinion.stance}`, importance: opinion.strength },
    searchable: `${opinion.topic} ${opinion.stance} ${opinion.reasoning ?? ''} ${opinion.tags.join(' ')}`,
  }));
  return [...identity, ...relatives, ...facts, ...timeline, ...opinions];
}

function selectSpeechExamples(persona: BotPersona, query: string, limit: number): string[] {
  const queryTokens = semanticTokens(query);
  return persona.speech.messageExamples
    .map((example, index) => ({ example, index, score: relevanceScore(queryTokens, example) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ example }) => example);
}

function expandRelationWords(value: string): string {
  return value.replace(/дядю|дяди|дядя|uncle/giu, ' дядя uncle ')
    .replace(/т[её]тю|т[её]ти|т[её]тя|aunt/giu, ' тетя aunt ')
    .replace(/бабушку|бабушки|бабушка|grandmother/giu, ' бабушка grandmother ')
    .replace(/дедушку|дедушки|дедушка|grandfather/giu, ' дедушка grandfather ')
    .replace(/сестру|сестры|сестра|sister/giu, ' сестра sister ')
    .replace(/брата|брату|брат|brother/giu, ' брат brother ')
    .replace(/машину|машины|машина|автомобиль|car/giu, ' машина автомобиль car ');
}

function relationLabel(relation: BotPersona['family'][number]['relation']): string {
  return ({
    mother: 'мать', father: 'отец', brother: 'брат', sister: 'сестра', uncle: 'дядя', aunt: 'тётя',
    grandmother: 'бабушка', grandfather: 'дедушка', cousin: 'двоюродный родственник', daughter: 'дочь', son: 'сын', other: 'родственник',
  })[relation];
}

function formatLocation(location: { country: string; city: string }): string { return [location.city, location.country].filter(Boolean).join(', '); }

function selectRelevantRelationships(persona: BotPersona, query: string): BotPersona['relationships'] {
  const tokens = semanticTokens(query);
  return persona.relationships
    .map((relationship) => ({
      relationship,
      score: relevanceScore(tokens, `${relationship.targetPersonaId} ${relationship.notes.join(' ')}`),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.relationship.familiarity - left.relationship.familiarity)
    .slice(0, 3)
    .map(({ relationship }) => structuredClone(relationship));
}
