import { ageFromBirthDate, personaCompleteness } from './schema';
import {
  PERSONA_BLUEPRINTS,
  PRODUCTION_PERSONA_IDENTITY_CHANGES,
  productionPersonaGender,
} from './generator-v3-data';
import {
  BotPersona,
  PersonaAuditReport,
  PersonaSimilarityPair,
  PersonaSummary,
  PersonaValidationIssue,
} from './types';

export interface AuditedPersona {
  username?: string;
  persona: BotPersona;
}

interface SimilarityDimension {
  name: string;
  label: string;
  weight: number;
  score: number;
}

export function validatePersonaCoherence(persona: BotPersona, now = new Date()): PersonaValidationIssue[] {
  const issues: PersonaValidationIssue[] = [];
  const birthYear = Number(persona.identity.birthDate?.slice(0, 4));
  const age = ageFromBirthDate(persona.identity.birthDate, now);
  const add = (code: string, severity: PersonaValidationIssue['severity'], path: string, message: string) =>
    issues.push({ code, severity, path, message });

  if (!Number.isInteger(birthYear) || age === undefined) {
    add('invalid_birth_date', 'error', 'identity.birthDate', 'Дата рождения отсутствует или некорректна.');
  } else {
    for (const [index, event] of persona.timeline.entries()) {
      if (event.year !== undefined && event.year < birthYear) {
        add('timeline_before_birth', 'error', `timeline.${index}.year`, `Событие «${event.title}» указано раньше рождения.`);
      }
      if (event.year !== undefined && event.year > now.getUTCFullYear() + 1) {
        add('timeline_in_future', 'error', `timeline.${index}.year`, `Событие «${event.title}» находится в невозможном будущем.`);
      }
      const eventAge = event.year === undefined ? undefined : event.year - birthYear;
      const studyEvent = /университет|вуз|бакалавр|институт|колледж/iu.test(`${event.title} ${event.description}`);
      const workEvent = /первая работа|начал.*работ|карьер|устроил[ась]*|трудоустро/iu.test(`${event.title} ${event.description}`);
      if (eventAge !== undefined && ((studyEvent && eventAge < 16) || (workEvent && eventAge < 14))) {
        add('timeline_impossible_age', 'error', `timeline.${index}.year`, `Возраст ${eventAge} лет не согласуется с учёбой или работой в событии «${event.title}».`);
      }
    }

    const experienceText = [persona.description, persona.identity.occupation, persona.identity.education,
      ...persona.timeline.flatMap((event) => [event.title, event.description]), ...persona.facts.map((fact) => fact.fact)].join(' ');
    for (const match of experienceText.matchAll(/(\d{1,2})\s*(?:лет|года|год)\s+(?:опыта|стажа)/giu)) {
      const years = Number(match[1]);
      if (years > Math.max(0, age - 14)) {
        add('impossible_experience', 'error', 'timeline', `Стаж ${years} лет невозможен для возраста ${age} лет.`);
      }
    }

    const nicknameCanon = `${persona.identity.nicknameOrigin ?? ''} ${persona.timeline
      .filter((event) => event.tags.some((tag) => /ник/iu.test(tag)))
      .map((event) => `${event.year ?? ''} ${event.title} ${event.description}`).join(' ')}`;
    if (birthYear > 2007 && /(?:counter[- ]?strike|cs|кс)\s*1[.,]6/iu.test(nicknameCanon)
      && !persona.timeline.some((event) => event.year !== undefined && event.year - birthYear >= 7 && /(?:counter[- ]?strike|cs|кс)\s*1[.,]6/iu.test(`${event.title} ${event.description}`))) {
      add('nickname_era_unproven', 'error', 'identity.nicknameOrigin', 'История ника из эпохи CS 1.6 не подтверждена датированным событием подходящего возраста.');
    }
  }

  if (!persona.identity.nicknameOrigin?.trim()) add('missing_nickname_origin', 'error', 'identity.nicknameOrigin', 'Для сгенерированной личности нужна история ника.');
  if (persona.source === 'generated' && persona.generatedFromUsername !== persona.identity.nickname?.toLowerCase()) {
    add('username_canon_mismatch', 'error', 'generatedFromUsername', 'Username генерации не совпадает с каноническим Twitch nickname.');
  }
  if (persona.familyBackground.toLowerCase().includes('единственн')
    && persona.family.some((relative) => relative.relation === 'brother' || relative.relation === 'sister')) {
    add('only_child_has_sibling', 'error', 'family', 'В familyBackground указан единственный ребёнок, но в семье есть брат или сестра.');
  }
  if (persona.behavior.verbosity.minWords > persona.behavior.verbosity.maxWords) {
    add('invalid_verbosity_range', 'error', 'behavior.verbosity', 'Минимальная длина сообщения больше максимальной.');
  }
  if (persona.speech.messageExamples.length < 15) {
    add('few_speech_examples', 'warning', 'speech.messageExamples', 'Нужно не меньше 15 синтетических примеров речи.');
  }
  if (persona.family.length < 3) add('thin_family', 'warning', 'family', 'Семейный контекст содержит меньше трёх значимых связей.');
  if (persona.timeline.length < 5) add('thin_timeline', 'warning', 'timeline', 'Биографическая линия содержит меньше пяти событий.');
  if (persona.opinions.length < 5) add('few_opinions', 'warning', 'opinions', 'Устойчивых мнений меньше пяти.');
  if (persona.facts.length < 6) add('few_facts', 'warning', 'facts', 'Канонических фактов меньше шести.');
  return issues;
}

export function personaSimilarity(left: BotPersona, right: BotPersona): { similarity: number; reasons: string[] } {
  const dimensions: SimilarityDimension[] = [
    tokenDimension('character', 'похожий характер/юмор', 0.17, [left.character.summary, ...left.character.traits, ...left.character.flaws, left.character.humor], [right.character.summary, ...right.character.traits, ...right.character.flaws, right.character.humor]),
    numericDimension('behavior', 'похожая активность и реактивность', 0.16, [left.behavior.reactionProbability, left.behavior.sarcasmLevel, left.behavior.questionProbability, left.behavior.activity.eventSelectivity], [right.behavior.reactionProbability, right.behavior.sarcasmLevel, right.behavior.questionProbability, right.behavior.activity.eventSelectivity]),
    tokenDimension('speech', 'похожий словарь и стиль речи', 0.22, [...left.speech.openingPatterns, ...left.speech.endingPatterns, ...left.speech.favoriteExpressions, ...left.speech.laughStyles, left.speech.punctuationStyle, left.speech.capitalizationStyle], [...right.speech.openingPatterns, ...right.speech.endingPatterns, ...right.speech.favoriteExpressions, ...right.speech.laughStyles, right.speech.punctuationStyle, right.speech.capitalizationStyle], lengthSimilarity(left.speech.averageMessageWords, right.speech.averageMessageWords, 20)),
    tokenDimension('knowledge', 'одинаковые границы знаний', 0.15, [...left.knowledge.expertise, ...left.knowledge.weakTopics, ...left.knowledge.unknownTopics], [...right.knowledge.expertise, ...right.knowledge.weakTopics, ...right.knowledge.unknownTopics]),
    tokenDimension('interests', 'сильно пересекающиеся интересы', 0.11, [...left.interests.games, ...left.interests.music, ...left.interests.other], [...right.interests.games, ...right.interests.music, ...right.interests.other]),
    tokenDimension('opinions', 'похожие устойчивые мнения', 0.07, left.opinions.map((opinion) => `${opinion.topic} ${opinion.stance}`), right.opinions.map((opinion) => `${opinion.topic} ${opinion.stance}`)),
    mixedActivityDimension(left, right),
    tokenDimension('twitch', 'похожее отношение к Twitch', 0.04, left.streamerRelationship.favoriteStreamTypes, right.streamerRelationship.favoriteStreamTypes),
  ];
  const similarity = round(dimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0), 4);
  return {
    similarity,
    reasons: dimensions.filter((dimension) => dimension.score >= 0.52).sort((a, b) => b.score - a.score).slice(0, 4).map((dimension) => dimension.label),
  };
}

export function auditPersonas(entries: AuditedPersona[]): PersonaAuditReport {
  const pairs = buildSimilarityPairs(entries);
  const issues = entries.flatMap(({ persona }) => validatePersonaCoherence(persona));
  const similarities = pairs.map((pair) => pair.similarity);
  const genderCounts = entries.reduce((distribution, entry) => {
    const gender = productionPersonaGender(entry.username);
    if (gender) distribution[gender] += 1;
    return distribution;
  }, { male: 0, female: 0 });
  const classifiedGenderCount = genderCounts.male + genderCounts.female;
  const genderDistribution = {
    ...genderCounts,
    malePercentage: percentage(genderCounts.male, classifiedGenderCount),
    femalePercentage: percentage(genderCounts.female, classifiedGenderCount),
    femaleUsernames: [...new Set(entries.flatMap((entry) =>
      productionPersonaGender(entry.username) === 'female' && entry.username ? [entry.username] : []))],
  };
  return {
    accountCount: entries.filter((entry) => entry.username).length,
    personaCount: entries.length,
    uniquePersonaCount: new Set(entries.map((entry) => entry.persona.id)).size,
    uniqueSpeechFingerprintCount: new Set(entries.map(({ persona }) => speechFingerprint(persona))).size,
    genderDistribution,
    identityChanges: auditIdentityChanges(entries),
    countryOfBirthDistribution: distribution(entries, ({ persona }) => persona.identity.birthplace?.country),
    currentCountryDistribution: distribution(entries, ({ persona }) => persona.identity.currentLocation?.country),
    currentCityDistribution: distribution(entries, ({ persona }) => persona.identity.currentLocation?.city),
    occupationDistribution: distribution(entries, ({ persona }) => persona.identity.occupation),
    behaviorRanges: {
      reactionProbability: range(entries.map(({ persona }) => persona.behavior.reactionProbability)),
      eventSelectivity: range(entries.map(({ persona }) => persona.behavior.activity.eventSelectivity)),
      directReplyLikelihood: range(entries.map(({ persona }) => persona.behavior.activity.directReplyLikelihood)),
      sarcasmLevel: range(entries.map(({ persona }) => persona.behavior.sarcasmLevel)),
    },
    structureRanges: {
      relatives: range(entries.map(({ persona }) => persona.family.length)),
      timelineEvents: range(entries.map(({ persona }) => persona.timeline.length)),
      facts: range(entries.map(({ persona }) => persona.facts.length)),
      opinions: range(entries.map(({ persona }) => persona.opinions.length)),
      speechExamples: range(entries.map(({ persona }) => persona.speech.messageExamples.length)),
      twitchContextItems: range(entries.map(({ persona }) => persona.streamerRelationship.favoriteStreamTypes.length
        + persona.streamerRelationship.recurringReferences.length
        + persona.streamerRelationship.rememberedStreamerMoments.length
        + (persona.streamerRelationship.firstSeen ? 1 : 0))),
    },
    maximumSimilarity: similarities[0] ?? 0,
    averageSimilarity: similarities.length ? round(similarities.reduce((sum, value) => sum + value, 0) / similarities.length, 4) : 0,
    mostSimilarPairs: pairs.slice(0, 10),
    coherenceErrors: issues.filter((issue) => issue.severity === 'error'),
    coherenceWarnings: issues.filter((issue) => issue.severity === 'warning'),
    duplicateNicknameOrigins: duplicates(entries.map(({ persona }) => persona.identity.nicknameOrigin ?? '')),
    duplicateRelativeNames: duplicates(entries.flatMap(({ persona }) => persona.family.map((relative) => relative.name))),
    duplicateFavoriteExpressions: duplicates(entries.flatMap(({ persona }) => persona.speech.favoriteExpressions)),
    duplicateBiographyEvents: duplicates(entries.flatMap(({ persona }) => persona.timeline.map((event) => event.description))),
    duplicateSpeechExamples: duplicates(entries.flatMap(({ persona }) => persona.speech.messageExamples)),
  };
}

function auditIdentityChanges(entries: AuditedPersona[]): PersonaAuditReport['identityChanges'] {
  const personaByUsername = new Map(entries.flatMap((entry) => entry.username ? [[entry.username, entry.persona] as const] : []));
  return PRODUCTION_PERSONA_IDENTITY_CHANGES.map((expected) => {
    const observed = personaByUsername.get(expected.username);
    const blueprint = PERSONA_BLUEPRINTS[expected.username];
    const blueprintMatches = blueprint?.firstName === expected.firstName
      && blueprint.preferredName === expected.preferredName
      && blueprint.lastName === expected.lastName;
    if (!observed) return { username: expected.username, canonicalName: expected.canonicalName, status: 'missing' };
    const observedIdentity = {
      firstName: observed.identity.firstName,
      ...(observed.identity.preferredName ? { preferredName: observed.identity.preferredName } : {}),
    };
    return {
      username: expected.username,
      canonicalName: expected.canonicalName,
      status: blueprintMatches
        && observed.identity.firstName === expected.firstName
        && observed.identity.preferredName === expected.preferredName
        ? 'matched'
        : 'diverged',
      observed: observedIdentity,
    };
  });
}

export function auditedPersonaSummaries(entries: AuditedPersona[], base: (persona: BotPersona) => PersonaSummary): PersonaSummary[] {
  const pairByPersona = new Map<string, PersonaSimilarityPair>();
  for (const pair of buildSimilarityPairs(entries)) {
    for (const id of [pair.leftPersonaId, pair.rightPersonaId]) {
      const current = pairByPersona.get(id);
      if (!current || pair.similarity > current.similarity) pairByPersona.set(id, pair);
    }
  }
  const usernameByPersona = new Map(entries.map((entry) => [entry.persona.id, entry.username]));
  return entries.map(({ persona }) => {
    const summary = base(persona);
    const pair = pairByPersona.get(persona.id);
    const issues = validatePersonaCoherence(persona);
    const otherId = pair?.leftPersonaId === persona.id ? pair.rightPersonaId : pair?.leftPersonaId;
    return {
      ...summary,
      completeness: personaCompleteness(persona),
      uniqueness: Math.max(0, Math.round((1 - (pair?.similarity ?? 0)) * 100)),
      consistency: Math.max(0, 100 - issues.filter((issue) => issue.severity === 'error').length * 25 - issues.filter((issue) => issue.severity === 'warning').length * 8),
      ...(otherId ? { mostSimilarPersonaId: otherId } : {}),
      ...(otherId && usernameByPersona.get(otherId) ? { mostSimilarUsername: usernameByPersona.get(otherId) } : {}),
      similarityReasons: pair?.reasons ?? [],
      qualityWarnings: issues.map((issue) => issue.message),
    };
  });
}

function buildSimilarityPairs(entries: AuditedPersona[]): PersonaSimilarityPair[] {
  const pairs: PersonaSimilarityPair[] = [];
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex]!;
      const right = entries[rightIndex]!;
      const result = personaSimilarity(left.persona, right.persona);
      pairs.push({
        leftPersonaId: left.persona.id,
        rightPersonaId: right.persona.id,
        ...(left.username ? { leftUsername: left.username } : {}),
        ...(right.username ? { rightUsername: right.username } : {}),
        similarity: result.similarity,
        reasons: result.reasons,
      });
    }
  }
  return pairs.sort((left, right) => right.similarity - left.similarity
    || left.leftPersonaId.localeCompare(right.leftPersonaId)
    || left.rightPersonaId.localeCompare(right.rightPersonaId));
}

function mixedActivityDimension(left: BotPersona, right: BotPersona): SimilarityDimension {
  const tokenScore = jaccard(tokens([...left.behavior.activity.preferredEventTypes, ...left.behavior.activity.ignoredEventTypes, left.behavior.activity.chatFrequency]), tokens([...right.behavior.activity.preferredEventTypes, ...right.behavior.activity.ignoredEventTypes, right.behavior.activity.chatFrequency]));
  const intervalScore = lengthSimilarity(left.behavior.minimumIntervalMs, right.behavior.minimumIntervalMs, 300_000);
  return { name: 'activity', label: 'похожий ритм активности', weight: 0.08, score: tokenScore * 0.75 + intervalScore * 0.25 };
}

function tokenDimension(name: string, label: string, weight: number, left: string[], right: string[], numericScore?: number): SimilarityDimension {
  const lexical = jaccard(tokens(left), tokens(right));
  return { name, label, weight, score: numericScore === undefined ? lexical : lexical * 0.75 + numericScore * 0.25 };
}

function numericDimension(name: string, label: string, weight: number, left: number[], right: number[]): SimilarityDimension {
  const score = left.reduce((sum, value, index) => sum + (1 - Math.min(1, Math.abs(value - (right[index] ?? 0)))), 0) / Math.max(1, left.length);
  return { name, label, weight, score };
}

function tokens(values: string[]): Set<string> {
  return new Set(values.join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size && !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function lengthSimilarity(left: number, right: number, scale: number): number { return 1 - Math.min(1, Math.abs(left - right) / scale); }
function speechFingerprint(persona: BotPersona): string { return JSON.stringify([persona.speech.openingPatterns, persona.speech.endingPatterns, persona.speech.favoriteExpressions, persona.speech.laughStyles, persona.speech.punctuationStyle, persona.speech.averageMessageWords]); }
function distribution(entries: AuditedPersona[], value: (entry: AuditedPersona) => string | undefined): Record<string, number> {
  return Object.fromEntries([...entries.reduce((map, entry) => {
    const key = value(entry)?.trim();
    if (key) map.set(key, (map.get(key) ?? 0) + 1);
    return map;
  }, new Map<string, number>())].sort(([left], [right]) => left.localeCompare(right, 'ru')));
}
function range(values: number[]): { min: number; max: number } {
  return values.length ? { min: Math.min(...values), max: Math.max(...values) } : { min: 0, max: 0 };
}
function duplicates(values: string[]): string[] {
  const counts = values.map(normalizeDuplicate).filter(Boolean).reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>());
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value).sort((left, right) => left.localeCompare(right, 'ru'));
}
function normalizeDuplicate(value: string): string { return value.toLowerCase().replace(/\s+/g, ' ').trim(); }
function percentage(value: number, total: number): number { return total ? round((value / total) * 100, 1) : 0; }
function round(value: number, digits: number): number { const scale = 10 ** digits; return Math.round(value * scale) / scale; }

const STOP_WORDS = new Set(['это', 'как', 'что', 'для', 'или', 'без', 'при', 'его', 'она', 'они', 'свою', 'свои', 'только', 'когда', 'после', 'если', 'уже', 'чтобы', 'который', 'может', 'очень', 'пишет', 'редко', 'любит', 'знает', 'уровне', 'стрим', 'dota']);
