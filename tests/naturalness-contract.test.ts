import { describe, expect, it } from 'vitest';
import { BRAIN_SYSTEM_INSTRUCTION } from '../src/brain/gemini-brain.service';
import { REACTION_NATURALNESS_INSTRUCTIONS, REACTION_NATURALNESS_PROMPT } from '../src/reaction/natural-writing-policy';
import { ReactionPolicyGuard } from '../src/reaction/reaction-policy-guard';

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
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('is there a reason for anyone to answer this moment');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('Never work the other way round');
  });

  it('counts feeling as reason enough, not only information', () => {
    // A rule requiring every message to add something the stream did not contain forbids laughing,
    // which is one of the most common real things in a chat.
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('information or by carrying feeling');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('does not have to be witty or complete');
    expect(BRAIN_SYSTEM_INSTRUCTION).not.toContain('earns its place only by adding something');
  });

  it('treats silence as the ordinary outcome for every account, including on a quiet chat', () => {
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('Silence is the normal answer to most moments');
    expect(BRAIN_SYSTEM_INSTRUCTION).toContain('silence here is frequent and correct');
    // The framing that produced filler: a supplied opportunity read as an obligation.
    for (const removed of ['turn to speak, not a question of whether to', 'quiet is the failure', 'never as the safe default']) {
      expect(BRAIN_SYSTEM_INSTRUCTION).not.toContain(removed);
    }
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
    // It reached 11k characters by accretion. Whatever the ceiling should be, it is not that.
    expect(BRAIN_SYSTEM_INSTRUCTION.length).toBeLessThan(8_000);
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
