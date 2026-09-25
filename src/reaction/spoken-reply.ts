import { StreamEvent } from '../stream-brain/types';

export interface SpokenReplyMessage {
  username: string;
  message: string;
  sentAt: number;
}

const tokens = (text: string): string[] => text.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) ?? [];
const COMMON_WORDS = new Set('ну да нет это этот эти вот так там тут как что чтобы просто потом вообще точно конечно нормально хорошо очень уже еще тоже было будет меня тебя себе только теперь'.split(' '));

function containsQuote(speech: string[], quote: string[]): boolean {
  // Permit at most two extra tokens for a hesitation/restart; never drop a content word from
  // the original message or reorder it. Shared subject alone must not establish ownership.
  for (let start = 0; start < speech.length; start += 1) {
    if (speech[start] !== quote[0]) continue;
    let matched = 1;
    let extras = 0;
    for (let i = start + 1; i < speech.length && matched < quote.length; i += 1) {
      if (speech[i] === quote[matched]) matched += 1;
      else if (++extras > 2) break;
    }
    if (matched === quote.length) return true;
  }
  return false;
}

/** A conservative read-aloud match, not a topic match. A unique, recent, substantial quote
 * identifies its author even when neither the username nor a question mark was spoken. */
export function findSpokenReply(event: StreamEvent, messages: SpokenReplyMessage[]): SpokenReplyMessage | undefined {
  if (!event.speech || event.source === 'chat') return undefined;
  const marked = /(?:^|\s)[SOU]:/u.test(event.speech);
  const segments = marked
    ? [...event.speech.matchAll(/(?:^|\s)([SOU]):\s*([\s\S]*?)(?=\s[SOU]:|$)/gu)]
      .filter(match => match[1] === 'S').map(match => match[2]!)
    : [event.speech];
  const speech = segments.map(tokens);
  const matches = messages.filter(item => {
    const age = event.timestamp - item.sentAt;
    if (age < 0 || age > 90_000) return false;
    const words = tokens(item.message);
    const distinctive = new Set(words.filter(word => word.length >= 4 && !COMMON_WORDS.has(word)));
    if (words.length < 3 || distinctive.size < 2) return false;
    return speech.some(text => containsQuote(text, words));
  });
  const authors = new Set(matches.map(item => item.username.toLowerCase()));
  if (authors.size !== 1) return undefined;
  const match = matches.sort((a, b) => b.sentAt - a.sentAt)[0]!;
  // An explicit different addressee is stronger evidence than a repeated quote.
  if (event.directMentions.length && !event.directMentions.some(name => name.toLowerCase() === match.username.toLowerCase())) return undefined;
  return match;
}
