import { ChatMessage } from './types';

/**
 * The room's current way of talking, as numbers — never as examples.
 *
 * Earlier versions deliberately skipped this: real viewer chat was too sparse to measure. A live
 * test with a real audience changed that, and the accounts now write into a room whose register
 * they can be told about. Aggregates only, computed from real viewers' messages over a short
 * window: no literal message ever travels (copying viewers' phrases is exactly the failure mode
 * this must not create), no usernames, no per-viewer anything. The block is omitted entirely below
 * the minimum sample — a register measured from six messages is noise wearing decimals.
 *
 * Persona voice stays primary. This is environmental pressure — "the chat around you is currently
 * short, lowercase and casual" — not an instruction to imitate anyone: a formal persona writing
 * into an informal room correctly stays more formal than the room.
 */

export interface ChatRegister {
  /** How the guidance below was measured, so the model can weigh it. */
  sampleSize: number;
  windowMinutes: number;
  medianWordsPerMessage: number;
  /** Share of messages with at most three words. */
  shortMessageRate: number;
  oneWordRate: number;
  /** Share of messages containing no uppercase letters at all. */
  lowercaseRate: number;
  /** Share of messages ending with terminal punctuation. */
  punctuationRate: number;
  questionRate: number;
  laughterRate: number;
  profanityRate: number;
  /** Share of messages that are (or contain) known emote-style tokens. */
  emoteRate: number;
  /** One fixed sentence telling the model what this block is and is not. */
  guidance: string;
}

export interface ChatRegisterOptions {
  /** Lowercase usernames of our own accounts — never part of the sample. */
  botUsernames: ReadonlySet<string>;
  /** The broadcaster, excluded: the streamer's messages are not the room's register. */
  channel?: string;
  now: number;
  windowMs?: number;
  minSample?: number;
}

const DEFAULT_WINDOW_MS = 10 * 60_000;
const DEFAULT_MIN_SAMPLE = 30;

/** Service and moderation bots every Twitch chat carries; their messages are furniture. */
const SERVICE_BOTS = new Set([
  'fossabot', 'nightbot', 'streamelements', 'streamlabs', 'moobot', 'wizebot', 'botrix', 'sery_bot',
]);

const LAUGHTER = /(?:[ах]{3,}|a?x?ha(?:ha)+|kekw|lul|lol|лол|omegalul|ахах|азаз)/i;
const EMOTE = /(?:kekw|lul+|pog\S*|omegalul|monkas|sadge|peepo\S*|catjam|clap|ez\b|gg\b|f\b)/i;
const PROFANITY = /(?:бля|хуй|хуе|пизд|ебан|ебат|ебал|заеб|наху|пидор|сука|говн|мудак|долбо)/i;

export const CHAT_REGISTER_GUIDANCE =
  'Фон чата вокруг, только среда: не образец для подражания, не квота на сленг или мат. '
  + 'Голос каждого персонажа первичен; формальный человек остаётся формальнее комнаты.';

export function computeChatRegister(
  chat: ChatMessage[],
  options: ChatRegisterOptions,
): ChatRegister | undefined {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const minSample = options.minSample ?? DEFAULT_MIN_SAMPLE;
  const channel = options.channel?.toLowerCase();
  const sample = chat.filter((message) => {
    if (message.kind !== 'viewer') return false;
    if (options.now - message.timestamp > windowMs) return false;
    const username = message.username.toLowerCase();
    if (options.botUsernames.has(username) || SERVICE_BOTS.has(username)) return false;
    if (channel && username === channel) return false;
    return message.message.trim().length > 0;
  });
  if (sample.length < minSample) return undefined;

  const wordCounts = sample.map((message) => (message.message.trim().match(/\S+/g) ?? []).length);
  const sorted = [...wordCounts].sort((a, b) => a - b);
  const rate = (predicate: (message: string) => boolean): number =>
    Number((sample.filter((message) => predicate(message.message)).length / sample.length).toFixed(2));

  return {
    sampleSize: sample.length,
    windowMinutes: Math.round(windowMs / 60_000),
    medianWordsPerMessage: sorted[Math.floor(sorted.length / 2)] ?? 0,
    shortMessageRate: Number((wordCounts.filter((count) => count <= 3).length / sample.length).toFixed(2)),
    oneWordRate: Number((wordCounts.filter((count) => count === 1).length / sample.length).toFixed(2)),
    lowercaseRate: rate((message) => !/\p{Lu}/u.test(message)),
    punctuationRate: rate((message) => /[.!?…]\s*$/.test(message.trim())),
    questionRate: rate((message) => message.includes('?')),
    laughterRate: rate((message) => LAUGHTER.test(message)),
    profanityRate: rate((message) => PROFANITY.test(message)),
    emoteRate: rate((message) => EMOTE.test(message)),
    guidance: CHAT_REGISTER_GUIDANCE,
  };
}
