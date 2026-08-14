import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { BotHistory } from '../src/personas/bot-history';
import { DEFAULT_PERSONAS } from '../src/personas/defaults';

describe('personas and per-bot history', () => {
  it('ships personas with materially different behavior', () => {
    const analyst = DEFAULT_PERSONAS.find((persona) => persona.id === 'analyst')!;
    const joker = DEFAULT_PERSONAS.find((persona) => persona.id === 'dry-joker')!;
    expect(analyst.behavior.sarcasmLevel).toBeLessThan(joker.behavior.sarcasmLevel);
    expect(analyst.behavior.verbosity.maxWords).not.toBe(joker.behavior.verbosity.maxWords);
    expect(analyst.behavior.styleInstructions).not.toBe(joker.behavior.styleInstructions);
    expect(analyst.identity.firstName).not.toBe(joker.identity.firstName);
    expect(analyst.family[0]?.name).not.toBe(joker.family[0]?.name);
    expect(DEFAULT_PERSONAS).toHaveLength(10);
    expect(new Set(DEFAULT_PERSONAS.map((persona) => persona.identity.firstName)).size).toBe(10);
    expect(new Set(DEFAULT_PERSONAS.map((persona) => persona.speech.messageExamples.join('|'))).size).toBe(10);
    expect(DEFAULT_PERSONAS.every((persona) => persona.fictionalPersona && persona.family.length > 0 && persona.timeline.length >= 3)).toBe(true);
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
