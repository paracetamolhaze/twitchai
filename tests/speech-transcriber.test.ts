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
  const created = vi.fn(async () => ({ text: 'привет как дела' }));
  const instance = new SpeechTranscriber({
    apiKey: 'test-key',
    language: 'ru',
    logger: new Logger('TEST', 'error'),
    onTranscript: (text, meta) => { heard.push({ text, audioMs: meta.audioMs }); },
    ...overrides,
  });
  // The SDK client is constructed internally; the test replaces only its transcription call.
  (instance as unknown as { groq: { audio: { transcriptions: { create: unknown } } } }).groq = {
    audio: { transcriptions: { create: created } },
  };
  return { instance, heard, created };
}

describe('SpeechTranscriber', () => {
  it('sends nothing at all while the stream is silent', async () => {
    // Most of an IRL hour is silence. Uploading it costs money for no transcript, and Whisper
    // answers silence with invented sentences.
    const { instance, created } = transcriber();
    instance.acceptPcm(pcm(5_000, 0));
    instance.flush();
    await vi.waitFor(() => expect(created).not.toHaveBeenCalled());
    const stats = instance.getStats();
    expect(stats.segmentsSent).toBe(0);
    expect(stats.silenceSecondsSkipped).toBeGreaterThan(4);
  });

  it('cuts one segment per utterance and ends it on the pause, not on a fixed clock', async () => {
    const { instance, heard, created } = transcriber();
    instance.acceptPcm(pcm(400, 0));
    instance.acceptPcm(pcm(1_500, 0.2));
    instance.acceptPcm(pcm(1_200, 0));
    await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    expect(heard[0]?.text).toBe('привет как дела');

    instance.acceptPcm(pcm(1_500, 0.2));
    instance.acceptPcm(pcm(1_200, 0));
    await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(2));
  });

  it('keeps the moment before speech was recognised, so the first word survives', async () => {
    const { instance, heard, created } = transcriber({ preRollMs: 300 });
    instance.acceptPcm(pcm(2_000, 0));
    instance.acceptPcm(pcm(1_000, 0.2));
    instance.acceptPcm(pcm(1_200, 0));
    await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    // Lead-in plus the speech plus the pause that ended it — and none of the two silent seconds
    // that came before.
    expect(heard[0]?.audioMs).toBeGreaterThanOrEqual(1_200);
    expect(heard[0]?.audioMs).toBeLessThan(2_500);
  });

  it('discards a cough instead of paying for a request that transcribes nothing', async () => {
    const { instance, created } = transcriber({ minSegmentMs: 700 });
    instance.acceptPcm(pcm(700, 0));
    instance.acceptPcm(pcm(200, 0.3));
    instance.acceptPcm(pcm(1_200, 0));
    await vi.waitFor(() => expect(created).not.toHaveBeenCalled());
    expect(instance.getStats().segmentsSent).toBe(0);
  });

  it('cuts a speaker who never pauses, so a transcript still arrives', async () => {
    const { instance, created } = transcriber({ maxSegmentMs: 2_000 });
    instance.acceptPcm(pcm(700, 0));
    instance.acceptPcm(pcm(5_000, 0.2));
    await vi.waitFor(() => expect(created.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('hears quiet speech over loud background by measuring the room rather than a fixed level', async () => {
    // A market street and a quiet kitchen are several times apart in background level, and one
    // fixed threshold either misses the speech in the first or hears the noise in the second.
    const { instance, created } = transcriber();
    instance.acceptPcm(pcm(4_000, 0.03));
    await vi.waitFor(() => expect(created).not.toHaveBeenCalled());
    expect(instance.getStats().segmentsSent).toBe(0);

    instance.acceptPcm(pcm(1_500, 0.25));
    instance.acceptPcm(pcm(1_200, 0.03));
    await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(1));
  });
});
