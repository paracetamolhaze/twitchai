import { describe, expect, it } from 'vitest';
import { detectSpokenReactionSignal } from '../src/shared/bot-mention-matcher';

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
