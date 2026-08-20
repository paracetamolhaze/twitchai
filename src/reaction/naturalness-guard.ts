import { StreamEvent } from '../stream-brain/types';

/**
 * The last check before a generated message becomes a chat message.
 *
 * The instruction already tells the model not to grade what it just heard, not to caption a scene
 * and not to hand back a paraphrase, and it mostly obeys. Mostly is the problem: across one
 * eleven-minute run it produced "Яндекс это мощно конечно" after the stream said "Yandex so good",
 * "нунун легенда без вопросов" after someone said "He's a legend", and "ровесники получается" after
 * two people established they were both 27. A rule the model follows nine times in ten is not a rule
 * the pipeline can rely on, and the tenth one is the message a viewer actually sees.
 *
 * So this is deterministic and local. No second model call: these failures have a computable shape,
 * and the ones that do not are left alone rather than guessed at. Rejection means silence for that
 * moment — nothing is rewritten and nobody else is asked to try instead, because a repaired version
 * of a message with no reaction in it is the same message with different words.
 *
 * A second live run, once activity was already at a reasonable level, showed two more versions of
 * the same failure. "добрее в доте ахах" after the stream said "чтобы все в Доте были добрее" reuses
 * two of its three words verbatim, and the third is a laugh — not a GENERIC_VERDICT, ENDORSEMENT or
 * INFERENCE_MARKER word, so none of the three specific rules fired, and a laugh on top does not make
 * an echo a reaction; `majority_echo` closes that by measuring how much of the message came from the
 * event directly rather than requiring the leftover to belong to a known marker set. "до конца надо"
 * after "я хочу до конца играть всегда" restates the same intent as a duty instead of a want, and
 * NECESSITY_MARKER gives semantic_echo the same reach for that shape it already had for "therefore".
 * Both stay narrow on purpose: `majority_echo` only applies at three content words or more, since a
 * single echoed word in a very short message is unremarkable ("готов" answering "ты готов?"), not
 * evidence of restating, and NECESSITY_MARKER excludes "стоит"/"следует" because both also mean
 * "costs" and "follows". "главное не отдаваться пока фармите" carries a negation and is exempted
 * above for the usual reason (a negation is very often a disagreement). Some cases stayed out of
 * reach deliberately: a paraphrase sharing no surface words with the event ("спокойно, без криков"
 * after "не гудите... не тильтуйте") needs meaning, not shape, and stays with the
 * instruction, same as a scene label always has.
 */
export type NaturalnessRejection =
  | 'semantic_echo'
  | 'borrowed_opinion'
  | 'generic_evaluator'
  | 'majority_echo';

export interface NaturalnessInput {
  message: string;
  event?: Pick<StreamEvent, 'type' | 'summary' | 'speech' | 'visualContext' | 'audience' | 'directMentions'>;
}

export interface NaturalnessVerdict {
  ok: boolean;
  reason?: NaturalnessRejection;
}

/**
 * Words whose only job is to say "and I rate that positively".
 *
 * Not a blacklist: each of these is ordinary Russian and appears in perfectly good messages. They
 * matter only as residue — what is left once everything the stream already said is removed. A
 * message that reduces to nothing but these was written to show the input was understood.
 */
const GENERIC_VERDICT = new Set([
  'мощно', 'мощна', 'мощь', 'сильно', 'солидно', 'достойно', 'красиво', 'хорошо', 'неплохо',
  'нормально', 'жёстко', 'жестко', 'круто', 'топ', 'база', 'класс', 'шикарно', 'отлично',
  'здорово', 'легенда', 'легендарно', 'уважение', 'респект', 'красава', 'молодец', 'молодцы',
]);

/** Agreement and certainty tails: "no question", "for sure", "of course", "absolutely". */
const ENDORSEMENT = new Set([
  'без', 'вопросов', 'сомнений', 'базара', 'конечно', 'точно', 'реально', 'правда', 'абсолютно',
  'полностью', 'согласен', 'согласна', 'соглашусь', 'верно', 'именно', 'однозначно', 'факт',
  'да', 'ага', 'угу', 'ну', 'вообще', 'прям', 'прямо', 'очень', 'самый', 'самое',
]);

/**
 * Markers of "therefore" — the message announces a conclusion drawn from what was just said.
 *
 * A shape, not a vocabulary: these are fine in a message that also carries something. They are the
 * signature of an echo only when the rest of the message is a single bare noun and there is no
 * question, no disagreement and no feeling anywhere in it.
 */
const INFERENCE_MARKER = new Set([
  'получается', 'получаются', 'выходит', 'значит', 'итого', 'короче', 'типа', 'сути',
]);

/**
 * Bare necessity, with nothing to say what for. "до конца надо" after "я хочу до конца играть
 * всегда": the event supplies the subject and "надо" restates the same intent as a duty instead of
 * a want, adding no reason of its own. Deliberately small and unambiguous — "стоит" and "следует"
 * are left out because both also mean "costs" and "follows", and a residue that happens to be one of
 * those words is as likely to be a real, substantive claim as a bare necessity marker.
 */
const NECESSITY_MARKER = new Set(['надо', 'нужно', 'необходимо', 'придется', 'придётся']);

const NEGATION = /(?:^|[^\p{L}])(?:не|нет|ни|неа|nope|not|no)(?![\p{L}])/iu;

/** Laughter, emotes, interjections, bare punctuation — a whole reaction with no content in it. */
const PURE_FEELING = /^(?:[\p{P}\p{S}\s]|[аa]*[хx][аaеeиiя]+|ах+|ох+|уф+|бля\p{L}*|о+|е+|ы+|kekw|lul|lol|pog\p{L}*|omegalul|monkas|sadge)+$/iu;

const STOP = new Set([
  'это', 'этот', 'эта', 'эти', 'тот', 'там', 'тут', 'здесь', 'как', 'что', 'чтобы', 'который',
  'уже', 'ещё', 'еще', 'бы', 'же', 'ли', 'и', 'а', 'но', 'или', 'в', 'на', 'с', 'по', 'за', 'у',
  'от', 'до', 'из', 'о', 'об', 'для', 'то', 'так', 'вот', 'он', 'она', 'они', 'мы', 'вы', 'я',
  'его', 'её', 'ее', 'их', 'them', 'the', 'is', 'it', 'and', 'to', 'of', 'in', 'so', 'yeah',
]);

/** Every observed instance was five words or fewer; past this the extra words carry something. */
const MAX_SUSPECT_WORDS = 6;

/**
 * Below this many content words, one of them matching the event is unremarkable rather than
 * suspicious — "готов" answering "ты готов?" is a normal one-word reply, not an echo, and the ratio
 * below has no room to tell a real short reaction from a coincidence at one or two words. Majority
 * echo only applies once there is enough of a message for "most of it is the event" to mean anything.
 */
const MIN_WORDS_FOR_MAJORITY_ECHO = 3;

/**
 * How much of a short message can already be the event's own words before what remains reads as
 * restating it rather than reacting to it. Half plus everything left over failing to add a new
 * stance is the same bar `borrowed_opinion` and `generic_evaluator` already apply to their own
 * narrower residue categories; this measures the same thing directly instead of requiring the
 * leftover word to be a member of a specific marker set.
 */
const MAJORITY_ECHO_RATIO = 0.5;

export class NaturalnessGuard {
  /** Whether this is a reaction, or only a demonstration that the input was understood. */
  check(input: NaturalnessInput): NaturalnessVerdict {
    const message = input.message.trim();
    const words = contentWords(message);
    // An emote, a laugh, a bare "?????" is a complete reaction and always passes.
    if (words.length === 0 || PURE_FEELING.test(message)) return { ok: true };
    // A question asks for something, and a negation is very often a disagreement or a correction —
    // the two cases most easily mistaken for an echo, because both reuse the subject by nature.
    if (/[?？]/.test(message) || NEGATION.test(message)) return { ok: true };

    const event = input.event;
    if (!event) return { ok: true };
    // Being spoken to changes what counts as a reaction: an answer repeats the question's words by
    // nature, and "олды на месте" to "Garena, you know what is this?" is exactly right.
    if ((event.directMentions?.length ?? 0) > 0 || event.audience === 'twitch_chat') return { ok: true };
    if (words.length > MAX_SUSPECT_WORDS) return { ok: true };

    const heard = eventKeys(event);
    const residue = words.filter((word) => !heard.has(word.key) && !matchesLoosely(word.key, heard));
    const echoed = words.length - residue.length;

    const verdict = residue.filter((word) => GENERIC_VERDICT.has(word.raw));
    const endorsement = residue.filter((word) => ENDORSEMENT.has(word.raw));
    const inference = residue.filter((word) => INFERENCE_MARKER.has(word.raw));
    const necessity = residue.filter((word) => NECESSITY_MARKER.has(word.raw));
    const substantive = residue.filter((word) => !GENERIC_VERDICT.has(word.raw) && !ENDORSEMENT.has(word.raw)
      && !INFERENCE_MARKER.has(word.raw) && !NECESSITY_MARKER.has(word.raw));

    // Subject from the stream plus a grade, and nothing else. "Яндекс это мощно конечно".
    if (echoed > 0 && verdict.length > 0 && substantive.length === 0) {
      return { ok: false, reason: 'generic_evaluator' };
    }

    // The stream already said the opinion; this repeats it and stamps it. "нунун легенда без
    // вопросов" after "He's a legend": the subject came from the event, the verdict came from the
    // event, and what the account added was agreement.
    if (echoed > 0 && endorsement.length > 0 && substantive.length <= 1
      && (verdict.length > 0 || alreadyJudged(event))) {
      return { ok: false, reason: 'borrowed_opinion' };
    }

    // A conclusion the stream had already reached, announced as though it were news — or the same
    // intent handed back as a duty. "ровесники получается" after "27 too / Same? / Yeah, same": one
    // bare noun restating it, and a marker saying the message is reporting rather than reacting. "до
    // конца надо" after "я хочу до конца играть всегда": the same shape with a necessity marker
    // standing in for the conclusion marker.
    if ((inference.length > 0 || necessity.length > 0) && verdict.length === 0 && substantive.length <= 1) {
      return { ok: false, reason: 'semantic_echo' };
    }

    // Most of a short message is the event's own words, and no marker word explains the rest — the
    // gap the three rules above leave, since they only fire when the leftover happens to be a
    // GENERIC_VERDICT/ENDORSEMENT/INFERENCE_MARKER word. "добрее в доте ахах" after "чтобы все в
    // Доте были добрее": two of three words are the event's own, and a laugh is not a new thought.
    if (words.length >= MIN_WORDS_FOR_MAJORITY_ECHO && echoed / words.length >= MAJORITY_ECHO_RATIO) {
      return { ok: false, reason: 'majority_echo' };
    }

    // Scene labels are deliberately not here. "Планёрка на улице пошла" and "чисто домашний вайб
    // пошел ахах" reduce to a novel noun over scene words, and nothing local separates that from
    // "у него рюкзак больше него" — which is the same shape and a perfectly good joke. A rule that
    // fires on one and not the other would have to know what планёрка means. That class stays with
    // the instruction, which can at least reason about it.
    return { ok: true };
  }
}

interface Word { raw: string; key: string }

function contentWords(value: string): Word[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => !STOP.has(word))
    .map((word) => ({ raw: word, key: translitKey(word) }));
}

function eventKeys(event: NaturalnessInput['event']): Set<string> {
  const text = [event?.summary, event?.speech, event?.visualContext].filter(Boolean).join(' ');
  const keys = new Set<string>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!STOP.has(word)) keys.add(translitKey(word));
  }
  return keys;
}

/** Whether the stream itself already passed judgement, in either language. */
function alreadyJudged(event: NaturalnessInput['event']): boolean {
  const text = [event?.summary, event?.speech].filter(Boolean).join(' ').toLowerCase();
  if (/(?:^|[^\p{L}])(?:legend|goat|insane|amazing|great|awesome|best|beast|respect|nice|good)(?![\p{L}])/iu.test(text)) {
    return true;
  }
  return (text.match(/[\p{L}]+/gu) ?? []).some((word) => GENERIC_VERDICT.has(word));
}

/**
 * A comparison key that survives crossing the alphabet.
 *
 * This stream is two people speaking English and Russian at each other, and the failures reflected
 * it: the event said "Yandex" and the message said "Яндекс"; the event said "No[o]ne" and the
 * message said "нунун". Token equality sees nothing in common there. Transliterating both to Latin
 * and allowing a small edit distance sees what a reader sees, and costs no dependency.
 */
function translitKey(word: string): string {
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

function matchesLoosely(key: string, heard: Set<string>): boolean {
  if (key.length < 4) return false;
  const limit = key.length >= 6 ? 2 : 1;
  for (const candidate of heard) {
    if (candidate.length < 4 || Math.abs(candidate.length - key.length) > limit) continue;
    if (withinEditDistance(key, candidate, limit)) return true;
  }
  return false;
}

function withinEditDistance(left: string, right: string, limit: number): boolean {
  if (Math.abs(left.length - right.length) > limit) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost));
      best = Math.min(best, current[j]!);
    }
    if (best > limit) return false;
    previous = current;
  }
  return previous[right.length]! <= limit;
}
