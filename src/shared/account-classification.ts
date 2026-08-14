const ACCOUNT_KIND = String.raw`(?:бот(?:ы|ик(?:а|у|ом|е)?|а|у|ом|е|ов|ами|ах)?|bot(?:s)?|нейронк[\p{L}\p{N}_]*|нейросет[\p{L}\p{N}_]*|искусственн[\p{L}\p{N}_]*\s+интеллект|(?<![\p{L}\p{N}_])ии(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])ai(?![\p{L}\p{N}_])|chatgpt|(?<![\p{L}\p{N}_])gpt(?![\p{L}\p{N}_])|gemini)`;
const RUSSIAN_QUALIFIER = String.raw`(?:настоящ[\p{L}\p{N}_]*|реальн[\p{L}\p{N}_]*|искусственн[\p{L}\p{N}_]*|синтетическ[\p{L}\p{N}_]*|автоматизированн[\p{L}\p{N}_]*)`;
// A classification predicate has to end here. This keeps "ты Gemini используешь?"
// and other ordinary product discussions out of the account-classification flow.
const RUSSIAN_CLASSIFICATION_END = String.raw`(?:\s+(?:или\s+нет|да|нет|вообще|вед[ьи]|реально|на\s+самом\s+деле|в\s+чате|тут|здесь|на\s+стриме|запомни(?:те)?))*\s*(?=$|[?!.,;:])`;
const DIRECT_RUSSIAN = new RegExp(String.raw`(?:^|[^\p{L}\p{N}_])(?:ты|вы)(?:\s+${RUSSIAN_QUALIFIER})*\s+(?:не\s+)?${ACCOUNT_KIND}${RUSSIAN_CLASSIFICATION_END}`, 'iu');
const REVERSED_RUSSIAN = new RegExp(String.raw`(?:^|[^\p{L}\p{N}_])${ACCOUNT_KIND}\s+(?:ли\s+)?(?:ты|вы)${RUSSIAN_CLASSIFICATION_END}`, 'iu');
const INDIRECT_RUSSIAN = new RegExp(String.raw`(?:^|[^\p{L}\p{N}_])(?:это|этот|эта)(?:\s+аккаунт)?\s*(?:[—:-]\s*)?(?:не\s+)?${ACCOUNT_KIND}${RUSSIAN_CLASSIFICATION_END}|(?:^|[^\p{L}\p{N}_])аккаунт\s+(?:это\s+)?(?:не\s+)?${ACCOUNT_KIND}${RUSSIAN_CLASSIFICATION_END}`, 'iu');
const ENGLISH = new RegExp(String.raw`(?:are\s+you|you\s+are|is\s+this(?:\s+account)?|this\s+account\s+is)\s+(?:not\s+)?(?:an?\s+)?${ACCOUNT_KIND}\s*(?=$|[?!.,;:])`, 'iu');

/**
 * Detects a question that classifies the addressed account itself. Product
 * discussion such as "ты пробовал Gemini для кода?" deliberately does not match.
 */
export function isAccountClassificationQuestion(value: string): boolean {
  // A Twitch mention is an address, not a predicate. Without this normalization
  // "@bot ты пробовал Gemini?" looks like the reversed phrase "бот ты".
  const normalized = value.replace(/@[\p{L}\p{N}_-]+/gu, ' ').toLowerCase();
  return DIRECT_RUSSIAN.test(normalized)
    || REVERSED_RUSSIAN.test(normalized)
    || INDIRECT_RUSSIAN.test(normalized)
    || ENGLISH.test(normalized);
}
