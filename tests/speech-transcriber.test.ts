import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger';
import { SpeechTranscriber } from '../src/transcription/speech-transcriber';

const SAMPLE_RATE = 16_000;

/** 16-bit mono PCM at the given amplitude: 0 is digital silence, 0.2 is conversational speech. */
function pcm(ms: number, amplitude: number): Buffer {
  const samples = Math.round((SAMPLE_RATE * ms) / 1000);
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    // A tone rather than noise, so the measured loudness is exactly what the test intends.
    const value = Math.sin((index / SAMPLE_RATE) * 2 * Math.PI * 220) * amplitude * 32_767;
    buffer.writeInt16LE(Math.round(value), index * 2);
  }
  return buffer;
}

function transcriber(overrides: Partial<ConstructorParameters<typeof SpeechTranscriber>[0]> = {}) {
  const heard: Array<{ text: string; audioMs: number }> = [];
  const hints: string[] = [];
  const created = vi.fn(async (_wav: Buffer, hint: string) => {
    hints.push(hint);
    return { text: 'привет как дела' };
  });
  const instance = new SpeechTranscriber({
    backend: { name: 'test', transcribe: created },
    logger: new Logger('TEST', 'error'),
    onTranscript: (text, meta) => { heard.push({ text, audioMs: meta.audioMs }); },
    ...overrides,
  });
  return { instance, heard, created, hints };
}

describe('SpeechTranscriber', () => {
  it('sends nothing while the stream is dead silent', async () => {
    // Uploading silence costs money for no transcript and invites an invented sentence in return.
    const { instance, created } = transcriber();
    instance.acceptPcm(pcm(20_000, 0));
    instance.flush();
    await vi.waitFor(() => expect(created).not.toHaveBeenCalled());
    expect(instance.getStats().segmentsSent).toBe(0);
    expect(instance.getStats().silenceSecondsSkipped).toBeGreaterThan(10);
  });

  it('repeats the tail of the previous window so a word cut by the clock survives somewhere', async () => {
    // A window closing on the clock rather than on a pause splits a word and both halves come back
    // wrong: production ended one with "ты платишь там 300 баксов за" and began the next with
    // "вкусна. Хочется один раз попробовать".
    const sizes: number[] = [];
    const { instance } = transcriber({
      windowMs: 2_000,
      overlapMs: 1_000,
      backend: {
        name: 'test',
        transcribe: async (wav) => { sizes.push(wav.length); return { text: 'слышно' }; },
      },
    });
    instance.acceptPcm(pcm(6_000, 0.2));
    await vi.waitFor(() => expect(sizes.length).toBeGreaterThanOrEqual(2));
    // 44 bytes of WAV header, then a second of carried audio on top of the two-second window.
    const seconds = (bytes: number): number => (bytes - 44) / (SAMPLE_RATE * 2);
    expect(seconds(sizes[0]!)).toBeCloseTo(2, 1);
    expect(seconds(sizes[1]!)).toBeCloseTo(3, 1);
  });

  it('tells the listener what the stream is about and what is on screen', async () => {
    // Names alone left "Парис" for a nickname and павербанк spelled two ways in consecutive
    // windows. The subject and the picture are what a human listener would already have.
    const { instance, hints } = transcriber({
      streamContext: () => 'ИРЛ Шанхай, дота кэмп, едим',
      currentScene: () => 'Мужчина держит павербанк над стабилизатором.',
      vocabulary: () => ['gudini_younger'],
    });
    instance.acceptPcm(pcm(2_000, 0.2));
    instance.acceptPcm(pcm(1_000, 0));
    await vi.waitFor(() => expect(hints).toHaveLength(1));
    expect(hints[0]).toContain('ИРЛ Шанхай');
    expect(hints[0]).toContain('павербанк');
    expect(hints[0]).toContain('gudini_younger');
  });

  it('hears quiet speech under constant background instead of measuring the room first', async () => {
    // The adaptive floor this replaces measured the room and then measured the speech too: in a
    // restaurant with continuous conversation the quietest moment of any six-second window was
    // itself talking, the threshold climbed to speech level, and 38 minutes yielded 24 seconds.
    const { instance, created, heard } = transcriber();
    // Background never drops out, and the speech over it is only a little louder.
    instance.acceptPcm(pcm(3_000, 0.03));
    instance.acceptPcm(pcm(2_000, 0.06));
    instance.acceptPcm(pcm(1_500, 0.03));
    instance.flush();
    await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    expect(heard[0]?.audioMs).toBe(6_500);
  });

  it('cuts at a pause so a sentence arrives whole', async () => {
    const { instance, created } = transcriber({ hangoverMs: 900, windowMs: 12_000 });
    instance.acceptPcm(pcm(2_000, 0.2));
    instance.acceptPcm(pcm(1_000, 0));
    await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(1));

    instance.acceptPcm(pcm(2_000, 0.2));
    instance.acceptPcm(pcm(1_000, 0));
    await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(2));
  });

  it('cuts a speaker who never pauses at the window length', async () => {
    const { instance, created } = transcriber({ windowMs: 5_000 });
    instance.acceptPcm(pcm(16_000, 0.2));
    // Two go out and the rest is dropped on purpose: a third window in flight means the stream is
    // outrunning transcription, and a backlog of stale audio is worth less than nothing.
    await vi.waitFor(() => expect(created.mock.calls.length).toBe(2));
  });

  it('drops a window holding nothing but a cough', async () => {
    const { instance, created } = transcriber({ minSegmentMs: 600 });
    instance.acceptPcm(pcm(200, 0.3));
    instance.acceptPcm(pcm(1_200, 0));
    await vi.waitFor(() => expect(created).not.toHaveBeenCalled());
    expect(instance.getStats().segmentsSent).toBe(0);
  });

  it('tells the listener which names are in play and what was said a moment ago', async () => {
    // A window heard on its own has no idea a stream is called gudini_younger. Continuous
    // listening got that for free; this is what buys it back.
    const { instance, hints } = transcriber({ vocabulary: () => ['gudini_younger', 'karlbekner'] });
    instance.acceptPcm(pcm(2_000, 0.2));
    instance.acceptPcm(pcm(1_000, 0));
    await vi.waitFor(() => expect(hints).toHaveLength(1));
    expect(hints[0]).toContain('gudini_younger');
    expect(hints[0]).toContain('karlbekner');

    instance.acceptPcm(pcm(2_000, 0.2));
    instance.acceptPcm(pcm(1_000, 0));
    await vi.waitFor(() => expect(hints).toHaveLength(2));
    expect(hints[1]).toContain('привет как дела');
  });

  it('reports what it spent per window, whether or not words came back', async () => {
    const usage: Array<{ costUsd?: number; audioSeconds: number; failed: boolean }> = [];
    const { instance } = transcriber({
      onUsage: (item) => usage.push(item),
      backend: { name: 'test', transcribe: async () => ({ text: 'слышно', costUsd: 0.0004 }) },
    });
    instance.acceptPcm(pcm(2_000, 0.2));
    instance.acceptPcm(pcm(1_000, 0));
    await vi.waitFor(() => expect(usage).toHaveLength(1));
    expect(usage[0]).toMatchObject({ costUsd: 0.0004, failed: false });
    // Two seconds of speech plus the short pause that closed the window.
    expect(usage[0]?.audioSeconds).toBeCloseTo(2.46, 2);
  });
});
