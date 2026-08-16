import { describe, expect, it } from 'vitest';
import { BotMentionMatcher, detectSpokenReactionSignal } from '../src/shared/bot-mention-matcher';

const candidates = [
  { username: 'karlbekner', aliases: ['карлбекнер'] },
  { username: 'gigantiuz', aliases: [] },
];

describe('spoken Twitch bot signals', () => {
  it('turns an exact configured spoken alias into a trusted direct mention', () => {
    const signal = detectSpokenReactionSignal('Карлбекнер, ты тут?', candidates, true);

    expect(signal).toMatchObject({
      kind: 'direct_mention',
      candidate: {
        type: 'conversation',
        summary: 'Стример напрямую обратился к @karlbekner',
        speech: 'Карлбекнер, ты тут?',
        directMentions: ['karlbekner'],
      },
    });
  });

  it('does not use broad fuzzy matching for ordinary words', () => {
    expect(detectSpokenReactionSignal('Карл сегодня не пришёл', candidates, true)).toBeUndefined();
    expect(detectSpokenReactionSignal('так, что дальше', candidates, true)).toBeUndefined();
  });

  it('creates one eligible greeting signal without forcing every persona to answer', () => {
    const signal = detectSpokenReactionSignal('Всем привет, чат!', candidates, true);
    expect(signal).toMatchObject({
      kind: 'greeting',
      candidate: {
        type: 'conversation',
        summary: 'Стример явно поприветствовал чат в начале трансляции',
        directMentions: [],
      },
    });
    expect(signal?.candidate.importance).toBeGreaterThanOrEqual(0.75);
    expect(detectSpokenReactionSignal('Всем привет, чат!', candidates, false)).toBeUndefined();
  });
});

describe('a name said out loud in the language being spoken', () => {
  // Configured aliases only ever covered the accounts somebody remembered to write them for.
  // These have none, which is the normal case for thirty of them.
  const matcher = new BotMentionMatcher([{ username: 'karlbekner' }, { username: 'gigantiuz' }]);

  it('recognises the account when the transcript spells it in Cyrillic', () => {
    expect(matcher.match('Карлбекнер, а ты чё думаешь, стоит туда идти?')).toEqual(['karlbekner']);
  });

  it('recognises it when the transcriber splits the name into two words', () => {
    // Every model tested did this at least once: Карл Бекнер, КарлБекнер, Карлбекнер.
    expect(matcher.match('Карл Бекнер, а ты что думаешь?')).toEqual(['karlbekner']);
    expect(matcher.match('КарлБекнер, а ты что думаешь?')).toEqual(['karlbekner']);
  });

  it('still recognises the name typed the ordinary way', () => {
    expect(matcher.match('@karlbekner ты бот?')).toEqual(['karlbekner']);
  });

  it('does not answer to ordinary speech that merely sounds similar', () => {
    expect(matcher.match('короче поехали в центр, там бар нормальный')).toEqual([]);
    expect(matcher.match('гигант какой-то, вообще не понял')).toEqual([]);
  });
});
