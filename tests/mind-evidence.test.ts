import { describe, expect, it } from 'vitest';
import { concreteAnswer } from '../src/personas/mind-evidence';

describe('evidence for resolving personal questions', () => {
  const priceQuestion = 'сколько стоит час в компьютерном клубе';
  it.each([
    'S: Сколько стоит час в компьютерном клубе? Не знаю. Тут 30 человек',
    'S: Час в клубе вроде стоит 30 юаней',
    'S: Если час в клубе стоит 30 юаней, я не пойду',
    'O: Час в клубе стоит 30 юаней',
    'U: Час в клубе стоит 30 юаней',
    'S: Давайте посмотрим. O: Час в клубе стоит 30 юаней',
  ])('does not treat speculation, a question or another speaker as a confirmed answer: %s', (speech) => {
    expect(concreteAnswer(priceQuestion, speech)).toBeUndefined();
  });

  it('stores only the relevant utterance instead of mixing it with another subject', () => {
    expect(concreteAnswer(priceQuestion, 'S: Тут 30 зрителей. S: Час в клубе стоит 20 юаней. Дальше про пиццу'))
      .toBe('Час в клубе стоит 20 юаней.');
  });

  it('does not complete a general interest even if its exact topic is mentioned', () => {
    expect(concreteAnswer('интересно попробовать пиццу', 'S: Пицца стоит 30 юаней')).toBeUndefined();
  });
});
