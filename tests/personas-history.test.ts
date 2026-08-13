import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { BotHistory } from '../src/personas/bot-history';
import { DEFAULT_PERSONAS } from '../src/personas/defaults';

describe('personas and per-bot history', () => {
  it('ships personas with materially different behavior', () => {
    const analyst = DEFAULT_PERSONAS.find((persona) => persona.id === 'analyst')!;
    const joker = DEFAULT_PERSONAS.find((persona) => persona.id === 'dry-joker')!;
    expect(analyst.sarcasmLevel).toBeLessThan(joker.sarcasmLevel);
    expect(analyst.verbosity.maxWords).not.toBe(joker.verbosity.maxWords);
    expect(analyst.styleInstructions).not.toBe(joker.styleInstructions);
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
