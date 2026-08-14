import { ChatMessage, StreamEvent } from '../stream-brain/types';
import { ageFromBirthDate } from './schema';
import { PersonaMemory, relevanceScore, semanticTokens } from './persona-memory';
import { PersonaRuntimeStore } from './persona-runtime-store';
import {
  BotPersona,
  PersonaConversationMessage,
  PersonaDisclosureLevel,
  PersonaFactCategory,
  PersonaMemoryItem,
  PersonaRelativeKind,
} from './types';

/**
 * This is the intentionally narrow context sent to the Live model. Administrative
 * profile fields stay on BotPersona and never cross this boundary.
 */
export interface RelevantCanonItem {
  kind: 'identity' | 'family-background' | 'relative' | 'fact' | 'timeline' | 'opinion';
  value: string;
}

export interface PersonaReactionContext {
  username: string;
  identity: {
    firstName: string;
    preferredName?: string;
    nickname?: string;
    /** A compact behavioral summary, not a raw biography record. */
    summary: string;
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
  streamerRelationship: Pick<BotPersona['streamerRelationship'], 'familiarity' | 'supportiveness' | 'teasingLevel' | 'favoriteStreamTypes' | 'recurringReferences'>;
  runtime: {
    mood: string;
    engagement: number;
    sessionMessageCount: number;
  };
  consistencyGuidance: string;
  personalResponseGuidance: string;
  accountClassificationQuestion: boolean;
  relevantCanon: RelevantCanonItem[];
  relevantMemories: Array<Pick<PersonaMemoryItem, 'type' | 'summary' | 'importance'>>;
  recentConversation: Array<Pick<PersonaConversationMessage, 'role' | 'message'>>;
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

type PersonalQuestionKind = 'name' | 'nickname-origin' | 'birthplace' | 'location' | 'occupation' | 'family' | 'relationship';

interface PersonalQuestion {
  kind: PersonalQuestionKind;
  relation?: PersonaRelativeKind;
}

interface CanonDocument {
  item: RelevantCanonItem;
  nameOnlyItem?: RelevantCanonItem;
  searchable: string;
  visibility: 'topical' | 'personal';
  questionKinds?: PersonalQuestionKind[];
  disclosureTopic?: keyof BotPersona['disclosure']['topics'];
  relation?: PersonaRelativeKind;
}

interface FactCategoryPolicy {
  visibility: CanonDocument['visibility'];
  questionKinds?: readonly PersonalQuestionKind[];
  disclosureTopic?: keyof BotPersona['disclosure']['topics'];
}

const FACT_CATEGORY_POLICIES: Record<PersonaFactCategory, FactCategoryPolicy> = {
  family: { visibility: 'personal', questionKinds: ['family'], disclosureTopic: 'family' },
  childhood: { visibility: 'personal', questionKinds: ['family'], disclosureTopic: 'family' },
  education: { visibility: 'personal', questionKinds: ['occupation'], disclosureTopic: 'work' },
  work: { visibility: 'personal', questionKinds: ['occupation'], disclosureTopic: 'work' },
  travel: { visibility: 'personal', questionKinds: ['location', 'birthplace'], disclosureTopic: 'location' },
  money: { visibility: 'personal', disclosureTopic: 'money' },
  relationships: { visibility: 'personal', questionKinds: ['relationship'], disclosureTopic: 'relationships' },
  story: { visibility: 'personal' },
  gaming: { visibility: 'topical' },
  food: { visibility: 'topical' },
  music: { visibility: 'topical' },
  technology: { visibility: 'topical' },
  automotive: { visibility: 'topical' },
  animals: { visibility: 'topical' },
  art: { visibility: 'topical' },
  biology: { visibility: 'topical' },
  law: { visibility: 'topical' },
  sport: { visibility: 'topical' },
  imperfection: { visibility: 'topical' },
  habit: { visibility: 'topical' },
  preference: { visibility: 'topical' },
  other: { visibility: 'topical' },
};

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
    const personalQuestion = classifyPersonalQuestion(topic, input.directMention, conversation);
    const accountClassificationQuestion = isAccountClassificationQuestion(topic);
    const canRevealQuestion = personalQuestion === undefined || disclosureAllows(input.persona, personalQuestion);
    const runtime = input.observeRuntime === false
      ? this.runtime.peek(input.persona.id)
      : this.runtime.observe(input.persona.id, input.event.type, input.event.importance);

    return {
      username: input.username,
      identity: modelIdentity(input.persona, input.event.timestamp),
      character: {
        summary: modelSafeText(input.persona.character.summary),
        traits: modelSafeTexts(input.persona.character.traits, 6),
        flaws: modelSafeTexts(input.persona.character.flaws, 4),
        humor: modelSafeText(input.persona.character.humor),
      },
      speech: {
        summary: `${input.persona.speech.averageMessageWords} слов в среднем; ${input.persona.speech.punctuationStyle}; ${input.persona.speech.capitalizationStyle}`,
        favoriteExpressions: modelSafeTexts(input.persona.speech.favoriteExpressions, 5),
        openingPatterns: modelSafeTexts(input.persona.speech.openingPatterns, 4),
        endingPatterns: modelSafeTexts(input.persona.speech.endingPatterns, 4),
        fillerWords: modelSafeTexts(input.persona.speech.fillerWords, 5),
        abbreviations: modelSafeTexts(input.persona.speech.abbreviations, 5),
        laughStyles: modelSafeTexts(input.persona.speech.laughStyles, 4),
        avoidedExpressions: modelSafeTexts(input.persona.speech.avoidedExpressions, 5),
        typoStyle: modelSafeTexts(input.persona.speech.typoStyle, 3),
        emojiPreferences: modelSafeTexts(input.persona.speech.emojiPreferences, 4),
        twitchEmotes: modelSafeTexts(input.persona.speech.twitchEmotes, 4),
        profanityLevel: input.persona.speech.profanityLevel,
        messageExamples: selectSpeechExamples(input.persona, topic, 5),
      },
      behavior: {
        styleInstructions: modelSafeText(input.persona.behavior.styleInstructions),
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
      streamerRelationship: {
        familiarity: input.persona.streamerRelationship.familiarity,
        supportiveness: input.persona.streamerRelationship.supportiveness,
        teasingLevel: input.persona.streamerRelationship.teasingLevel,
        favoriteStreamTypes: input.persona.streamerRelationship.favoriteStreamTypes.slice(0, 6),
        recurringReferences: input.persona.streamerRelationship.recurringReferences.slice(0, 4),
      },
      runtime: {
        mood: runtime.mood,
        engagement: runtime.engagement,
        sessionMessageCount: runtime.sessionMessageCount,
      },
      consistencyGuidance: 'Supplied stable identity facts stay consistent. Do not accept a conflicting chat claim as a replacement.',
      personalResponseGuidance: responseGuidance(personalQuestion, accountClassificationQuestion, canRevealQuestion),
      accountClassificationQuestion,
      relevantCanon: canRevealQuestion
        ? selectRelevantCanon(input.persona, topic, this.maxCanonItems, personalQuestion)
        : [],
      relevantMemories: memories.map(({ type, summary, importance }) => ({ type, summary, importance })),
      recentConversation: conversation.map(({ role, message }) => ({ role, message })),
      recentMessages: input.recentMessages.slice(-20),
      directMention: input.directMention,
    };
  }
}

/**
 * Detects questions about account classification without treating normal stream
 * discussion of AI products as a question about this account.
 */
export function isAccountClassificationQuestion(value: string): boolean {
  const normalized = value.toLowerCase();
  const hasClassificationTerm = /(?:бот(?:ы|ик)?|bot(?:s)?|нейронк[\p{L}\p{N}_]*|нейросет[\p{L}\p{N}_]*|искусственн[\p{L}\p{N}_]*\s+интеллект|(?<![\p{L}\p{N}_])ai(?![\p{L}\p{N}_])|chatgpt|(?<![\p{L}\p{N}_])gpt(?![\p{L}\p{N}_])|gemini)/iu.test(normalized);
  const addressesAccount = /(?:^|[^\p{L}\p{N}_])(?:ты|вы|это|этот|эта|аккаунт|account)(?=$|[^\p{L}\p{N}_])|are\s+you|is\s+this|@\w+/iu.test(normalized);
  const asks = /[?？]/u.test(normalized)
    || /(?:кто\s+ты|ты\s+ли|are\s+you|is\s+this|(?:^|[^\p{L}\p{N}_])(?:ты|вы|это|этот|эта)\s+(?:бот(?:ы|ик)?|нейронк[\p{L}\p{N}_]*|нейросет[\p{L}\p{N}_]*|искусственн[\p{L}\p{N}_]*\s+интеллект))(?=$|[^\p{L}\p{N}_])/iu.test(normalized);
  return hasClassificationTerm && addressesAccount && asks;
}

export function selectRelevantCanon(
  persona: BotPersona,
  query: string,
  limit = 6,
  personalQuestion?: PersonalQuestion,
): RelevantCanonItem[] {
  const documents = canonDocuments(persona);
  if (personalQuestion) {
    const nameOnlyRelationQuestion = personalQuestion.relation !== undefined && asksForPersonalName(query);
    return documents
      .filter((document) => document.questionKinds?.includes(personalQuestion.kind))
      .filter((document) => personalQuestion.relation === undefined || document.relation === personalQuestion.relation)
      .filter((document) => documentDisclosureAllows(persona, document))
      .slice(0, Math.max(1, Math.min(8, limit)))
      .map((document) => modelSafeCanonItem(nameOnlyRelationQuestion && document.nameOnlyItem ? document.nameOnlyItem : document.item));
  }

  const queryTokens = semanticTokens(expandRelationWords(query));
  return documents
    .filter((document) => document.visibility === 'topical')
    .map((document) => ({ document, score: relevanceScore(queryTokens, expandRelationWords(document.searchable)) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.document.item.value.localeCompare(right.document.item.value, 'ru'))
    .slice(0, Math.max(1, Math.min(8, limit)))
    .map(({ document }) => modelSafeCanonItem(document.item));
}

function modelIdentity(persona: BotPersona, timestamp: number): PersonaReactionContext['identity'] {
  const { identity, character, behavior, knowledge } = persona;
  const age = ageFromBirthDate(identity.birthDate, new Date(timestamp));
  const summary = [
    identity.preferredName
      ? `${identity.firstName}, предпочитает ${identity.preferredName}.`
      : `${identity.firstName}.`,
    age === undefined ? undefined : `${age} лет.`,
    identity.birthplace?.city || identity.currentLocation?.city
      ? `Родился в ${formatLocation(identity.birthplace) || 'неуказанном месте'}, сейчас живёт в ${formatLocation(identity.currentLocation) || 'неуказанном месте'}.`
      : undefined,
    identity.occupation ? `Работает: ${identity.occupation}.` : undefined,
    modelSafeText(character.summary),
    `Пишет ${activityLabel(behavior.activity.chatFrequency)}, ${modelSafeText(character.humor)}.`,
    knowledge.expertise.length ? `Хорошо знает: ${knowledge.expertise.slice(0, 3).join(', ')}.` : undefined,
  ].filter((part): part is string => Boolean(part)).join(' ');
  return {
    firstName: identity.firstName,
    ...(identity.preferredName ? { preferredName: identity.preferredName } : {}),
    ...(identity.nickname ? { nickname: identity.nickname } : {}),
    summary,
  };
}

function responseGuidance(
  question: PersonalQuestion | undefined,
  accountClassificationQuestion: boolean,
  canRevealQuestion: boolean,
): string {
  if (accountClassificationQuestion) {
    return 'This question seeks to classify the account. Silence is preferred; if replying, use a brief character-consistent non-factual deflection. Never claim to be human and never discuss hidden operation.';
  }
  if (question && !canRevealQuestion) {
    return 'The requested personal topic is private. Do not infer or reveal a fact; prefer a brief boundary or silence.';
  }
  if (question) {
    return 'This is a direct personal question. Use only the supplied relevant fact when it is natural; do not volunteer other background.';
  }
  return 'Background guides behavior and knowledge. Do not volunteer biographical facts without a direct, ongoing, or naturally relevant reason.';
}

function classifyPersonalQuestion(
  query: string,
  directMention: boolean,
  conversation: PersonaConversationMessage[],
): PersonalQuestion | undefined {
  const normalized = query.toLowerCase();
  const ongoingPersonalTopic = conversation.slice(-4).some((message) => /(?:как\s+(?:тебя\s+)?зовут|где\s+ты|жив[её]шь|работаешь|семь[яиюе]|родствен|ник\b|дяд|т[её]т|почему\s+ник)/iu.test(message.message));
  if (!directMention && !ongoingPersonalTopic) return undefined;

  const relation = relationFromQuery(normalized);
  if (relation || /(?:семь[яиюе]|родствен|родители|жена|муж|партн[её]р)/iu.test(normalized)) return { kind: relation ? 'family' : 'relationship', ...(relation ? { relation } : {}) };
  if (/(?:откуда|почему|как).*?(?:ник|nickname)|(?:ник|nickname).*?(?:откуда|почему)/iu.test(normalized)) return { kind: 'nickname-origin' };
  if (/(?:где\s+(?:ты\s+)?родил|место\s+рожд|откуда\s+родом)/iu.test(normalized)) return { kind: 'birthplace' };
  if (/(?:где\s+(?:ты\s+)?жив|где\s+сейчас|твой\s+город|откуда\s+ты)/iu.test(normalized)) return { kind: 'location' };
  if (/(?:кем\s+(?:ты\s+)?работ|где\s+(?:ты\s+)?работ|професси|чем\s+занимаешься)/iu.test(normalized)) return { kind: 'occupation' };
  if (/(?:как\s+(?:тебя\s+)?зовут|тво[её]\s+имя|\bимя\b|what'?s\s+your\s+name|your\s+name)/iu.test(normalized)) return { kind: 'name' };
  return undefined;
}

function asksForPersonalName(query: string): boolean {
  return /(?:как\s+(?:его|её|их|тебя)?\s*зовут|(?:его|её|их)\s+имя|what'?s\s+(?:his|her|their)\s+name)/iu.test(query);
}

function relationFromQuery(query: string): PersonaRelativeKind | undefined {
  const relations: Array<[PersonaRelativeKind, RegExp]> = [
    ['uncle', /(?:дяд|uncle)/iu], ['aunt', /(?:т[её]т|aunt)/iu],
    ['grandmother', /(?:бабуш|grandmother)/iu], ['grandfather', /(?:дедуш|grandfather)/iu],
    ['mother', /(?:мам|мать|mother)/iu], ['father', /(?:пап|отец|father)/iu],
    ['sister', /(?:сестр|sister)/iu], ['brother', /(?:брат|brother)/iu],
    ['daughter', /(?:доч|daughter)/iu], ['son', /(?:сын|son)/iu], ['cousin', /(?:двоюрод|cousin)/iu],
  ];
  return relations.find(([, pattern]) => pattern.test(query))?.[0];
}

function disclosureAllows(persona: BotPersona, question: PersonalQuestion): boolean {
  const disclosureTopics: Partial<Record<PersonalQuestionKind, keyof BotPersona['disclosure']['topics']>> = {
    birthplace: 'location', location: 'location', occupation: 'work', family: 'family', relationship: 'relationships',
  };
  const topic = disclosureTopics[question.kind];
  return topic === undefined || disclosureIsVisible(persona.disclosure.topics[topic]);
}

function disclosureIsVisible(level: PersonaDisclosureLevel): boolean { return level !== 'private'; }

function documentDisclosureAllows(persona: BotPersona, document: CanonDocument): boolean {
  return document.disclosureTopic === undefined
    || disclosureIsVisible(persona.disclosure.topics[document.disclosureTopic]);
}

function canonDocuments(persona: BotPersona): CanonDocument[] {
  const documents: CanonDocument[] = [];
  const push = (document: CanonDocument): void => { documents.push(document); };
  const { identity } = persona;

  push({
    item: { kind: 'identity', value: `Имя: ${identity.preferredName ?? identity.firstName}` },
    searchable: `имя как зовут ${identity.firstName} ${identity.preferredName ?? ''}`,
    visibility: 'personal', questionKinds: ['name'],
  });
  if (identity.nicknameOrigin) {
    push({
      item: { kind: 'identity', value: `История ника ${identity.nickname ?? ''}: ${identity.nicknameOrigin}` },
      searchable: `ник nickname откуда почему ${identity.nickname ?? ''} ${identity.nicknameOrigin}`,
      visibility: 'personal', questionKinds: ['nickname-origin'],
    });
  }
  if (identity.birthplace && (identity.birthplace.city || identity.birthplace.country)) {
    push({
      item: { kind: 'identity', value: `Родился в ${formatLocation(identity.birthplace)}.` },
      searchable: `родился место рождения откуда родом ${formatLocation(identity.birthplace)}`,
      visibility: 'personal', questionKinds: ['birthplace'], disclosureTopic: 'location',
    });
  }
  if (identity.currentLocation && (identity.currentLocation.city || identity.currentLocation.country)) {
    push({
      item: { kind: 'identity', value: `Сейчас живёт в ${formatLocation(identity.currentLocation)}.` },
      searchable: `где живет сейчас город ${formatLocation(identity.currentLocation)}`,
      visibility: 'personal', questionKinds: ['location'], disclosureTopic: 'location',
    });
  }
  if (identity.occupation) {
    push({
      item: { kind: 'identity', value: `Работает: ${identity.occupation}.` },
      searchable: `работа кем работает профессия занятие ${identity.occupation}`,
      visibility: 'personal', questionKinds: ['occupation'], disclosureTopic: 'work',
    });
  }
  if (persona.familyBackground) {
    push({
      item: { kind: 'family-background', value: persona.familyBackground },
      searchable: `семья детство родители родственники ${persona.familyBackground}`,
      visibility: 'personal', questionKinds: ['family'], disclosureTopic: 'family',
    });
  }
  for (const relative of persona.family) {
    push({
      item: {
        kind: 'relative',
        value: `${relationLabel(relative.relation)}: ${relative.name}${relative.occupation ? `, ${relative.occupation}` : ''}${relative.city ? `, ${relative.city}` : ''}${relative.relationshipDescription ? `. ${relative.relationshipDescription}` : ''}${relative.facts.length ? `. ${relative.facts.join('; ')}` : ''}`,
      },
      nameOnlyItem: { kind: 'relative', value: `${relationLabel(relative.relation)}: ${relative.name}` },
      searchable: `${relative.relation} ${relationLabel(relative.relation)} ${relative.name} ${relative.occupation ?? ''} ${relative.city ?? ''} ${relative.facts.join(' ')}`,
      visibility: 'personal', questionKinds: ['family'], disclosureTopic: 'family', relation: relative.relation,
    });
  }
  for (const fact of persona.facts) {
    if (fact.privateByDefault) continue;
    const policy = FACT_CATEGORY_POLICIES[fact.category];
    push({
      item: { kind: 'fact', value: fact.fact },
      searchable: `${fact.category} ${fact.tags.join(' ')} ${fact.fact}`,
      visibility: policy.visibility,
      ...(policy.questionKinds ? { questionKinds: [...policy.questionKinds] } : {}),
      ...(policy.disclosureTopic ? { disclosureTopic: policy.disclosureTopic } : {}),
    });
  }
  for (const lifeEvent of persona.timeline) {
    push({
      item: { kind: 'timeline', value: `${lifeEvent.year ?? 'год не указан'} — ${lifeEvent.title}: ${lifeEvent.description}` },
      searchable: `${lifeEvent.title} ${lifeEvent.description} ${lifeEvent.tags.join(' ')}`,
      visibility: 'personal', questionKinds: ['family', 'relationship'], disclosureTopic: 'family',
    });
  }
  for (const opinion of persona.opinions) {
    push({
      item: { kind: 'opinion', value: `${opinion.topic}: ${opinion.stance}` },
      searchable: `${opinion.topic} ${opinion.stance} ${opinion.reasoning ?? ''} ${opinion.tags.join(' ')}`,
      visibility: 'topical',
    });
  }
  return documents;
}

function selectSpeechExamples(persona: BotPersona, query: string, limit: number): string[] {
  const queryTokens = semanticTokens(query);
  return persona.speech.messageExamples
    .map((example, index) => ({ example, index, score: relevanceScore(queryTokens, example) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ example }) => modelSafeText(example))
    .filter(Boolean);
}

function expandRelationWords(value: string): string {
  return value.replace(/дядю|дяди|дядя|uncle/giu, ' дядя uncle ')
    .replace(/т[её]тю|т[её]ти|т[её]тя|aunt/giu, ' тётя aunt ')
    .replace(/бабушку|бабушки|бабушка|grandmother/giu, ' бабушка grandmother ')
    .replace(/дедушку|дедушки|дедушка|grandfather/giu, ' дедушка grandfather ')
    .replace(/сестру|сестры|сестра|sister/giu, ' сестра sister ')
    .replace(/брата|брату|брат|brother/giu, ' брат brother ')
    .replace(/машину|машины|машина|автомобиль|car/giu, ' машина автомобиль car ');
}

function relationLabel(relation: PersonaRelativeKind): string {
  return ({
    mother: 'мать', father: 'отец', brother: 'брат', sister: 'сестра', uncle: 'дядя', aunt: 'тётя',
    grandmother: 'бабушка', grandfather: 'дедушка', cousin: 'двоюродный родственник', daughter: 'дочь', son: 'сын', other: 'родственник',
  })[relation];
}

function formatLocation(location: { country: string; city: string } | undefined): string {
  return location ? [location.city, location.country].filter(Boolean).join(', ') : '';
}

function activityLabel(frequency: BotPersona['behavior']['activity']['chatFrequency']): string {
  return ({ 'very-low': 'очень редко', low: 'редко', medium: 'умеренно часто', high: 'часто' })[frequency];
}

/** Strips profile-authoring labels from model-facing data without censoring chat topics. */
function modelSafeText(value: string): string {
  return value
    .replace(/(?<![\p{L}\p{N}_])fictional(?![\p{L}\p{N}_])/giu, '')
    .replace(/(?<![\p{L}\p{N}_])вымышленн\p{L}*(?![\p{L}\p{N}_])/giu, '')
    .replace(/(?<![\p{L}\p{N}_])generated\s+(?:persona|profile)(?![\p{L}\p{N}_])/giu, '')
    .replace(/(?<![\p{L}\p{N}_])сгенерированн\p{L}*\s+(?:персон\p{L}*|профил\p{L}*)(?![\p{L}\p{N}_])/giu, '')
    .replace(/(?:ai\s+persona|bot\s+personality|synthetic\s+viewer|simulation)/giu, '')
    .replace(/(?:как\s+искусственный\s+интеллект|as\s+an\s+artificial\s+intelligence)/giu, '')
    .replace(/(?:personaid|manualoverrides|generationversion|generatedfromusername)/giu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

function modelSafeTexts(values: string[], limit: number): string[] {
  return values.map((value) => modelSafeText(value)).filter(Boolean).slice(0, limit);
}

function modelSafeCanonItem(item: RelevantCanonItem): RelevantCanonItem {
  return { ...item, value: modelSafeText(item.value) };
}
