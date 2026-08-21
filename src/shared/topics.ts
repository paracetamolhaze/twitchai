import { relevanceScore, semanticTokens } from '../personas/persona-memory';
import { translitKey } from './translit';

/**
 * One name for one thing, across alphabets and Russian case endings.
 *
 * The bug this exists for is central, not cosmetic: canon says "Dota 2", the stream says "доту",
 * and every token-based matcher in the pipeline treated them as unrelated — so on a Dota channel
 * the mind slice for the channel's main topic never fired. Transliteration alone does not close it
 * ("доту" → "dotu" ≠ "dota"), and a general Russian stemmer would buy the match at the price of
 * false ones ("дот" also opens "дотянул"). So the registry lists explicit surface forms for the
 * handful of topics this channel actually lives on, and every listed form maps to one canonical id
 * that both sides of any comparison see.
 *
 * Deliberately small and deliberately exact: an alias matches a token by full equality only, which
 * makes a registry entry incapable of collision by construction. Extending it is adding a line, not
 * tuning a model.
 */
interface CanonicalTopic {
  id: string;
  aliases: string[];
}

const TOPIC_REGISTRY: CanonicalTopic[] = [
  {
    id: 'dota2',
    aliases: [
      'dota', 'dota2', 'дота', 'доту', 'доте', 'доты', 'дотой', 'дотан',
      'дотка', 'дотке', 'дотку', 'дотки', 'дотерс', 'дотер', 'дотеры',
    ],
  },
  {
    id: 'china',
    aliases: ['china', 'китай', 'китае', 'китая', 'китаю', 'китаем', 'китайский', 'китайская', 'китайское', 'китайцы'],
  },
  {
    id: 'shanghai',
    aliases: ['shanghai', 'шанхай', 'шанхае', 'шанхая', 'шанхаю', 'шанхаем', 'шанхайский'],
  },
  {
    id: 'cs2',
    aliases: ['cs', 'cs2', 'кс', 'кску', 'ксе', 'контра', 'контру', 'контре', 'counterstrike'],
  },
  {
    id: 'twitch_stream',
    aliases: ['twitch', 'твич', 'твиче', 'твича', 'стрим', 'стрима', 'стриме', 'стримы', 'стримов'],
  },
];

const ALIAS_TO_ID = new Map<string, string>();
for (const topic of TOPIC_REGISTRY) {
  for (const alias of topic.aliases) ALIAS_TO_ID.set(alias.toLowerCase(), topic.id);
}

/** Registered canonical ids present in a text — exact alias hits only, no stemming, no guessing. */
export function canonicalTopicIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const id = ALIAS_TO_ID.get(word);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * A text expanded so that existing token matchers see across scripts and known aliases: the
 * original words, plus a transliterated copy of each, plus any canonical topic ids the words map
 * to. Both sides of a comparison get the same expansion, so "Dota 2" and "доту" both carry
 * "dota2" and meet there, while unregistered vocabulary still meets through transliteration
 * ("стефан"/"stefan") or plain tokens exactly as before.
 */
export function expandTopicText(text: string): string {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const extras: string[] = [];
  for (const word of words) {
    const translit = translitKey(word);
    if (translit !== word && translit.length >= 3) extras.push(translit);
    const id = ALIAS_TO_ID.get(word);
    if (id) extras.push(id);
  }
  return extras.length > 0 ? `${text} ${extras.join(' ')}` : text;
}

/** Token set of the expanded text — a drop-in for semanticTokens where topics must bridge scripts. */
export function topicTokens(text: string): Set<string> {
  return semanticTokens(expandTopicText(text));
}

/**
 * A registry hit is a curated statement that two texts are about the same subject, and it must not
 * be dilutable: expansion adds tokens to both sides, relevanceScore normalizes by size, and on a
 * long moment a genuine "dota2 on both sides" was scoring 0.06 — under every retrieval threshold in
 * the pipeline. The floor sits above all of them (mind retrieval 0.1, its half-watching multiple
 * 0.15, topic rules 0.15) so an explicit alias match always counts as topical, while everything
 * else keeps the token arithmetic unchanged.
 */
const CANONICAL_MATCH_FLOOR = 0.3;

/**
 * relevanceScore with both sides expanded — the shared yardstick for "is this mind entry / interest
 * / rule about this moment", so attention, mind retrieval, observation and topic-scoped learned
 * rules cannot quietly disagree about what counts as the same subject.
 */
export function topicRelevance(queryText: string, documentText: string): number {
  const score = relevanceScore(topicTokens(queryText), expandTopicText(documentText));
  if (score >= CANONICAL_MATCH_FLOOR) return score;
  const queryIds = canonicalTopicIds(queryText);
  if (queryIds.size === 0) return score;
  const documentIds = canonicalTopicIds(documentText);
  for (const id of queryIds) {
    if (documentIds.has(id)) return CANONICAL_MATCH_FLOOR;
  }
  return score;
}
