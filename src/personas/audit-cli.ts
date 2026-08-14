import { generatePersonaV3 } from './generator-v3';
import { PRODUCTION_PERSONA_USERNAMES } from './generator-v3-data';
import { auditPersonas } from './persona-quality';

const personas = PRODUCTION_PERSONA_USERNAMES.map((username) => generatePersonaV3(username));
const audit = auditPersonas(personas.map((persona) => ({ username: persona.generatedFromUsername, persona })));
const exampleUsernames = new Set(['gigantiuz', '404notf0und404', 'karlbekner', 'pirpile', 'arimoki_ta']);

const report = {
  generator: { schemaVersion: 2, generationVersion: 3, deterministic: true, personaCount: personas.length },
  mapping: personas.map((persona) => ({
    username: persona.generatedFromUsername,
    humanName: persona.identity.firstName,
    preferredName: persona.identity.preferredName,
  })),
  geography: personas.map((persona) => ({
    username: persona.generatedFromUsername,
    birthplace: persona.identity.birthplace,
    currentLocation: persona.identity.currentLocation,
  })),
  occupations: audit.occupationDistribution,
  speechProfiles: personas.slice(0, 10).map((persona) => ({
    username: persona.generatedFromUsername,
    averageMessageWords: persona.speech.averageMessageWords,
    openings: persona.speech.openingPatterns,
    endings: persona.speech.endingPatterns,
    laughter: persona.speech.laughStyles,
    punctuation: persona.speech.punctuationStyle,
    profanityLevel: persona.speech.profanityLevel,
  })),
  behaviorProfiles: personas.map((persona) => ({
    username: persona.generatedFromUsername,
    reactionProbability: persona.behavior.reactionProbability,
    eventSelectivity: persona.behavior.activity.eventSelectivity,
    directReplyLikelihood: persona.behavior.activity.directReplyLikelihood,
    sarcasmLevel: persona.behavior.sarcasmLevel,
    delayMs: persona.behavior.activity.averageDelayMs,
    chatFrequency: persona.behavior.activity.chatFrequency,
  })),
  examples: personas.filter((persona) => exampleUsernames.has(persona.generatedFromUsername ?? '')),
  karlbekner: personas.find((persona) => persona.generatedFromUsername === 'karlbekner'),
  audit,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
