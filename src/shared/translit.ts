/**
 * A comparison key that survives crossing the alphabet.
 *
 * This stream is people speaking English and Russian at each other, and matching failures reflect
 * it: an event says "Yandex" and a message says "Яндекс"; canon says "Dota 2" and speech says
 * "доту". Token equality sees nothing in common. Transliterating to Latin and collapsing doubled
 * letters sees what a reader sees, and costs no dependency.
 *
 * Moved here from NaturalnessGuard unchanged, because topic matching needs the same key the guard
 * has always used — two implementations of "same word across alphabets" would quietly disagree.
 */
export function translitKey(word: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  let key = '';
  for (const letter of word) key += map[letter] ?? letter;
  // Doubled letters survive no transliteration intact ("No[o]ne" spoken back as "нунун").
  return key.replace(/(.)\1+/gu, '$1');
}
