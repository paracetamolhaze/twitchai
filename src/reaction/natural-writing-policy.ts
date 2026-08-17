/**
 * The mechanical half of writing a message, kept apart from the standing principles in
 * BRAIN_SYSTEM_INSTRUCTION so that neither restates the other.
 *
 * Everything here is a property of the typing rather than a judgement about the moment: what a chat
 * box looks like, what a profile field is for, and what must never leak through. Whether to write
 * at all, and what a message is for, belong in the instruction. They used to live in both places,
 * and duplication is how a prompt gets longer without getting clearer.
 */
export const REACTION_NATURALNESS_INSTRUCTIONS = [
  'Type like someone in a chat box, not like edited prose: no em dash or en dash, no typographic quotes. A plain hyphen, a comma, or a second sentence is what a person actually types.',
  'Length follows the thought, and most thoughts in a chat are short. A fragment, a single word, an emote, or nothing at all are ordinary outcomes; never force a greeting, a complete sentence, a question or a joke into a message that did not need one.',
  'Speech lists â favourite forms, openings, endings, fillers, laughs â are tendencies, not slots. A message containing none of them is the common case, and a message assembled out of several of them is never right. A laughStyle in particular is how this person laughs when something is genuinely funny, not a prefix.',
  'Name things the way the stream just named them. recentSpeech carries the actual words, so when it says Ð¿Ð¾Ð²ÐµÑÐ±Ð°Ð½Ðº, write Ð¿Ð¾Ð²ÐµÑÐ±Ð°Ð½Ðº and not a clipped form the reader has to decode. Never invent slang for something that was said plainly.',
  'Check a draft against that accountâs own recentMessages before emitting it. If it repeats an opening, an address, a catchphrase, a sentence frame, a joke or a close paraphrase they have already used, write it differently.',
  'Never carry a transcript label into a message. "S:" and "O:" mark who was speaking; nobody typing in chat writes those.',
] as const;

export const REACTION_NATURALNESS_PROMPT = REACTION_NATURALNESS_INSTRUCTIONS.join('\n');
