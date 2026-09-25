import { semanticTokens } from './persona-memory';

/** Conservative extractor, not a general semantic judge. Unsupported questions stay open.
 * A general interest ("хочет попробовать пиццу") cannot be satisfied by hearing a random number.
 * Keep only a declarative price/duration answer in one utterance, never the whole transcript.
 */
export function concreteAnswer(question: string, speech: string): string | undefined {
  const price = /(?:сколько\s+стоит|почём|почем|какова\s+цена|какая\s+цена)/iu.test(question);
  const duration = /(?:сколько\s+(?:времени|длится|занимает)|как\s+долго)/iu.test(question);
  if (!price && !duration) return undefined;
  const anchors = semanticTokens(question.replace(/сколько|стоит|почём|почем|какова|какая|цена|времени|длится|занимает|как|долго/giu, ' '));
  if (!anchors.size) return undefined;
  const quantity = price
    ? /\d+(?:[.,]\d+)?\s*(?:юан|руб|доллар|евро|тенге|₽|\$|€)/iu
    : /\d+(?:[.,]\d+)?\s*(?:секунд|минут|час|дней|недел|месяц)/iu;
  const segments = speech.split(/(?=(?:^|\s)[SOU]:\s)/u);
  for (const segment of segments) {
    // Ambiguous speech and other speakers must not become streamer-attributed memories.
    if (/^\s*[OU]:/u.test(segment)) continue;
    for (const raw of segment.split(/(?<=[.!?])\s+|[\r\n]+/u)) {
      const sentence = raw.replace(/^\s*S:\s*/u, '').trim();
      if (!quantity.test(sentence) || /\?|не знаю|не помню|кажется|вроде|наверное|может|допустим|если|не уверен/iu.test(sentence)) continue;
      const words = semanticTokens(sentence);
      if ([...anchors].some((word) => words.has(word))) return sentence.slice(0, 360);
    }
  }
  return undefined;
}
