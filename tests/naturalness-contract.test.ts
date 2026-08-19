import { describe, expect, it } from 'vitest';
import { BRAIN_SYSTEM_INSTRUCTION } from '../src/brain/gemini-brain.service';
import { generatePersonaV3 } from '../src/personas/generator-v3';
import { PersonaContextBuilder } from '../src/personas/persona-context-builder';
import { PersonaMemory } from '../src/personas/persona-memory';
import { PersonaRuntimeStore } from '../src/personas/persona-runtime-store';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { REACTION_NATURALNESS_INSTRUCTIONS, REACTION_NATURALNESS_PROMPT } from '../src/reaction/natural-writing-policy';
import { ReactionPolicyGuard } from '../src/reaction/reaction-policy-guard';

const snapshotBuilder = new PersonaContextBuilder(
  new PersonaMemory(new MemoryRepository(), { now: () => 1_700_000_000_000 }),
  new PersonaRuntimeStore(() => 1_700_000_000_000),
);

/**
 * What the decision layer is told, asserted as a contract.
 *
 * Generation is probabilistic and no test can demand a particular sentence from it, but the
 * instruction it works from is a deterministic artefact — and every naturalness regression in this
 * project so far was a property of that artefact rather than bad luck in sampling. These cases pin
 * the principles that must be present, and the shapes that must not come back.
 */
describe('what the brain is told about writing like a viewer', () => {
  it('puts the moment before the person, and never the person before the line', () => {
    // The failure this prevents: reaching for a personality and producing a line that displays it.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('Decide in this order');
    // "anyone watching" read as one averaged viewer; the payload is a specific, shortlisted roster,
    // and the instruction now says so.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('whether one of these particular people would react to it');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('Never work the other way round');
  });

  it('counts feeling as reason enough, not only information', () => {
    // A rule requiring every message to add something the stream did not contain forbids laughing,
    // which is one of the most common real things in a chat.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('or it carries feeling');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('one alone is enough');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('does not have to be witty or complete');
    expect(BRAIN_SYSTEM_INSTRUCTION).not.toContain('earns its place only by adding something');
  });

  it('treats silence as the ordinary outcome for every account, including on a quiet chat', () => {
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('reactions: [] is a complete answer');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('silence here is frequent and correct');
    // The framing that produced filler: a supplied opportunity read as an obligation.
    for (const removed of ['turn to speak, not a question of whether to', 'quiet is the failure', 'never as the safe default']) {
      expect(BRAIN_SYSTEM_INSTRUCTION).not.toContain(removed);
    }
  });

  it('does not make a moment earn the right to be reacted to', () => {
    // The overcorrection the first rewrite produced: silence was framed as needing no reason and a
    // message as needing one, so five of thirty-one moments got an answer over ten live minutes.
    // Ordinary chat is mostly unremarkable and that is not a defect in it.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('not whether the moment was special enough to deserve it');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('allowed to be small, obvious and unremarkable');
  });

  it('forbids filler by where the message came from, not by how small it is', () => {
    // Both failures produce a short line. The difference is whether the moment or the empty chat
    // came first, and that is the only thing the instruction is allowed to test on.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('because the chat looked empty and something had to go in it');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('whether the moment came first');
  });

  it('never lets a candidate state read as an instruction to stay quiet', () => {
    // candidateStates used to carry a raw eventSelectivity next to the fit signal — 0.96 for one of
    // the live accounts — which is a second cooldown applied to a candidate the backend had already
    // cleared. Fit may argue for speaking; nothing in that block may argue against it.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('never as a reason for everyone to stay quiet');
    expect(BRAIN_SYSTEM_INSTRUCTION).not.toContain('how selective they are');
  });

  it('refuses having been quiet as a reason to be chosen', () => {
    // Rotation wearing the clothes of a judgement: a moment nobody cares about does not become
    // interesting because it is somebody's turn.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('Having been quiet is not a reason');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('may break a tie');
    expect(BRAIN_SYSTEM_INSTRUCTION).not.toContain('weaker choice against one who has been listening');
  });

  it('describes a profile as tendencies, with most messages carrying none of its markers', () => {
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('tendencies, not requirements');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('most of their messages contain none of them');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('never assemble a message out of those parts'.replace('never', 'Never'));
  });

  it('says a direct mention raises the odds without making an answer automatic', () => {
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('direct mention makes an answer likely, not automatic');
  });

  it('asks memory to change the opinion rather than be announced', () => {
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('rather than being something to mention');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('Never say that you remember something');
  });

  it('carries no bugfix examples from single production incidents', () => {
    // Their meaning is kept as principles; the incidents themselves belong in tests. A prompt that
    // collects one example per regression gets longer without getting clearer, and this one had
    // grown to a paragraph about a restaurant.
    for (const incident of [
      'sashimi', 'chips hold up', 'shrimp', 'суп там в центре', 'начали наконец', 'палочками',
      'повербанк', 'как дела?', 'чат вы где?', 'опять кого-то ждём',
    ]) {
      expect(BRAIN_SYSTEM_INSTRUCTION).not.toContain(incident);
    }
  });

  it('stays short enough to be read as principles rather than skimmed as a rulebook', () => {
    // It reached 11k characters as a list of one-off prohibitions with a restaurant example each.
    // The real guard against that is the no-bugfix-examples case below and the cap on style rules;
    // this one is a budget. It was raised once, when grounding, addressee and evaluator principles
    // arrived, and it is now nearly spent on purpose: adding a principle from here means finding
    // something redundant to cut, which is the pressure that keeps this a set of principles. If this
    // case fails, trim — do not move the number again.
    //
    // Measured without the interpolated style rules, which have their own cap: sharing one budget
    // meant a principle and a typing rule competed for the same room.
    const instructionOnly = BRAIN_SYSTEM_INSTRUCTION.length - REACTION_NATURALNESS_PROMPT.length;
    expect(instructionOnly).toBeLessThan(10_000);
    // And it stays a set of principles rather than a growing enumeration.
    expect(BRAIN_SYSTEM_INSTRUCTION.split('\n\n').length).toBeLessThanOrEqual(22);
  });

  it('keeps the mechanical rules apart from the judgement, and says each thing once', () => {
    expect(REACTION_NATURALNESS_INSTRUCTIONS.length).toBeLessThanOrEqual(8);
    // Judgement about whether to write belongs to the instruction; this list is about typing.
    for (const duplicated of ['caption', 'not commenters', 'adds nothing']) {
      expect(REACTION_NATURALNESS_PROMPT).not.toContain(duplicated);
    }
    // And the two things that only ever worked as mechanical rules stay mechanical.
    expect(REACTION_NATURALNESS_PROMPT).toContain('no em dash or en dash');
    expect(REACTION_NATURALNESS_PROMPT).toContain('"S:" and "O:"');
  });

  it('allows a bare emotional reaction by not requiring a complete thought', () => {
    // "ахахахах", "не", "??????" are ordinary chat and must not be ruled out by construction.
    expect(REACTION_NATURALNESS_PROMPT).toContain('A fragment, a single word, an emote, or nothing at all');
    expect(REACTION_NATURALNESS_PROMPT).toContain('never force a greeting, a complete sentence, a question or a joke');
  });
});

/**
 * Cases taken from a ten-minute live run on a real channel: four connected accounts, thirty-one
 * moments, five messages. Two of those messages were the target quality ("в шанхае шаурму искать
 * это сильно", "Баранина"); one opened with a canonical laugh token lifted out of its own profile.
 *
 * None of these assert an exact generated string — generation is probabilistic and pinning its
 * output would be a test of the sampler. They assert what the layers underneath hand it, which is
 * where each of these failures actually lived.
 */
describe('what the live run showed', () => {
  it('does not hand the model a literal laugh token to paste in front of a thought', () => {
    // "ХА. Это ещё постараться надо" — canon has laughStyles ["ХА","хех"] and a message example
    // "ХА. вот это учёт", so the same two characters arrived twice and came back as a prefix.
    const persona = generatePersonaV3('supercser2');
    expect(persona.speech.laughStyles).toContain('ХА');

    const fingerprint = snapshotBuilder.buildBrainSnapshot('supercser2', persona).speechFingerprint;
    expect(fingerprint).not.toContain('ХА');
    expect(fingerprint).not.toContain('хех');
    // The tendency survives; only the quotable form is gone.
    expect(fingerprint).toContain('смеётся');
  });

  it('keeps every account free of a signature phrase in its own examples', () => {
    // The greedy diverse pick always kept the first survivor, and authors write the catchphrase
    // first, so the most anchoring line in a profile was guaranteed a slot for every character.
    for (const username of ['supercser2', 'gigantiuz', 'novostro1ka', '404notf0und404']) {
      const persona = generatePersonaV3(username);
      const shown = snapshotBuilder.buildBrainSnapshot(username, persona).speechFingerprint
        .split('как выглядят его сообщения в среднем, не что писать: ')[1] ?? '';
      expect(shown).not.toBe('');
      for (const example of shown.split(' / ')) {
        for (const marker of [...persona.speech.laughStyles, ...persona.speech.favoriteExpressions]) {
          expect(example.toLowerCase().startsWith(marker.toLowerCase())).toBe(false);
        }
      }
    }
  });

  it('does not duplicate a signature phrase into the ordinary vocabulary line', () => {
    // The persona factory builds vocabulary as favourites ∪ fillers ∪ abbreviations, so a phrase
    // labelled "изредка" was also listed as everyday vocabulary a line earlier.
    const persona = generatePersonaV3('supercser2');
    const fingerprint = snapshotBuilder.buildBrainSnapshot('supercser2', persona).speechFingerprint;
    const vocabulary = fingerprint.split('лексика: ')[1]?.split(';')[0] ?? '';
    for (const favourite of persona.speech.favoriteExpressions) {
      expect(vocabulary).not.toContain(favourite);
    }
  });

  it('sends no restraint the backend has already applied for the model to apply again', () => {
    // Canon keeps both; the payload must not. eventSelectivity 0.96 next to a cooldown the guard has
    // already enforced is the same refusal counted twice, and chatFrequency 'very-low' next to the
    // weighting Persona Drive already did with it is the second instance of the same mistake.
    const persona = generatePersonaV3('404notf0und404');
    expect(persona.behavior.activity.eventSelectivity).toBeGreaterThan(0.9);
    expect(persona.behavior.activity.chatFrequency).toBe('very-low');

    const snapshot = snapshotBuilder.buildBrainSnapshot('404notf0und404', persona);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('eventSelectivity');
    expect(serialized).not.toContain(String(persona.behavior.activity.eventSelectivity));
    expect(serialized).not.toContain('chatFrequency');
    expect(serialized).not.toContain('very-low');
    // The trait survives as a habit, where it shapes how the person writes rather than whether they
    // are allowed to.
    expect(snapshot.speechFingerprint).toContain('пишет очень редко');
  });

  it('lets a situational joke stand as a whole reaction with nothing factual in it', () => {
    // "в шанхае шаурму искать это сильно" adds no information and is exactly right.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('or it carries feeling');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('one alone is enough');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('one alone is enough');
  });

  it('allows a one-word correction and does not ask for it to be explained', () => {
    // "Баранина" and "баранина это, свинина pork" — a correction is complete at one word.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('a correction');
    expect(REACTION_NATURALNESS_PROMPT).toContain('A fragment, a single word, an emote, or nothing at all');
    expect(REACTION_NATURALNESS_PROMPT).toContain('Length follows the thought');
  });
});

/**
 * The second live run, on c926efa: 72 moments, 83 decisions, 11 messages. The laugh anchoring was
 * gone; five messages failed in new ways. Each case below is one of those failures reduced to the
 * layer it actually lived in — a payload shape, a perception label, or a stated principle.
 */
describe('what the second live run showed', () => {
  it('separates what this session saw from what an earlier stream saw', () => {
    // "доехали до компов наконец-то" arrived nine seconds after bootstrap, on a session whose only
    // observation was a Dota draft screen. The bootstrap had handed it 25 events from a previous
    // evening in a field called recentMeaningfulEvents, and it wrote the journey between them.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('Only this session\'s own observations show what is happening');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('They never establish that anything happened in between');
    expect(BRAIN_SYSTEM_INSTRUCTION).not.toContain('recentMeaningfulEvents');
  });

  it('forbids an unobserved change of state without banning the words for one', () => {
    // Arriving, returning, getting there at last: the rule is about evidence, not vocabulary, so it
    // names the class and leaves the phrasing alone.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('write a change of state only if this session saw it or someone said it');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('no story leading up to it');
  });

  it('rejects a restatement with a verdict attached, by function and not by adjective', () => {
    // "Топ-200 Китая это солидно" and "в шанхае шаурму искать это сильно" are the same construction:
    // repeat the fact, grade it. No word is banned — солидно and сильно are ordinary Russian.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('Repeating what was just said and adding a verdict to it');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('is a grade, not a reaction');
    for (const word of ['солидно', 'сильно', 'мощно', 'не мудри']) {
      expect(BRAIN_SYSTEM_INSTRUCTION).not.toContain(word);
      expect(REACTION_NATURALNESS_PROMPT).not.toContain(word);
    }
  });

  it('asks a message to come from a point of view rather than to sound conversational', () => {
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('must come from somewhere in the person sending it');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('not whether it sounds conversational');
  });

  it('holds actionable advice to what the stream showed or the account knows', () => {
    // "в настройках интерфейса галка на миникарту" — a confident menu path from an account whose
    // profile has no such expertise, about an interface nobody on the stream could read.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('is a factual claim');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('On a weakTopic, an unknownTopic, or anything nothing supports, stay out');
    // And hedging is not the escape hatch: an invented path is invented either way.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('Do not soften a guess with "maybe"');
  });

  it('says a question mark is not an invitation and the audience decides', () => {
    // "тут мы, смотрим" answered "Вы где там, Артём?" — a teammate being called, not the chat.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('not the question mark, is what decides whether a question was an opening');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('twitch_chat');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('people_with_streamer');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('unclear means perception could not tell');
  });

  it('still allows a factual answer from an account that genuinely knows the subject', () => {
    // The rule is a grounding threshold, not a ban on being useful — an account with real expertise
    // and a moment that supports it may answer plainly.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('what this stream has shown or from what that account genuinely knows');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('its expertise');
  });

  it('keeps the two accounts that spoke on a weak topic pointed away from it', () => {
    // Both authors of the two worst live messages carry Dota as a weak topic, and one of them is
    // told in its own style instructions not to play the analyst. The profile was never the problem.
    for (const username of ['supercser2', 'novostro1ka']) {
      const persona = generatePersonaV3(username);
      const weak = persona.knowledge.weakTopics.join(' ').toLowerCase();
      expect(weak).toContain('dota');
      expect(persona.knowledge.expertise.join(' ').toLowerCase()).not.toContain('dota');
    }
  });

  it('refuses a trait as a way of talking', () => {
    // "Бери СК и не мудри" is not a catchphrase lifted from a profile; it is bluntness performed.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('The traits in a profile are not a way of talking');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('Nobody talks in mottoes');
  });
});

/**
 * The third live run, on aadf485: 25 moments, 24 completed stream-event decisions, 7 messages, and
 * a Persona Drive that made six calls and sent nothing. Grounding, addressee and advice held. Two
 * messages failed in one new way — "чисто домашний вайб пошел ахах" on a shot of a corridor, and
 * "Планёрка на улице пошла" on a shot of three men talking outside.
 */
describe('what the third live run showed', () => {
  it('treats naming a scene as the same failure as grading a fact', () => {
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('Naming is the same failure in different clothes');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('stopping there is a caption');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('If taking the label out leaves nothing behind');
  });

  it('does not let a laugh certify a caption', () => {
    // "чисто домашний вайб пошел ахах" — the laugh was the only thing making it sound like chat.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('A laugh on the end of a caption does not make it a reaction');
  });

  it('keeps metaphor and comparison available when they have a target', () => {
    // The fix must not cost visual comedy: a real oddity in frame is fair game.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('A joke or a comparison is welcome when it is aimed at something present');
    for (const word of ['вайб', 'планёрка', 'планёрк']) {
      expect(BRAIN_SYSTEM_INSTRUCTION).not.toContain(word);
      expect(REACTION_NATURALNESS_PROMPT).not.toContain(word);
    }
  });

  it('stops handing an account the running joke it is supposed to have', () => {
    // "Планёрка на улице пошла" was not invented. supercser2's canon says it calls a drawn-out
    // discussion a планёрка, and the payload shipped that sentence verbatim — the literal-laugh bug
    // again, through a field the previous round did not audit.
    const persona = generatePersonaV3('supercser2');
    expect(persona.streamerRelationship.recurringReferences.join(' ')).toContain('планёрк');
    const serialized = JSON.stringify(snapshotBuilder.buildBrainSnapshot('supercser2', persona));
    expect(serialized).not.toContain('планёрк');
    // The relationship itself is not the problem and stays.
    expect(serialized).toContain('подколы=');
  });

  it('asks Persona Drive for a specific reason without demanding a unique one', () => {
    // Six calls, no messages. One rule said a message another account could also have sent was not
    // worth sending, which is a demand that every line prove a personality.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('The reason must be specific. It does not have to be unique');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('not disqualified because another account could also have sent it');
    expect(BRAIN_SYSTEM_INSTRUCTION).not.toContain('could have come from any of the other accounts just as easily');
  });

  it('keeps the timer an opportunity and never a reason', () => {
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('What is never a reason is the timer');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('silence here is frequent and correct');
    // The framings that produced filler stay gone.
    for (const removed of ['quiet is the failure', 'turn to speak, not a question of whether to']) {
      expect(BRAIN_SYSTEM_INSTRUCTION).not.toContain(removed);
    }
  });

  it('points Persona Drive at what the session just heard and saw', () => {
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('recentSpeech and recentEvents are what this session has just heard and seen');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('that is where a reason has to come from');
  });
});

describe('how many accounts may answer one moment', () => {
  const guard = (candidates: number, salience: number): number => new ReactionPolicyGuard({
    globalMessagesPer30Seconds: 60,
    maxReactionsPerEvent: 5,
    now: () => 0,
  }).maxReactionsFor(candidates, salience);

  it('gives an ordinary moment one voice however large the crowd', () => {
    // No real chat answers a passing remark in chorus; a share of the crowd alone allowed exactly
    // that, and four connected accounts produced two wordings of one thought a second apart.
    for (const candidates of [1, 4, 10, 30, 200]) {
      expect(guard(candidates, 0.4)).toBe(1);
      expect(guard(candidates, 0.5)).toBe(1);
    }
  });

  it('opens up when the moment carries real weight', () => {
    // Something very funny or shocking does land on several people at once.
    expect(guard(30, 0.9)).toBe(5);
    expect(guard(10, 0.9)).toBe(2);
    // A middling moment sits between the two.
    expect(guard(30, 0.7)).toBe(2);
  });

  it('never exceeds the configured ceiling, and answers nothing with nobody available', () => {
    expect(guard(200, 1)).toBe(5);
    expect(guard(0, 1)).toBe(0);
  });

  it('gives a small chat one voice even on a big moment, because that is all it has', () => {
    expect(guard(4, 0.95)).toBe(1);
  });
});
