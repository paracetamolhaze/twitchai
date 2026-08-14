import { StreamEventCandidate } from '../stream-brain/types';

export interface BotMentionCandidate {
  username: string;
  aliases?: readonly string[];
}

export interface SpokenReactionSignal {
  kind: 'direct_mention' | 'greeting';
  candidate: StreamEventCandidate;
}

export class BotMentionMatcher {
  private readonly regexes: Array<{ username: string; regex: RegExp }>;

  constructor(candidates: readonly BotMentionCandidate[]) {
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
