import { describe, expect, it } from 'vitest';
import { computeChatRegister } from '../src/stream-brain/chat-register';
import { ChatMessage } from '../src/stream-brain/types';

const NOW = 1_700_000_000_000;

function message(username: string, text: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `${username}-${Math.random()}`, timestamp: NOW - 60_000, username,
    displayName: username, message: text, kind: 'viewer', ...overrides,
  };
}

const BOTS = new Set(['karlbekner', 'gigantiuz']);

function humanSample(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) =>
    message(`viewer${index % 12}`, index % 3 === 0 ? 'лол' : index % 3 === 1 ? 'ну такое себе' : 'а что за игра?'));
}

describe('human chat register', () => {
  it('is omitted below the minimum sample — six messages are noise wearing decimals', () => {
    expect(computeChatRegister(humanSample(29), { botUsernames: BOTS, now: NOW })).toBeUndefined();
    expect(computeChatRegister(humanSample(30), { botUsernames: BOTS, now: NOW })).toBeDefined();
  });

  it('excludes our accounts, service bots and the broadcaster from the sample', () => {
    const chat = [
      ...humanSample(30),
      ...Array.from({ length: 40 }, () => message('karlbekner', 'бот пишет')),
      ...Array.from({ length: 40 }, () => message('fossabot', '!commands доступны')),
      ...Array.from({ length: 40 }, () => message('thestreamer', 'я стример')),
    ];
    const register = computeChatRegister(chat, { botUsernames: BOTS, channel: 'thestreamer', now: NOW });
    expect(register?.sampleSize).toBe(30);
  });

  it('ignores bot-kind messages and everything outside the window', () => {
    const chat = [
      ...humanSample(30),
      ...Array.from({ length: 20 }, () => message('oldviewer', 'старое', { timestamp: NOW - 11 * 60_000 })),
      ...Array.from({ length: 20 }, () => message('somebot', 'ботское', { kind: 'bot' })),
    ];
    expect(computeChatRegister(chat, { botUsernames: BOTS, now: NOW })?.sampleSize).toBe(30);
  });

  it('carries only aggregates: no literal viewer message and no username survives into the block', () => {
    const chat = Array.from({ length: 35 }, (_, index) =>
      message(`уникальный_ник_${index}`, `совершенно уникальная фраза номер ${index}`));
    const register = computeChatRegister(chat, { botUsernames: BOTS, now: NOW });
    const serialized = JSON.stringify(register);
    expect(serialized).not.toContain('уникальная фраза');
    expect(serialized).not.toContain('уникальный_ник');
  });

  it('measures the room recognisably: short lowercase informal chat reads as such', () => {
    const chat = [
      ...Array.from({ length: 20 }, (_, index) => message(`v${index}`, 'лол')),
      ...Array.from({ length: 10 }, (_, index) => message(`w${index}`, 'а это что?')),
      ...Array.from({ length: 10 }, (_, index) => message(`x${index}`, 'ну бля пиздец')),
    ];
    const register = computeChatRegister(chat, { botUsernames: BOTS, now: NOW })!;
    expect(register.oneWordRate).toBeGreaterThan(0.4);
    expect(register.lowercaseRate).toBe(1);
    expect(register.questionRate).toBeCloseTo(0.25, 1);
    expect(register.laughterRate).toBeGreaterThan(0.4);
    expect(register.profanityRate).toBeCloseTo(0.25, 1);
    expect(register.medianWordsPerMessage).toBeLessThanOrEqual(3);
    // And the fixed guidance says what the block is NOT: an imitation target.
    expect(register.guidance).toContain('не образец');
  });
});
