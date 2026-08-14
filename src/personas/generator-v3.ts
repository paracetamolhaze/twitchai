import { createHash } from 'node:crypto';
import { personaSchema } from './schema';
import { PERSONA_BLUEPRINTS, PersonaBlueprint } from './generator-v3-data';
import { BotPersona, PERSONA_GENERATION_VERSION, PERSONA_SCHEMA_VERSION } from './types';

export interface GeneratePersonaV3Options {
  id?: string;
}

/**
 * Builds fictional canon from a stable username blueprint. The function has no
 * clock, network or random dependencies: username + generation version always
 * produces the same person. No Twitch owner data is queried or inferred.
 */
export function generatePersonaV3(username: string, options: GeneratePersonaV3Options = {}): BotPersona {
  const normalized = normalizeUsername(username);
  const blueprint = PERSONA_BLUEPRINTS[normalized];
  if (!blueprint) throw new Error('persona_blueprint_not_found');
  const id = options.id ?? `account-${slug(normalized)}`;
  const displayName = blueprint.preferredName !== blueprint.firstName
    ? `${blueprint.firstName} «${blueprint.preferredName}» · ${normalized}`
    : `${blueprint.firstName} · ${normalized}`;

  return personaSchema.parse({
    schemaVersion: PERSONA_SCHEMA_VERSION,
    generationVersion: PERSONA_GENERATION_VERSION,
    source: 'generated',
    generatedFromUsername: normalized,
    manuallyEdited: false,
    manualOverrides: [],
    legacyManualReviewRequired: false,
    fictionalPersona: true,
    id,
    name: displayName,
    description: buildDescription(blueprint),
    identity: {
      firstName: blueprint.firstName,
      preferredName: blueprint.preferredName,
      nickname: normalized,
      nicknameOrigin: blueprint.nicknameOrigin,
      birthDate: blueprint.birthDate,
      birthplace: blueprint.birthplace,
      grewUpIn: blueprint.grewUpIn,
      currentLocation: blueprint.currentLocation,
      languages: blueprint.languages,
      occupation: blueprint.occupation,
      education: blueprint.education,
      relationshipStatus: blueprint.relationshipStatus,
    },
    familyBackground: blueprint.familyBackground,
    family: blueprint.family.map(([relation, name, occupation, city, relationshipDescription, facts], index) => ({
      id: `${id}-relative-${index + 1}`,
      relation,
      name,
      occupation,
      city,
      relationshipDescription,
      facts,
    })),
    timeline: blueprint.timeline.map(([year, title, description, tags], index) => ({
      id: `${id}-life-${index + 1}`,
      year,
      title,
      description,
      emotionalWeight: clamp(0.48 + index * 0.07),
      tags,
    })),
    facts: blueprint.facts.map(([category, fact, tags, privateByDefault], index) => ({
      id: `${id}-fact-${index + 1}`,
      category,
      fact,
      importance: clamp(0.58 + (index % 4) * 0.09),
      ...(privateByDefault === undefined ? {} : { privateByDefault }),
      tags,
    })),
    opinions: blueprint.opinions.map(([topic, stance, strength, reasoning], index) => ({
      id: `${id}-opinion-${index + 1}`,
      topic,
      stance,
      strength,
      reasoning,
      immutable: strength >= 0.82,
      tags: semanticTags(topic),
    })),
    knowledge: structuredClone(blueprint.knowledge),
    character: structuredClone(blueprint.character),
    interests: structuredClone(blueprint.interests),
    speech: structuredClone(blueprint.speech),
    behavior: structuredClone(blueprint.behavior),
    disclosure: structuredClone(blueprint.disclosure),
    streamerRelationship: structuredClone(blueprint.streamerRelationship),
    relationships: [],
  });
}

export function personaGenerationFingerprint(persona: BotPersona): string {
  return createHash('sha256').update(JSON.stringify(persona)).digest('hex');
}

function buildDescription(blueprint: PersonaBlueprint): string {
  const move = blueprint.birthplace.city === blueprint.currentLocation.city
    ? `Живёт в ${blueprint.currentLocation.city}, где вырос(ла).`
    : `Родом из ${blueprint.birthplace.city}; сейчас живёт в ${blueprint.currentLocation.city}.`;
  return `${blueprint.firstName} (${blueprint.preferredName}) — полностью вымышленный зритель, созданный из истории ника ${blueprint.username}. ${move} ${blueprint.character.summary}`;
}

function normalizeUsername(username: string): string {
  const normalized = username.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,50}$/.test(normalized)) throw new Error('invalid_twitch_username');
  return normalized;
}

function slug(value: string): string { return value.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 68); }
function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
function semanticTags(value: string): string[] { return value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((part) => part.length > 2).slice(0, 4); }
