const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

export function normalizeMessage(value: string): string {
  return (value.toLowerCase().match(TOKEN_PATTERN) ?? []).join(' ');
}

export function tokenSimilarity(left: string, right: string): number {
  const a = new Set(normalizeMessage(left).split(' ').filter(Boolean));
  const b = new Set(normalizeMessage(right).split(' ').filter(Boolean));
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}
