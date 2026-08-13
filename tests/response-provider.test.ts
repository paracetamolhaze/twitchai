import { describe, expect, it } from 'vitest';
import { parseGeneratedResponse } from '../src/response/gemini-response-provider';

describe('response output contract', () => {
  it('treats <skip> as a first-class no-response result', () => {
    expect(parseGeneratedResponse('<skip>')).toEqual({ kind: 'skip' });
  });

  it('normalizes a plain Twitch message without forcing one global style', () => {
    expect(parseGeneratedResponse('«Вот это тайминг!»')).toEqual({ kind: 'message', text: 'Вот это тайминг!' });
  });
});
