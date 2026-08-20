const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

export function normalizeMessage(value: string): string {
  return (value.toLowerCase().match(TOKEN_PATTERN) ?? []).join(' ');
}

/** The token set `tokenSimilarity` compares, exposed so a caller comparing one message against many
 *  can tokenize each side once instead of re-tokenizing on every pair. */
export function messageTokens(value: string): Set<string> {
  return new Set(normalizeMessage(value).split(' ').filter(Boolean));
}

export function tokenSimilarity(left: string, right: string): number {
  return tokenSetSimilarity(messageTokens(left), messageTokens(right));
}

/** Jaccard overlap of two already-tokenized messages. */
export function tokenSetSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  // Iterate the smaller set: the result is symmetric and this bounds the work by the shorter message.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (large.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Matches a chat echo back to the stored record it came from, ignoring whitespace differences. */
export function normalizeForLookup(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}
