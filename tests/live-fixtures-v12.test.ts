import { describe, expect, it } from 'vitest';
import { extractNumbers, ungroundedNumbers } from '../src/reaction/reaction-coordinator';
import {
  hasTrailingLaughterTag,
  isEventParaphrase,
  NaturalnessGuard,
} from '../src/reaction/naturalness-guard';
import { StreamEvent } from '../src/stream-brain/types';

/**
 * The 2026-08-23 production live test, replayed as fixtures. Every event here is reconstructed
 * from the deployment's own logs (transcriber windows and decision lines), not from memory: the
 * exact speech around each sent message is what the pipeline is now held against. Labels follow
 * the evidence, not taste — where a live failure is deliberately left to the instruction rather
 * than a deterministic rule, the test asserts THAT, so the limitation is pinned instead of hidden.
 */

const guard = new NaturalnessGuard();

function event(overrides: Partial<StreamEvent>): StreamEvent {
  return {
    id: 'live-1', timestamp: 1_700_000_000_000, type: 'conversation', summary: '',
    importance: 0.6, confidence: 0.9, source: 'transcription', directMentions: [], ...overrides,
  };
}

describe('live fixture: «брутские это кто вообще лол» after «Брутские парни — это кто?»', () => {
  const asked = event({
    summary: 'Брутские парни — это кто?',
    speech: 'S: Брутские парни — это кто?',
  });

  it('is rejected as a short question echo: the stream\'s own question re-asked', () => {
    expect(guard.check({ message: 'брутские это кто вообще лол', event: asked }))
      .toEqual({ ok: false, reason: 'short_question_echo' });
  });

  it('a correction with a fresh negation stays legal — «не, на пудже» after «он на СФе?»', () => {
    const heroQuestion = event({ summary: 'он на СФе?', speech: 'O: он на СФе?' });
    expect(guard.check({ message: 'не, на пудже', event: heroQuestion })).toEqual({ ok: true });
  });

  it('a real question about the subject that adds its own words stays legal', () => {
    expect(guard.check({ message: 'брутские это с какого сервера вообще?', event: asked }))
      .toEqual({ ok: true });
  });
});

describe('live fixture: «покажи че там реально» after the streamer asks chat', () => {
  const askedChat = event({
    summary: 'Стример спрашивает чат, показать ли что происходит',
    speech: 'S: чат, хотите покажу что там?',
    audience: 'twitch_chat',
  });

  it('an explicit answer to the chat passes — audience exempts it before any echo class', () => {
    expect(guard.check({ message: 'покажи че там реально', event: askedChat })).toEqual({ ok: true });
    expect(guard.check({ message: 'покажи', event: askedChat })).toEqual({ ok: true });
  });

  it('even without the audience flag, a claimed chat_reply is exempt from the question-echo class', () => {
    const unmarked = event({ summary: 'чат, хотите покажу что там?', speech: 'S: чат, хотите покажу что там?' });
    expect(guard.check({ message: 'покажи давай', event: unmarked, claimedSourceType: 'chat_reply' }))
      .toEqual({ ok: true });
  });
});

describe('live fixture: «из америки ахаха» after «эта тёлка из Америки?»', () => {
  it('is rejected: a laugh must never rescue words that are all the stream\'s own', () => {
    const asked = event({ summary: 'эта тёлка из Америки?', speech: 'O: эта тёлка из Америки?' });
    const verdict = guard.check({ message: 'из америки ахаха', event: asked });
    expect(verdict.ok).toBe(false);
    expect(['transcript_echo', 'short_question_echo']).toContain(verdict.reason);
  });

  it('standalone laughter still always passes', () => {
    const asked = event({ summary: 'эта тёлка из Америки?', speech: 'O: эта тёлка из Америки?' });
    expect(guard.check({ message: 'ахахах', event: asked })).toEqual({ ok: true });
  });
});

describe('live fixture: «меню открыла какое-то» — a caption of the scene', () => {
  const menuEvent = event({
    summary: 'Девушка открыла меню на экране',
    speech: 'S: смотрим что тут',
    visualContext: 'девушка открыла игровое меню настроек',
  });

  it('is an event paraphrase when the model itself declared event_observation', () => {
    expect(isEventParaphrase('меню открыла какое-то', menuEvent)).toBe(true);
  });

  it('a stance or question on the same scene is not a paraphrase', () => {
    expect(isEventParaphrase('зачем ей это меню сейчас', menuEvent)).toBe(false);
    expect(isEventParaphrase('не то меню открыла', menuEvent)).toBe(false);
  });
});

describe('live fixture: «13к на сигнатурном пудже» — the invented hero', () => {
  // Reconstructed window 19:24:45: «O: У меня 13 к ммр.» — no hero was ever named.
  const mmrEvent = event({
    summary: 'Девушка говорит что у неё 13к ммр',
    speech: 'O: Девушки тоже могут в Доту ебашиться. S: Могут. А ты играла? O: Да. O: У меня 13 к ммр.',
  });

  it('the NUMBER is grounded, so the deterministic check passes it — the hero is a pinned limitation', () => {
    // 13 appears in the speech; «сигнатурном пудже» is words, and a word-level fabrication
    // detector without understanding is exactly the NER monster this task forbids. The defense
    // for the words is the grounding paragraph in the system instruction; the defense for
    // numbers is below, and it is deterministic.
    const grounded = extractNumbers(mmrEvent.speech!);
    expect(ungroundedNumbers('13к на сигнатурном пудже', grounded)).toEqual([]);
  });

  it('a number nothing in the context contains is flagged', () => {
    const grounded = extractNumbers(mmrEvent.speech!);
    expect(ungroundedNumbers('поднял 7500 ммр за месяц', grounded)).toEqual(['7500']);
  });

  it('«3500 это база» is legal exactly when 3500 was actually said', () => {
    expect(ungroundedNumbers('3500 это база', extractNumbers('S: подниму до 3500 спокойно'))).toEqual([]);
    expect(ungroundedNumbers('3500 это база', extractNumbers('S: подниму рейтинг спокойно'))).toEqual(['3500']);
  });

  it('single digits stay conversational, never rejected', () => {
    expect(ungroundedNumbers('дай 5 минут', new Set<string>())).toEqual([]);
  });
});

describe('live fixtures: the laughter-tagged commentary pair', () => {
  it('«логика железная ахах» carries a decorative trailing laugh — observability, honestly not a rejection', () => {
    // Stripped of the laugh, «логика железная» is not the event's words and not in the generic
    // evaluator vocabulary, so no deterministic class can claim it without guessing at meaning.
    // The learned rule stays prompt-level for this shape; the counter is what watches it.
    expect(hasTrailingLaughterTag('логика железная ахах')).toBe(true);
    expect(hasTrailingLaughterTag('че за вопросы пошли ахах')).toBe(true);
    const verdict = guard.check({
      message: 'логика железная ахах',
      event: event({ summary: 'Стример объясняет свою логику', speech: 'S: ну логично же' }),
    });
    expect(verdict.ok).toBe(true);
  });

  it('standalone laughter is not a tag', () => {
    expect(hasTrailingLaughterTag('ахахах')).toBe(false);
    expect(hasTrailingLaughterTag('kekw')).toBe(false);
  });
});

describe('live fixture: «а сколько тогда» — a real question survives everything', () => {
  it('passes: it asks for something the stream did not say', () => {
    const priceTalk = event({
      summary: 'Обсуждают сколько стоил вход',
      speech: 'S: за вход платили. O: 1500 за вход нормально.',
    });
    expect(guard.check({ message: 'а сколько тогда', event: priceTalk })).toEqual({ ok: true });
  });
});
