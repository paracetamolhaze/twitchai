import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { BotHistory } from '../src/personas/bot-history';
import { generatePersonaV3 } from '../src/personas/generator-v3';
import { PRODUCTION_PERSONA_USERNAMES } from '../src/personas/generator-v3-data';

describe('personas and per-bot history', () => {
  it('ships personas with materially different behavior', () => {
    const personas = PRODUCTION_PERSONA_USERNAMES.map((username) => generatePersonaV3(username));
    const quiet = personas.find((persona) => persona.generatedFromUsername === 'pirpile')!;
    const expressive = personas.find((persona) => persona.generatedFromUsername === 'mooorgen')!;
    expect(quiet.behavior.reactionProbability).toBeLessThan(expressive.behavior.reactionProbability);
    expect(quiet.behavior.verbosity.maxWords).not.toBe(expressive.behavior.verbosity.maxWords);
    expect(quiet.behavior.styleInstructions).not.toBe(expressive.behavior.styleInstructions);
    expect(quiet.identity.firstName).not.toBe(expressive.identity.firstName);
    expect(quiet.family[0]?.name).not.toBe(expressive.family[0]?.name);
    expect(personas).toHaveLength(30);
    expect(new Set(personas.map((persona) => persona.identity.firstName)).size).toBe(30);
    expect(new Set(personas.map((persona) => persona.speech.messageExamples.join('|'))).size).toBe(30);
    expect(personas.every((persona) => persona.fictionalPersona && persona.family.length > 0 && persona.timeline.length >= 5)).toBe(true);
  });

  it('keeps histories separate and rejects recent near-duplicates', async () => {
    const repository = new MemoryRepository();
    const history = new BotHistory(repository);
    await history.add('bot-one', 'ну это было очень хорошо');
    await history.add('bot-two', 'совсем другая реплика');
    expect(await history.isDuplicate('bot-one', 'ну это было хорошо')).toBe(true);
    expect(await history.isDuplicate('bot-two', 'ну это было хорошо')).toBe(false);
    expect((await history.recent('bot-one')).map((item) => item.message)).toEqual(['ну это было очень хорошо']);
  });
});
