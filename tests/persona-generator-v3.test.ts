import { describe, expect, it } from 'vitest';
import { generatePersonaV3, personaGenerationFingerprint } from '../src/personas/generator-v3';
import { PRODUCTION_PERSONA_USERNAMES } from '../src/personas/generator-v3-data';
import { auditPersonas, auditedPersonaSummaries, personaSimilarity, validatePersonaCoherence } from '../src/personas/persona-quality';
import { personaSummary } from '../src/personas/schema';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { PersonaMemory } from '../src/personas/persona-memory';
import { PersonaRuntimeStore } from '../src/personas/persona-runtime-store';
import { PersonaContextBuilder } from '../src/personas/persona-context-builder';

describe('Deep Persona Generator v3', () => {
  it('builds the explicit fictional identity for karlbekner from the nickname', () => {
    const persona = generatePersonaV3('karlbekner', { id: 'account-karlbekner' });

    expect(persona.id).toBe('account-karlbekner');
    expect(persona.identity.firstName).toBe('Константин');
    expect(persona.identity.preferredName).toBe('Костя');
    expect(persona.identity.nickname).toBe('karlbekner');
    expect(persona.identity.nicknameOrigin).toMatch(/karl|бекнер|ник/iu);
    expect(persona.generationVersion).toBe(3);
    expect(persona.generatedFromUsername).toBe('karlbekner');
    expect(persona.source).toBe('generated');
    expect(persona.fictionalPersona).toBe(true);
    expect(() => generatePersonaV3('unreviewed_account')).toThrow('persona_blueprint_not_found');
  });

  it('builds one stable and genuinely diverse fictional cohort for all 30 production usernames', () => {
    const personas = PRODUCTION_PERSONA_USERNAMES.map((username) => generatePersonaV3(username));
    const again = PRODUCTION_PERSONA_USERNAMES.map((username) => generatePersonaV3(username));
    const countryCounts = personas.reduce((counts, persona) => {
      const country = persona.identity.birthplace?.country ?? '';
      counts.set(country, (counts.get(country) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
    const speechFingerprints = new Set(personas.map((persona) => JSON.stringify({
      openingPatterns: persona.speech.openingPatterns,
      endingPatterns: persona.speech.endingPatterns,
      favoriteExpressions: persona.speech.favoriteExpressions,
      punctuationStyle: persona.speech.punctuationStyle,
      laughStyles: persona.speech.laughStyles,
      averageMessageWords: persona.speech.averageMessageWords,
    })));

    expect(personas).toHaveLength(30);
    expect(new Set(personas.map((persona) => persona.identity.firstName)).size).toBe(30);
    expect(new Set(personas.map((persona) => persona.identity.nicknameOrigin)).size).toBe(30);
    expect(personas.map(personaGenerationFingerprint)).toEqual(again.map(personaGenerationFingerprint));
    expect(countryCounts.size).toBeGreaterThanOrEqual(10);
    expect(Math.max(...countryCounts.values())).toBeLessThanOrEqual(5);
    expect(personas.filter((persona) => persona.identity.birthplace?.city !== persona.identity.currentLocation?.city).length).toBeGreaterThanOrEqual(12);
    expect(speechFingerprints.size).toBe(30);
    expect(personas.every((persona) => persona.speech.messageExamples.length >= 15)).toBe(true);
    expect(personas.every((persona) => persona.identity.nicknameOrigin?.toLowerCase().includes(persona.identity.nickname!.replace(/\d+/g, '').replace(/_+/g, '').slice(0, 3).toLowerCase())
      || persona.identity.nicknameOrigin!.toLowerCase().includes('ник'))).toBe(true);
    expect(personas.every((persona) => {
      const birthYear = Number(persona.identity.birthDate?.slice(0, 4));
      return persona.timeline.every((event) => event.year === undefined || event.year >= birthYear);
    })).toBe(true);
  });

  it('reports deterministic similarity and rejects impossible canon timelines', () => {
    const entries = PRODUCTION_PERSONA_USERNAMES.map((username) => ({ username, persona: generatePersonaV3(username) }));
    const report = auditPersonas(entries);
    const impossible = structuredClone(entries[0]!.persona);
    impossible.timeline[0] = { ...impossible.timeline[0]!, year: 1900 };

    expect(report.accountCount).toBe(30);
    expect(report.uniquePersonaCount).toBe(30);
    expect(report.uniqueSpeechFingerprintCount).toBe(30);
    expect(report.coherenceErrors).toEqual([]);
    expect(report.maximumSimilarity).toBeLessThanOrEqual(0.65);
    expect(report.mostSimilarPairs).toHaveLength(10);
    expect(report.structureRanges).toMatchObject({
      relatives: { min: 3 },
      timelineEvents: { min: 5 },
      facts: { min: 6 },
      opinions: { min: 5 },
    });
    expect(report.structureRanges.speechExamples!.min).toBeGreaterThanOrEqual(15);
    expect(report.countryOfBirthDistribution).toMatchObject({ Казахстан: 3, Беларусь: 3, Таджикистан: 1 });
    expect(validatePersonaCoherence(impossible).some((issue) => issue.code === 'timeline_before_birth')).toBe(true);

    const summaries = auditedPersonaSummaries(entries, (persona) => personaSummary(persona));
    for (const summary of summaries) {
      const current = entries.find((entry) => entry.persona.id === summary.id)!.persona;
      const nearest = Math.max(...entries
        .filter((entry) => entry.persona.id !== summary.id)
        .map((entry) => personaSimilarity(current, entry.persona).similarity));
      expect(summary.uniqueness).toBe(Math.round((1 - nearest) * 100));
    }
  });

  it('detects implausible education, experience and nickname-era claims', () => {
    const university = generatePersonaV3('gigantiuz');
    const birthYear = Number(university.identity.birthDate!.slice(0, 4));
    university.timeline[0] = {
      ...university.timeline[0]!, year: birthYear + 14,
      title: 'Поступление в университет', description: 'Начал бакалавриат.',
    };
    expect(validatePersonaCoherence(university).some((issue) => issue.code === 'timeline_impossible_age')).toBe(true);

    const experience = generatePersonaV3('supercser2');
    experience.facts.push({ id: 'impossible-experience', category: 'work', fact: 'Имеет 99 лет стажа в профессии.', importance: 1, tags: ['стаж'] });
    expect(validatePersonaCoherence(experience).some((issue) => issue.code === 'impossible_experience')).toBe(true);

    const anachronisticNickname = generatePersonaV3('alexmadkid');
    anachronisticNickname.identity.birthDate = '2010-06-26';
    anachronisticNickname.identity.nicknameOrigin = 'Придумал ник в CS 1.6, но точного года в каноне нет.';
    expect(validatePersonaCoherence(anachronisticNickname).some((issue) => issue.code === 'nickname_era_unproven')).toBe(true);
  });

  it('produces distinct style probes, including natural silence, for one event across ten personas', async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const builder = new PersonaContextBuilder(
      new PersonaMemory(repository, { now: () => Date.UTC(2026, 7, 14) }),
      new PersonaRuntimeStore(() => Date.UTC(2026, 7, 14)),
    );
    const personas = PRODUCTION_PERSONA_USERNAMES.slice(0, 10).map((username) => generatePersonaV3(username));
    const contexts = await Promise.all(personas.map((persona) => builder.build({
      username: persona.generatedFromUsername!,
      persona,
      event: {
        id: 'same-event', timestamp: Date.UTC(2026, 7, 14), type: 'fail',
        summary: 'стример промахнулся решающим ультимейтом', importance: 0.93,
        confidence: 0.96, source: 'gemini-live', directMentions: [],
      },
      recentMessages: [], directMention: false, observeRuntime: false,
    })));
    const fingerprints = new Set(contexts.map((context) => JSON.stringify({
      identity: context.identity.firstName,
      speech: context.speech,
      behavior: context.behavior,
      knowledge: context.knowledge,
    })));
    const styleProbeReactions = contexts.map((context) => {
      const explicitlyRelevant = context.behavior.activity.preferredEventTypes.includes('fail');
      if (context.behavior.activity.eventSelectivity >= 0.85 && !explicitlyRelevant) return '<skip>';
      return context.speech.messageExamples[0] ?? '<skip>';
    });
    const spoken = styleProbeReactions.filter((reaction) => reaction !== '<skip>');
    const normalizedTokenSets = spoken.map((reaction) => new Set(reaction.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)));
    const pairSimilarities = normalizedTokenSets.flatMap((left, leftIndex) => normalizedTokenSets.slice(leftIndex + 1).map((right) => {
      const intersection = [...left].filter((token) => right.has(token)).length;
      return intersection / Math.max(1, left.size + right.size - intersection);
    }));

    expect(contexts).toHaveLength(10);
    expect(fingerprints.size).toBe(10);
    expect(styleProbeReactions.filter((reaction) => reaction === '<skip>').length).toBeGreaterThanOrEqual(1);
    expect(spoken.length).toBeGreaterThanOrEqual(5);
    expect(new Set(spoken).size).toBe(spoken.length);
    expect(Math.max(...pairSimilarities)).toBeLessThan(0.8);
  });
});
