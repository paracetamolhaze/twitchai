/**
 * Detection of explicit invitations to the whole chat — the moments where one polished reply from
 * one account is the UNNATURAL outcome.
 *
 * Production fixture: «Скажите, пожалуйста, меня слышно? Если да, киньте плюсик в чат» reached the
 * Brain as an ordinary moment and produced exactly one «+ слышно» from twenty-four eligible
 * viewers; «...тоже расскажите, что вам было полезным...» was audience=unclear because the chat
 * was not NAMED. Both are the streamer talking to everyone, and everyone answering with one voice
 * is what makes a room read as fake.
 *
 * Morphology, not a phrase blacklist: Russian addresses a crowd with second-person-plural
 * imperatives («киньте», «расскажите», «ставьте») and plural pronouns («вам», «вас»), and those
 * are word shapes, not phrases. A handful of constrained-response markers (plus/minus, digits,
 * да/нет) then separates "show of hands" from "tell me what you think". Deterministic, local,
 * zero model calls — it refines what perception already produced, never replaces it.
 */

export const CHAT_CALL_KINDS = [
  'binary_check', 'poll', 'show_of_hands', 'open_feedback',
  'general_question', 'request_for_opinion', 'request_for_confirmation',
] as const;

export type ChatCallKind = typeof CHAT_CALL_KINDS[number];

/** Kinds whose natural answers are short and repeated: +, -, да, цифра. Identical short replies
 *  from different people are the EXPECTED shape here, not an AI chorus. */
export function isConstrainedCall(kind: ChatCallKind): boolean {
  return kind === 'binary_check' || kind === 'poll' || kind === 'show_of_hands'
    || kind === 'request_for_confirmation';
}

/** A reply of the shape a constrained call asks for: bare punctuation ('+'), or a couple of tokens
 *  of confirmation vocabulary / digits. Anything longer is commentary and gets no duplicate leeway. */
export function isConstrainedReply(message: string): boolean {
  const tokens = message.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return message.trim().length > 0 && message.trim().length <= 8;
  if (tokens.length > 3) return false;
  const CONFIRM = /^(?:да|нет|неа|ага|угу|плюс|минус|слышно|видно|норм|нормально|отлично|хорошо|тихо|громко|\d+|[аa-dабвг])$/iu;
  return tokens.every((token) => CONFIRM.test(token));
}

/** The chat named directly — the strongest single marker, same vocabulary perception already uses. */
const NAMES_THE_CHAT = /(?:^|[^\p{L}])(?:чат|чатик|чатики|ребят|ребята|народ|парни|пацаны|зрител\p{L}*|guys|chat)(?![\p{L}])/iu;

/**
 * Second-person-plural imperative stems of invitation verbs. Stems plus «-те», so «киньте»,
 * «кидайте», «напишите», «пишите», «расскажите», «ставьте», «голосуйте», «выберите», «скажите»
 * all match as WORD SHAPES — this is the Russian grammar of addressing a group, not a phrase list.
 */
const INVITES_2PL = /(?:^|[^\p{L}])(?:кинь|кида|став|пост?авь|пиш|напиш|расскаж|скаж|говор|голосу|выбер|выбира|жм|нажм|отправ|подел|дай|дава)\p{L}*те(?![\p{L}])/iu;

/** Constrained response requested: a plus/minus, a digit, yes/no, option letters. */
const CONSTRAINED_TOKEN = /(?:^|[^\p{L}\p{N}])(?:плюс\p{L}*|минус\p{L}*|\+|-|цифр\p{L}*|1 или 2|один или два|да или нет)(?![\p{L}])/iu;

/** Show-of-hands pronouns: «кто за», «кто ещё», «у кого». */
const WHO_AMONG_YOU = /(?:^|[^\p{L}])(?:кто|у кого|кому)(?![\p{L}])/iu;

/** Hortative first-person plural — «ставим +», «кидаем плюсы»: the streamer counting the room in. */
const HORTATIVE_1PL = /(?:^|[^\p{L}])(?:став|кида|жм|голосу)\p{L}*[её]?м(?![\p{L}])/iu;

/** Opinion asked of «you» plural: «как вам», «что думаете», «вам нравится», «что понравилось». */
const ASKS_YOUR_OPINION = /(?:как|что|чё|че)[^.!?\n]{0,30}(?:вам|вы|думаете|считаете|понравил\p{L}*|нравится|зашл\p{L}*)|(?:вам|вы)[^.!?\n]{0,20}(?:нравится|понравил\p{L}*|думаете|считаете)/iu;

/** Self-check questions every IRL stream asks the room: «меня слышно?», «видно меня?». */
const HEARING_CHECK = /(?:меня|мен я)?\s*(?:слышно|видно|слышите|видите)\s*(?:меня)?\s*[?？]/iu;

/**
 * Whether this speech explicitly invites the whole chat to answer, and in what shape. Undefined
 * for everything else — an ordinary moment stays an ordinary moment, and the caller's silence
 * rules stay exactly as they were.
 */
export function detectChatCall(text: string): ChatCallKind | undefined {
  if (!text.trim()) return undefined;
  const namesChat = NAMES_THE_CHAT.test(text);
  const invites = INVITES_2PL.test(text);
  const constrained = CONSTRAINED_TOKEN.test(text);
  const opinion = ASKS_YOUR_OPINION.test(text);
  const hearing = HEARING_CHECK.test(text);
  const whoAmongYou = WHO_AMONG_YOU.test(text) && /[?？]/.test(text);

  // «киньте плюс», «ставьте +», «выберите один или два» — an explicit constrained request.
  if (invites && constrained) return hearing ? 'binary_check' : /выбер|или/iu.test(text) ? 'poll' : 'show_of_hands';
  // «ставим + если идём» — the streamer counting the room in, first person plural.
  if (HORTATIVE_1PL.test(text) && constrained) return 'show_of_hands';
  // «меня слышно? киньте плюсик» without the invite verb still is a check aimed at the room.
  if (hearing && (namesChat || constrained)) return 'binary_check';
  // «расскажите, что вам понравилось», «напишите что думаете» — open invitation to speak.
  if (invites && (opinion || namesChat)) return 'open_feedback';
  // «как вам рум-тур?», «вам нравится?» — opinion asked of the plural you.
  if (opinion && /[?？]/.test(text)) return 'request_for_opinion';
  // «кто за?», «у кого так было?», «кто ещё здесь?»
  if (whoAmongYou && (namesChat || invites || /за\s*[?？]|ещё|еще|так было/iu.test(text))) return 'show_of_hands';
  // The chat named plus a question or an invite verb: a general address to the room.
  if (namesChat && /[?？]/.test(text)) return hearing ? 'binary_check' : 'general_question';
  if (namesChat && invites) return 'open_feedback';
  // A bare invite imperative with no other signal: asking the room to say/write something.
  if (invites && /(?:честно|мнение|что думаете)/iu.test(text)) return 'request_for_opinion';
  return undefined;
}

/**
 * The social participation band for a confirmed call: how many bot voices are PLAUSIBLE, given how
 * the real room is already answering. Ceilings, never targets — the Brain still decides who has a
 * reason, and zero remains a legal outcome.
 */
export function crowdResponseCeiling(kind: ChatCallKind, humanRepliesRecent: number): number {
  // The real audience is already flooding the answer; bots add a voice or two, not a second wave.
  if (humanRepliesRecent >= 6) return 2;
  if (isConstrainedCall(kind)) return 6;
  return kind === 'open_feedback' ? 4 : 3;
}
