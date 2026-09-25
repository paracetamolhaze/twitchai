import { StreamEvent } from '../stream-brain/types';

export interface SpokenReplyMessage {
  username: string;
  message: string;
  sentAt: number;
}

const tokens = (text: string): string[] => text.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) ?? [];

/** A conservative read-aloud match, not a topic match. A unique, recent, substantial quote
 * identifies its author even when neither the username nor a question mark was spoken. */
export function findSpokenReply(event: StreamEvent, messages: SpokenReplyMessage[]): SpokenReplyMessage | undefined {
  if (!event.speech || event.source === 'chat') return undefined;
  const marked = /(?:^|\s)[SO]:/u.test(event.speech);
  const segments = marked
    ? [...event.speech.matchAll(/(?:^|\s)([SO]):\s*([\s\S]*?)(?=\s[SO]:|$)/gu)]
      .filter(match => match[1] === 'S').map(match => match[2]!)
    : [event.speech];
  const speech = segments.map(text => ` ${tokens(text).join(' ')} `);
  const matches = messages.filter(item => {
    const age = event.timestamp - item.sentAt;
    if (age < 0 || age > 90_000) return false;
    const words = tokens(item.message);
    if (words.length < 5 || words.filter(word => word.length >= 4).length < 3) return false;
    return speech.some(text => text.includes(` ${words.join(' ')} `));
  });
  const authors = new Set(matches.map(item => item.username.toLowerCase()));
  if (authors.size !== 1) return undefined;
  const match = matches.sort((a, b) => b.sentAt - a.sentAt)[0]!;
  // An explicit different addressee is stronger evidence than a repeated quote.
  if (event.directMentions.length && !event.directMentions.some(name => name.toLowerCase() === match.username.toLowerCase())) return undefined;
  return match;
}
