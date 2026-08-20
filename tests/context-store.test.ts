import { describe, expect, it } from 'vitest';
import { ContextStore } from '../src/stream-brain/context-store';
import { ChatMessage } from '../src/stream-brain/types';

function chat(timestamp: number, message = 'привет'): ChatMessage {
  return { id: `m-${timestamp}`, timestamp, username: 'viewer', displayName: 'viewer', message, kind: 'viewer' };
}

describe('ContextStore chat retention', () => {
  it('prunes by the rolling window when no session has begun — the previous, unchanged behavior', () => {
    let now = 1_000_000;
    const store = new ContextStore({ chatWindowMs: 120_000, maxChatMessages: 200, maxEvents: 10, now: () => now });
    store.addChat(chat(now));
    now += 200_000; // past the 120s window, and beginSession() was never called
    store.addChat(chat(now));
    expect(store.snapshot().recentChat.map((m) => m.timestamp)).toEqual([now]);
  });

  it('keeps chat older than the rolling window once a session has begun — the actual fix', () => {
    // A live run sent 19 bot messages and the dashboard showed about 6: whatever fell inside the
    // trailing 120s at read time. Once beginSession() has run, that clock stops applying to chat.
    let now = 1_000_000;
    const store = new ContextStore({ chatWindowMs: 120_000, maxChatMessages: 200, maxEvents: 10, now: () => now });
    store.beginSession(now);
    store.addChat(chat(now));
    now += 200_000; // 200s later, well past chatWindowMs
    store.addChat(chat(now));
    expect(store.snapshot().recentChat).toHaveLength(2);
  });

  it('clears chat from a previous evening when a genuinely new session begins', () => {
    let now = 1_000_000;
    const store = new ContextStore({ chatWindowMs: 120_000, maxChatMessages: 200, maxEvents: 10, now: () => now });
    store.beginSession(now);
    store.addChat(chat(now, 'вчерашнее'));
    now += 1_000;
    store.beginSession(now); // a new evening, not a resume
    expect(store.snapshot().recentChat).toHaveLength(0);
    store.addChat(chat(now, 'сегодняшнее'));
    expect(store.snapshot().recentChat.map((m) => m.message)).toEqual(['сегодняшнее']);
  });

  it('keeps chat that already belongs to the session being declared, rather than clearing unconditionally', () => {
    // beginSession bounds by its own startedAt instead of wiping the array, so declaring a session
    // whose start is slightly in the past — the real shape of "media connected, session begins now,
    // a bot joined and chat arrived two seconds ago" — keeps what belongs to it.
    const now = 1_000_000;
    const store = new ContextStore({ chatWindowMs: 120_000, maxChatMessages: 200, maxEvents: 10, now: () => now });
    store.addChat(chat(now - 10_000, 'до объявления сессии'));
    store.addChat(chat(now - 2_000, 'тоже до объявления'));
    store.beginSession(now - 5_000);
    expect(store.snapshot().recentChat.map((m) => m.message)).toEqual(['тоже до объявления']);
  });

  it('keeps history intact across a resume — beginSession is not called again', () => {
    let now = 1_000_000;
    const store = new ContextStore({ chatWindowMs: 120_000, maxChatMessages: 200, maxEvents: 10, now: () => now });
    store.beginSession(now);
    store.addChat(chat(now, 'до паузы'));
    now += 30_000; // an operator pause, resumed — application.ts never calls beginSession() here
    store.addChat(chat(now, 'после паузы'));
    expect(store.snapshot().recentChat.map((m) => m.message)).toEqual(['до паузы', 'после паузы']);
  });

  it('keeps all twenty bot messages of a real session available, and does not drop them when a twenty-first arrives', () => {
    // The live run this fixes: twenty bot messages, every one confirmed visible in Twitch, spread
    // across 26 minutes — and the dashboard showed about six, because the rolling 120s window was
    // re-applied at read time. The spacing here is the real one (roughly 80s apart, the observed
    // cadence), so the window would still be the thing cutting it if it were still in force.
    let now = 1_000_000;
    const store = new ContextStore({ chatWindowMs: 120_000, maxChatMessages: 5_000, maxEvents: 10, now: () => now });
    store.beginSession(now);
    for (let i = 0; i < 20; i += 1) {
      store.addChat({
        id: `bot-${i}`, timestamp: now, username: 'griffin0502', displayName: 'griffin0502',
        message: `сообщение ${i}`, kind: 'bot',
      });
      now += 80_000;
    }
    expect(store.snapshot().recentChat.filter((m) => m.kind === 'bot')).toHaveLength(20);

    store.addChat({
      id: 'bot-20', timestamp: now, username: 'griffin0502', displayName: 'griffin0502',
      message: 'сообщение 20', kind: 'bot',
    });
    const after = store.snapshot().recentChat;
    expect(after).toHaveLength(21);
    // Specifically: the oldest is still there, not just the count.
    expect(after[0]?.message).toBe('сообщение 0');
  });

  it('still bounds a session by maxChatMessages, regardless of how recent', () => {
    let now = 1_000_000;
    const store = new ContextStore({ chatWindowMs: 120_000, maxChatMessages: 3, maxEvents: 10, now: () => now });
    store.beginSession(now);
    for (let i = 0; i < 5; i += 1) {
      store.addChat(chat(now, `m${i}`));
      now += 1;
    }
    const kept = store.snapshot().recentChat.map((m) => m.message);
    expect(kept).toHaveLength(3);
    expect(kept).toEqual(['m2', 'm3', 'm4']);
  });
});
