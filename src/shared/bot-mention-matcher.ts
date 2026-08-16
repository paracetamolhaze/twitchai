import { StreamEventCandidate } from '../stream-brain/types';

export interface BotMentionCandidate {
  username: string;
  aliases?: readonly string[];
}

export interface SpokenReactionSignal {
  kind: 'direct_mention' | 'greeting';
  candidate: StreamEventCandidate;
}

/**
 * Cyrillic spelled back as Latin, so a name said out loud can be recognised as the account it
 * belongs to. A Russian speaker saying karlbekner is transcribed Карлбекнер, or Карл Бекнер, or
 * КарлБекнер — none of which contain the username as written, so a question addressed to an
 * account by name went unanswered while the same name typed in chat worked fine.
 */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function transliterateToLatin(text: string): string {
  return [...text.toLowerCase()].map((character) => CYRILLIC_TO_LATIN[character] ?? character).join('');
}

/** Letters and digits only: a name heard as two words is still the one account. */
function reduce(text: string): string {
  return transliterateToLatin(text).replace(/[^a-z0-9]/g, '');
}

/** Below this a reduced match is more likely to be a coincidence inside a longer word. */
const MINIMUM_REDUCED_LENGTH = 5;

export class BotMentionMatcher {
  private readonly regexes: Array<{ username: string; regex: RegExp }>;
  private readonly reduced: Array<{ username: string; needle: string }>;

  constructor(candidates: readonly BotMentionCandidate[]) {
    this.reduced = candidates.flatMap((candidate) => {
      const username = candidate.username.trim().toLowerCase();
      const needle = reduce(username);
      return username && needle.length >= MINIMUM_REDUCED_LENGTH ? [{ username, needle }] : [];
    });
    this.regexes = candidates.flatMap((candidate) => {
      const username = candidate.username.trim().toLowerCase();
      if (!username) return [];
      const names = [username, ...(candidate.aliases ?? [])].map((name) => name.trim().toLowerCase());
      const uniqueNames = [...new Set(names)].filter(Boolean);
      if (uniqueNames.length === 0) return [];
      const escaped = uniqueNames.map(escapeRegex).join('|');
      return [{
        username,
        regex: new RegExp(`(?:^|[^\\p{L}\\p{N}_])@?(?:${escaped})(?:$|[^\\p{L}\\p{N}_])`, 'iu'),
      }];
    });
  }

  /**
   * Finds all bot usernames explicitly mentioned in the given text.
   * Evaluates text against bot username and its aliases.
   */
  match(text: string): string[] {
    const searchable = text.toLowerCase();
    const matches = new Set<string>();
    for (const { username, regex } of this.regexes) {
      if (regex.test(searchable)) {
        matches.add(username);
      }
    }
    // Spoken names arrive spelled in the language being spoken, so the same text is checked again
    // with both sides reduced to bare Latin letters.
    const spoken = reduce(searchable);
    for (const { username, needle } of this.reduced) {
      if (spoken.includes(needle)) matches.add(username);
    }
    return [...matches];
  }
}

export function detectSpokenReactionSignal(
  text: string,
  candidates: readonly BotMentionCandidate[],
  allowGreeting: boolean,
): SpokenReactionSignal | undefined {
  const speech = text.replace(/\s+/g, ' ').trim();
  if (!speech) return undefined;
  const mentions = new BotMentionMatcher(candidates).match(speech);
  if (mentions.length > 0) {
    return {
      kind: 'direct_mention',
      candidate: {
        timestamp: Date.now(),
        type: 'conversation',
        summary: `Стример напрямую обратился к ${mentions.map((username) => `@${username}`).join(', ')}`,
        speech,
        importance: 0.9,
        confidence: 0.95,
        directMentions: mentions,
      },
    };
  }
  if (!allowGreeting || candidates.length === 0 || !isClearStreamGreeting(speech)) return undefined;
  return {
    kind: 'greeting',
    candidate: {
      timestamp: Date.now(),
      type: 'conversation',
      summary: 'Стример явно поприветствовал чат в начале трансляции',
      speech,
      importance: 0.8,
      confidence: 0.9,
      directMentions: [],
    },
  };
}

export function isClearStreamGreeting(text: string): boolean {
  return /(?:^|[^\p{L}\p{N}_])(?:всем\s+привет(?:\s*,?\s*чат)?|привет\s*,?\s*чат|здарова\s*,?\s*чат|доброе\s+утро(?:\s*,?\s*чат)?|добрый\s+(?:день|вечер)(?:\s*,?\s*чат)?|hello\s*,?\s*chat|hi\s*,?\s*chat)(?:$|[^\p{L}\p{N}_])/iu.test(text);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
