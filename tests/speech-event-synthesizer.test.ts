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
    await vi.advanceTimersByTimeAsync(30_000);
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
    await vi.advanceTimersByTimeAsync(30_000);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.speech).toBe('слушай а тут вообще нормально кормят или так себе');
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
