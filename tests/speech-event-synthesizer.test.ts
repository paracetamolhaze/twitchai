import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger';
import { SpeechEventSynthesizer } from '../src/stream-brain/speech-event-synthesizer';
import { StreamEventCandidate } from '../src/stream-brain/types';

afterEach(() => vi.useRealTimers());

function synthesizer(overrides: Partial<ConstructorParameters<typeof SpeechEventSynthesizer>[0]> = {}) {
  const emitted: StreamEventCandidate[] = [];
  const instance = new SpeechEventSynthesizer({
    botUsernames: () => ['karlbekner', 'gigantiuz'],
    emit: (candidate) => emitted.push(candidate),
    logger: new Logger('TEST', 'error'),
    ...overrides,
  });
  return { instance, emitted };
}

describe('SpeechEventSynthesizer', () => {
  it('carries the words themselves rather than a description of them', async () => {
    // The layer this replaces handed the decision layer "the streamer proposes some sort of plan"
    // where the words were "we are dragging him out for drinks".
    vi.useFakeTimers();
    const { instance, emitted } = synthesizer();
    instance.accept('короче я щас доем и поедем в центр, там бар нормальный есть');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.speech).toBe('короче я щас доем и поедем в центр, там бар нормальный есть');
    expect(emitted[0]?.summary).toBe(emitted[0]?.speech);
    expect(emitted[0]?.type).toBe('speech');
  });

  it('answers a line naming an account immediately, whatever the pacing says', async () => {
    // A question to one of the accounts that waits twenty seconds has already failed.
    vi.useFakeTimers();
    const { instance, emitted } = synthesizer();
    instance.accept('ну ладно, поехали дальше');
    instance.accept('karlbekner а ты чё думаешь');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe('direct_mention');
    expect(emitted[0]?.speech).toContain('ну ладно, поехали дальше');
    expect(emitted[0]?.speech).toContain('karlbekner');
  });

  it('answers a name that was spoken in Russian, not only one typed in Latin', async () => {
    // The transcriber writes down what it hears, and a Russian speaker saying karlbekner is
    // transcribed Карлбекнер. Matching the username as written would never have fired.
    vi.useFakeTimers();
    const { instance, emitted } = synthesizer();
    instance.accept('Карлбекнер, а ты чё думаешь, стоит туда идти?');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe('direct_mention');
  });

  it('turns a talkative minute into a few decisions instead of one per sentence', async () => {
    vi.useFakeTimers();
    const { instance, emitted } = synthesizer({ minIntervalMs: 9_000, minCharacters: 60 });
    for (let index = 0; index < 12; index += 1) {
      instance.accept(`это довольно длинная реплика номер ${index}, в ней хватает символов`);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    // A minute of continuous talking, not a decision every five seconds.
    expect(emitted.length).toBeGreaterThanOrEqual(4);
    expect(emitted.length).toBeLessThanOrEqual(8);
  });

  it('answers a question in seconds instead of holding it for the pacing interval', async () => {
    // Pacing keeps a talkative minute from becoming forty decisions, but a question is the one
    // thing that stops being answerable while it waits.
    vi.useFakeTimers();
    const { instance, emitted } = synthesizer({ minIntervalMs: 20_000, quickIntervalMs: 5_000 });
    instance.accept('ну поехали дальше короче, тут вроде недалеко ехать осталось совсем немного');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(emitted).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(6_000);
    instance.accept('а вы бы сколько за такое отдали?');
    // Six seconds after the last decision, not twenty.
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.type).toBe('question');
  });

  it('still holds an ordinary remark to the full interval', async () => {
    vi.useFakeTimers();
    const { instance, emitted } = synthesizer({ minIntervalMs: 20_000, quickIntervalMs: 5_000 });
    instance.accept('ну поехали дальше короче, тут вроде недалеко ехать осталось совсем немного');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(emitted).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(6_000);
    instance.accept('да нормально всё, едем спокойно, ничего особенного вокруг не происходит');
    expect(emitted).toHaveLength(1);
  });

  it('does not leave a short remark unanswered on a quiet stream', async () => {
    // A lone remark never reaches the character threshold, and a quiet stream is exactly where it
    // matters most.
    vi.useFakeTimers();
    const { instance, emitted } = synthesizer({ maxWaitMs: 25_000 });
    instance.accept('ага');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(emitted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.speech).toBe('ага');
  });

  it('joins what was said while waiting into one moment', async () => {
    vi.useFakeTimers();
    const { instance, emitted } = synthesizer();
    instance.accept('слушай');
    await vi.advanceTimersByTimeAsync(2_000);
    instance.accept('а тут вообще нормально кормят или так себе');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.speech).toBe('слушай а тут вообще нормально кормят или так себе');
  });

  it('sends what is on screen along with what was said', async () => {
    vi.useFakeTimers();
    const { instance, emitted } = synthesizer();
    // A moment first, so the scene that follows lands inside the quiet window and rides along with
    // the next thing said instead of becoming a moment of its own.
    instance.accept('короче я щас доем и поедем в центр, там бар нормальный есть');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(emitted).toHaveLength(1);

    instance.acceptScene('Мужчина сидит за столом в кафе, перед ним тарелка.', true);
    expect(emitted).toHaveLength(1);

    instance.accept('ну такое себе, честно говоря, за такие деньги');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.visualContext).toBe('Мужчина сидит за столом в кафе, перед ним тарелка.');
  });

  it('makes a changed scene a moment of its own only when nobody is talking', async () => {
    // On a talkative stream the words are the moment; a second trigger for the same instant is
    // just two accounts answering the same thing twice.
    vi.useFakeTimers();
    const { instance, emitted } = synthesizer({ quietBeforeVisualMs: 40_000 });
    instance.accept('короче я щас доем и поедем в центр, там бар нормальный есть');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(emitted).toHaveLength(1);

    instance.acceptScene('Улица, вечер, компания идёт мимо витрин.', true);
    expect(emitted).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(40_000);
    instance.acceptScene('Метро, вагон, людей немного.', true);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.type).toBe('visual');
    expect(emitted[1]?.summary).toBe('Метро, вагон, людей немного.');
  });

  it('ignores a scene that has not changed, however long the silence', async () => {
    vi.useFakeTimers();
    const { instance, emitted } = synthesizer();
    await vi.advanceTimersByTimeAsync(120_000);
    instance.acceptScene('Мужчина сидит за столом.', false);
    expect(emitted).toHaveLength(0);
  });

  it('drops what is buffered when the stream ends rather than answering it later', async () => {
    vi.useFakeTimers();
    const { instance, emitted } = synthesizer();
    instance.accept('и вот тогда мы решили что');
    instance.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emitted).toHaveLength(0);
  });
});
