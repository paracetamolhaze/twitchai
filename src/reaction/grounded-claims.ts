/** Narrow, auditable checks; not an attempt to infer arbitrary facts with keyword bans. */
export function unsupportedAudienceClaim(message: string, eventText: string): boolean {
  const audienceQuestion = /(?:зрител|аудитори)/iu.test(eventText)
    && /(?:%|процент|дол[яию]|сколько)/iu.test(eventText) && /[?]/u.test(eventText);
  if (!audienceQuestion || /[?]|кажется|думаю|наверно|возможно|похоже|не знаю/iu.test(message)) return false;
  return /(?:больше|меньше|большинство|половин)/iu.test(message)
    && /(?:точно|намного|обычно|явно|очевидно)/iu.test(message);
}

export function sameBatchClaim(left: string, right: string): boolean {
  const words = (s: string): string[] => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(w => !['да', 'ну', 'это', 'же', 'точно', 'вообще', 'намного', 'обычно'].includes(w));
  const a = words(left), b = words(right);
  // Keep negation: “не больше” and “больше” must never collapse into the same opinion.
  return a.length >= 2 && b.length >= 2 && new Set(a).size === new Set(b).size
    && a.every(w => b.includes(w));
}
