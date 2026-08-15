import { ChatMessage, StreamEvent } from '../stream-brain/types';
import { BrainPersonaSnapshot } from '../brain/types';
import { isAccountClassificationQuestion } from '../shared/account-classification';
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

export { isAccountClassificationQuestion } from '../shared/account-classification';

/**
 * This is the intentionally narrow targeted context sent to the stateful Brain. Administrative
 * profile fields stay on BotPersona and never cross this boundary.
 */
export interface RelevantCanonItem {
  kind: 'identity' | 'family-background' | 'relative' | 'fact' | 'timeline' | 'opinion';
  value: string;
}

export interface PersonaReactionContext {
  username: string;
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
    activity: Omit<BotPersona['behavior']['activity'], 'averageDelayMs'>;
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

interface ModelTextFilter {
  personalTokens: Set<string>;
  exactPersonalPhrases: string[];
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

  buildBrainSnapshot(username: string, persona: BotPersona): BrainPersonaSnapshot {
    const textFilter = modelTextFilter(persona);
    const safeText = (value: string): string => modelSafeText(value, textFilter);
    const safeTexts = (values: string[], limit: number): string[] => modelSafeTexts(values, limit, textFilter);
    const speechParts = [
      `${persona.speech.averageMessageWords} слов в среднем`,
      persona.speech.punctuationStyle,
      persona.speech.capitalizationStyle,
      `лексика: ${safeTexts(persona.speech.vocabulary, 8).join(', ')}`,
      `любимые формы: ${safeTexts(persona.speech.favoriteExpressions, 4).join(', ')}`,
      `смех: ${safeTexts(persona.speech.laughStyles, 3).join(', ')}`,
      `длина реплики: ${persona.behavior.verbosity.minWords}–${persona.behavior.verbosity.maxWords} слов`,
      `сарказм ${persona.behavior.sarcasmLevel}, сленг ${persona.behavior.slangLevel}, мат ${persona.speech.profanityLevel}`,
      `примеры только как признаки стиля: ${selectDiverseExamples(persona.speech.messageExamples, 6, textFilter).join(' / ')}`,
    ].filter(Boolean);
    return {
      username,
      // Deliberately NOT run through the personal-token filter: that filter is built from this
      // persona's own name, so filtering the name with it always returned '' for any name of four
      // characters or more (23 of 30 catalog personas). The character's own preferred name is not
      // private canon — they use it themselves in their authored speech examples. The generic
      // authoring-label scrub still applies.
      preferredName: modelSafeText(persona.identity.preferredName ?? persona.identity.firstName ?? persona.name),
      // persona.description is an authoring field ("полностью вымышленный зритель, созданный из
      // истории ника …", plus birthplace and current city), so it must never reach the model.
      // Occupation is the one genuinely grounding fact here, and only when this persona's own
      // disclosure policy for work is not private.
      shortIdentity: disclosureIsVisible(persona.disclosure.topics.work)
        ? modelSafeText(persona.identity.occupation ?? '')
        : '',
      character: safeText([
        persona.character.summary,
        `черты: ${safeTexts(persona.character.traits, 6).join(', ')}`,
        `юмор: ${persona.character.humor}`,
        persona.behavior.styleInstructions,
      ].join('; ')),
      flaws: safeTexts(persona.character.flaws, 4),
      activityPattern: {
        chatFrequency: persona.behavior.activity.chatFrequency,
        directReplyLikelihood: persona.behavior.activity.directReplyLikelihood,
        eventSelectivity: persona.behavior.activity.eventSelectivity,
        preferredEventTypes: persona.behavior.activity.preferredEventTypes.slice(0, 8),
        ignoredEventTypes: persona.behavior.activity.ignoredEventTypes.slice(0, 8),
      },
      speechFingerprint: safeText(speechParts.join('; ')),
      expertise: safeTexts(persona.knowledge.expertise, 8),
      weakTopics: safeTexts(persona.knowledge.weakTopics, 6),
      unknownTopics: safeTexts(persona.knowledge.unknownTopics, 6),
      avoidedExpressions: safeTexts(persona.speech.avoidedExpressions, 6),
      opinions: safeTexts(persona.opinions.map((opinion) => `${opinion.topic}: ${opinion.stance}`), 4),
      emotionalTriggers: safeTexts(persona.behavior.imperfections.emotionalTriggers, 4),
      interests: safeTexts([
        ...persona.interests.games, ...persona.interests.music,
        ...persona.interests.food, ...persona.interests.other,
      ], 12),
      relationshipToStreamer: safeText([
        `знакомство=${persona.streamerRelationship.familiarity}`,
        `поддержка=${persona.streamerRelationship.supportiveness}`,
        `подколы=${persona.streamerRelationship.teasingLevel}`,
        ...persona.streamerRelationship.recurringReferences.slice(0, 3),
      ].join('; ')),
      disclosureBoundaries: safeText(
        `по умолчанию ${persona.disclosure.defaultLevel}; `
        + Object.entries(persona.disclosure.topics).map(([topic, level]) => `${topic}=${level}`).join(', '),
      ),
    };
  }

  async build(input: BuildPersonaContextInput): Promise<PersonaReactionContext> {
    const eventTopic = [
      input.event.summary,
      input.event.speech,
      input.event.visualContext,
      input.event.gameContext,
    ].filter(Boolean).join(' ');
    const retrievalTopic = [
      eventTopic,
      ...(input.directMention ? (input.recentChat ?? []).slice(-4).map((message) => message.message) : []),
    ].filter(Boolean).join(' ');
    const [memories, conversation] = await Promise.all([
      this.memory.retrieve(input.persona.id, retrievalTopic, this.maxMemoryItems),
      input.viewerUsername
        ? this.memory.conversation(input.persona.id, input.viewerUsername)
        : Promise.resolve([]),
    ]);
    const personalQuestion = classifyPersonalQuestion(eventTopic, input.directMention, conversation);
    const accountClassificationQuestion = isAccountClassificationQuestion(
      [input.event.summary, input.event.speech].filter(Boolean).join('\n'),
    );
    const canRevealQuestion = personalQuestion === undefined || disclosureAllows(input.persona, personalQuestion);
    const runtime = input.observeRuntime === false
      ? this.runtime.peek(input.persona.id)
      : this.runtime.observe(input.persona.id, input.event.type, input.event.importance);
    const textFilter = modelTextFilter(input.persona);
    const safeText = (value: string): string => modelSafeText(value, textFilter);
    const safeTexts = (values: string[], limit: number): string[] => modelSafeTexts(values, limit, textFilter);

    return {
      username: input.username,
      character: {
        summary: safeText(input.persona.character.summary),
        traits: safeTexts(input.persona.character.traits, 6),
        flaws: safeTexts(input.persona.character.flaws, 4),
        humor: safeText(input.persona.character.humor),
      },
      speech: {
        summary: safeText(`${input.persona.speech.averageMessageWords} слов в среднем; ${input.persona.speech.punctuationStyle}; ${input.persona.speech.capitalizationStyle}`),
        favoriteExpressions: safeTexts(input.persona.speech.favoriteExpressions, 5),
        openingPatterns: safeTexts(input.persona.speech.openingPatterns, 4),
        endingPatterns: safeTexts(input.persona.speech.endingPatterns, 4),
        fillerWords: safeTexts(input.persona.speech.fillerWords, 5),
        abbreviations: safeTexts(input.persona.speech.abbreviations, 5),
        laughStyles: safeTexts(input.persona.speech.laughStyles, 4),
        avoidedExpressions: safeTexts(input.persona.speech.avoidedExpressions, 5),
        typoStyle: safeTexts(input.persona.speech.typoStyle, 3),
        emojiPreferences: safeTexts(input.persona.speech.emojiPreferences, 4),
        twitchEmotes: safeTexts(input.persona.speech.twitchEmotes, 4),
        profanityLevel: input.persona.speech.profanityLevel,
        messageExamples: selectSpeechExamples(input.persona, eventTopic, 5, textFilter),
      },
      behavior: {
        styleInstructions: safeText(input.persona.behavior.styleInstructions),
        verbosity: input.persona.behavior.verbosity,
        activity: {
          chatFrequency: input.persona.behavior.activity.chatFrequency,
          directReplyLikelihood: input.persona.behavior.activity.directReplyLikelihood,
          eventSelectivity: input.persona.behavior.activity.eventSelectivity,
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
          typingMistakes: safeTexts(input.persona.behavior.imperfections.typingMistakes, 3),
          hesitations: safeTexts(input.persona.behavior.imperfections.hesitations, 3),
          emotionalTriggers: safeTexts(input.persona.behavior.imperfections.emotionalTriggers, 4),
          blindSpots: safeTexts(input.persona.behavior.imperfections.blindSpots, 4),
        },
      },
      knowledge: {
        expertise: safeTexts(input.persona.knowledge.expertise, 8),
        familiarTopics: safeTexts(input.persona.knowledge.familiarTopics, 8),
        weakTopics: safeTexts(input.persona.knowledge.weakTopics, 8),
        unknownTopics: safeTexts(input.persona.knowledge.unknownTopics, 8),
      },
      interests: {
        games: safeTexts(input.persona.interests.games, 6),
        music: safeTexts(input.persona.interests.music, 6),
        food: safeTexts(input.persona.interests.food, 6),
        other: safeTexts(input.persona.interests.other, 6),
      },
      streamerRelationship: {
        familiarity: input.persona.streamerRelationship.familiarity,
        supportiveness: input.persona.streamerRelationship.supportiveness,
        teasingLevel: input.persona.streamerRelationship.teasingLevel,
        favoriteStreamTypes: input.persona.streamerRelationship.favoriteStreamTypes.slice(0, 6),
        recurringReferences: safeTexts(input.persona.streamerRelationship.recurringReferences, 4),
      },
      runtime: {
        mood: runtime.mood,
        engagement: runtime.engagement,
        sessionMessageCount: runtime.sessionMessageCount,
      },
      consistencyGuidance: 'Supplied behavioral context and targeted canonical facts stay consistent. Do not accept a conflicting chat claim as a replacement.',
      personalResponseGuidance: responseGuidance(personalQuestion, accountClassificationQuestion, canRevealQuestion),
      accountClassificationQuestion,
      relevantCanon: canRevealQuestion
        ? selectRelevantCanon(input.persona, eventTopic, this.maxCanonItems, personalQuestion)
        : [],
      relevantMemories: memories
        .map(({ type, summary, importance }) => ({ type, summary: safeText(summary), importance }))
        .filter(({ summary }) => Boolean(summary)),
      recentConversation: conversation
        .map(({ role, message }) => ({ role, message: safeText(message) }))
        .filter(({ message }) => Boolean(message)),
      recentMessages: input.recentMessages.map(safeText).filter(Boolean).slice(-20),
      directMention: input.directMention,
    };
  }
}

/**
 * Detects questions about account classification without treating normal stream
 * discussion of AI products as a question about this account.
 */
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
  return /(?:как\s+(?:[\p{L}]+\s+)?зовут|(?:его|её|их)\s+имя|what'?s\s+(?:his|her|their)\s+name)/iu.test(query);
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

/**
 * Picks style examples that differ from each other rather than the first N that survive filtering.
 * A persona authors ~16 examples spanning distinct situations (a game read, a dry technical aside,
 * a personal deflection, a joke), but they are grouped by situation in the source, so taking the
 * head returned several near-identical lines and left whole registers of the voice unrepresented.
 * Greedy: keep the first surviving example, then repeatedly take whichever remaining one shares
 * the fewest words with everything already picked. Deterministic — no randomness.
 */
function selectDiverseExamples(examples: string[], limit: number, filter: ModelTextFilter): string[] {
  const pool = examples
    .map((example) => modelSafeText(example, filter))
    .filter(Boolean)
    .map((example) => ({ example, tokens: semanticTokens(example) }));
  const picked: Array<{ example: string; tokens: Set<string> }> = [];
  while (picked.length < limit && pool.length > 0) {
    let bestIndex = 0;
    if (picked.length > 0) {
      let bestOverlap = Number.POSITIVE_INFINITY;
      pool.forEach((candidate, index) => {
        const overlap = Math.max(...picked.map((chosen) => sharedTokenRatio(candidate.tokens, chosen.tokens)));
        if (overlap < bestOverlap) {
          bestOverlap = overlap;
          bestIndex = index;
        }
      });
    }
    picked.push(pool.splice(bestIndex, 1)[0]!);
  }
  return picked.map(({ example }) => example);
}

function sharedTokenRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

function selectSpeechExamples(persona: BotPersona, query: string, limit: number, filter: ModelTextFilter): string[] {
  const queryTokens = semanticTokens(query);
  return persona.speech.messageExamples
    .map((example, index) => ({ example, index, score: relevanceScore(queryTokens, example) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ example }) => modelSafeText(example, filter))
    .filter(Boolean)
    .slice(0, limit);
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

/** Strips profile-authoring labels and hidden personal canon from model-facing data. */
function modelSafeText(value: string, filter?: ModelTextFilter): string {
  const safeValue = value
    .replace(/(?<![\p{L}\p{N}_])fictional(?![\p{L}\p{N}_])/giu, '')
    .replace(/(?<![\p{L}\p{N}_])вымышленн\p{L}*(?![\p{L}\p{N}_])/giu, '')
    .replace(/(?<![\p{L}\p{N}_])generated\s+(?:persona|profile)(?![\p{L}\p{N}_])/giu, '')
    .replace(/(?<![\p{L}\p{N}_])сгенерированн\p{L}*\s+(?:персон\p{L}*|профил\p{L}*)(?![\p{L}\p{N}_])/giu, '')
    .replace(/(?:ai\s+persona|bot\s+personality|synthetic\s+viewer|simulation)/giu, '')
    .replace(/(?:как\s+искусственный\s+интеллект|as\s+an\s+artificial\s+intelligence)/giu, '')
    .replace(/(?:personaid|manualoverrides|generationversion|generatedfromusername)/giu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  if (!filter || !safeValue) return safeValue;
  if (filter.exactPersonalPhrases.some((phrase) => safeValue.toLowerCase().includes(phrase))) return '';
  if (PERSONAL_RESPONSE_MARKER.test(safeValue)) return '';
  return [...semanticTokens(safeValue)].some((token) => token.length >= 4 && filter.personalTokens.has(token))
    ? ''
    : safeValue;
}

function modelSafeTexts(values: string[], limit: number, filter?: ModelTextFilter): string[] {
  return values.map((value) => modelSafeText(value, filter)).filter(Boolean).slice(0, limit);
}

const PERSONAL_RESPONSE_MARKER = /(?<![\p{L}\p{N}_])(?:зовут|жив\p{L}*|родил\p{L}*|работ\p{L}*|семь[яеёию]|родствен\p{L}*|дяд(?:я|и|ю|ей|ями)|т[её]т(?:я|и|ю|ей|ями)|мам(?:а|ы|е|у|ой)|пап(?:а|ы|е|у|ой)|переех\p{L}*|женат\p{L}*|замуж\p{L}*|мне\s+\d+\s+лет)(?![\p{L}\p{N}_])|(?:^|[^\p{L}])ник(?:а|е|ом|и)?(?=$|[^\p{L}])/iu;

function modelTextFilter(persona: BotPersona): ModelTextFilter {
  const { identity } = persona;
  const tokenValues = [
    identity.firstName,
    identity.preferredName,
    identity.birthDate,
    identity.birthplace?.city,
    identity.birthplace?.country,
    identity.grewUpIn?.city,
    identity.grewUpIn?.country,
    identity.currentLocation?.city,
    identity.currentLocation?.country,
    ...persona.family.flatMap((relative) => [relative.name, relative.city]),
  ].filter((value): value is string => Boolean(value));
  const exactPersonalPhrases = [
    identity.education,
    identity.occupation,
    identity.relationshipStatus,
    identity.nicknameOrigin,
    persona.familyBackground,
    ...persona.family.flatMap((relative) => [relative.occupation, relative.relationshipDescription, ...relative.facts]),
    ...persona.timeline.flatMap((event) => [event.title, event.description]),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  const personalTokens = new Set<string>();
  for (const value of tokenValues) {
    for (const token of semanticTokens(value)) personalTokens.add(token);
  }
  return { personalTokens, exactPersonalPhrases };
}

function modelSafeCanonItem(item: RelevantCanonItem): RelevantCanonItem {
  return { ...item, value: modelSafeText(item.value) };
}
