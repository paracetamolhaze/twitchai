import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger';
import { enforceTranscriptContract, looksLikeModelMeta, SpeechTranscriber, withoutRepeatedTail } from '../src/transcription/speech-transcriber';

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

describe('OpenRouter transcription request', () => {
  it('asks who is speaking, by role rather than by index', async () => {
    // An IRL stream is several people across each other, and one undivided blob left the decision
    // layer unable to tell the streamer from the friend beside him. Each window is transcribed on
    // its own, so "speaker 1" would mean someone different in the next one; S is always the camera.
    const { OpenRouterTranscriptionBackend } = await import('../src/transcription/transcription-backend');
    let sent = '';
    const backend = new OpenRouterTranscriptionBackend({
      apiKey: 'test-key',
      model: 'google/gemini-3.7-flash',
      language: 'ru',
      fetchImpl: (async (_url: string, init: { body: string }) => {
        sent = init.body;
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({ choices: [{ message: { content: 'S: слышно' } }], usage: { cost: 0.0006 } }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });

    const result = await backend.transcribe(Buffer.from('RIFF'), 'Names: Лёша');
    expect(result.text).toBe('S: слышно');
    expect(result.costUsd).toBe(0.0006);
    const body = JSON.parse(sent) as { messages: Array<{ content: Array<{ text?: string }> }> };
    const instruction = body.messages[0]!.content[0]!.text ?? '';
    expect(instruction).toContain('"S: " for the person holding the camera');
    expect(instruction).toContain('Лёша');
    // The old instruction forbade speaker labels outright; that is what has changed.
    expect(instruction).not.toContain('no speaker labels');
  });
});

describe('withoutRepeatedTail', () => {
  it('drops the words the audio overlap made the model say twice', () => {
    // The overlap is deliberate so a word cut by the clock survives; its echo in the text is not.
    // Production sent the decision layer "Не знаю, всё нормально. Не знаю, всё нормально."
    expect(withoutRepeatedTail(
      'Закажи. Тебе надо, ты выбирай. Не знаю, всё нормально.',
      'Не знаю, всё нормально. Сервис по факту не понравился.',
    )).toBe('Сервис по факту не понравился.');
  });

  it('keeps a window that simply continues the sentence', () => {
    expect(withoutRepeatedTail('Хочется просто стейк', 'какого-то, да, вкусного'))
      .toBe('какого-то, да, вкусного');
  });

  it('drops a window that repeated the previous one outright', () => {
    expect(withoutRepeatedTail('Инициатива, как говорится, наказуема.', 'Инициатива, как говорится, наказуема.'))
      .toBeUndefined();
  });

  it('ignores a coincidental short overlap rather than eating real speech', () => {
    // Two windows both containing "да" is not an echo, and treating it as one would delete a line.
    expect(withoutRepeatedTail('ну да', 'да ладно, поехали уже отсюда'))
      .toBe('да ладно, поехали уже отсюда');
  });
});

describe('SpeechTranscriber', () => {
  it('holds one fresh window while both transcription slots are busy', async () => {
    const release: Array<(result: {text: string}) => void> = [];
    const backend = { name: 'test', transcribe: vi.fn(() => new Promise<{text: string}>(resolve => release.push(resolve))) };
    const { instance } = transcriber({ backend, windowMs: 1000, overlapMs: 0 });
    instance.acceptPcm(pcm(3000, .2));
    expect(backend.transcribe).toHaveBeenCalledTimes(2);
    release[0]!({text: 'S: первая фраза'});
    await vi.waitFor(() => expect(backend.transcribe).toHaveBeenCalledTimes(3));
    expect(instance.getStats().silenceSecondsSkipped).toBe(0);
    release[1]!({text: 'S: вторая фраза'});
    release[2]!({text: 'S: третья фраза'});
    await vi.waitFor(() => expect(instance.getStats().transcriptsReceived).toBe(3));
  });

  it('does not submit queued audio or publish old results after reset', async () => {
    const release: Array<(result: {text: string}) => void> = [];
    const backend = { name: 'test', transcribe: vi.fn(() => new Promise<{text: string}>(resolve => release.push(resolve))) };
    const { instance, heard } = transcriber({ backend, windowMs: 1000, overlapMs: 0 });
    instance.acceptPcm(pcm(3000, .2));
    instance.reset();
    release[0]!({text: 'S: old speech'});
    release[1]!({text: 'S: more old speech'});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(backend.transcribe).toHaveBeenCalledTimes(2);
    expect(heard).toEqual([]);
  });

  it('discards a waiting window after five seconds and does not count it as silence', async () => {
    vi.useFakeTimers();
    try {
      const release: Array<(result: {text: string}) => void> = [];
      const backend = { name: 'test', transcribe: vi.fn(() => new Promise<{text: string}>(resolve => release.push(resolve))) };
      const { instance } = transcriber({ backend, windowMs: 1000, overlapMs: 0 });
      instance.acceptPcm(pcm(3000, .2));
      await vi.advanceTimersByTimeAsync(6000);
      release[0]!({text: 'S: first speech'});
      release[1]!({text: 'S: second speech'});
      await vi.advanceTimersByTimeAsync(0);
      expect(backend.transcribe).toHaveBeenCalledTimes(2);
      expect(instance.getStats()).toMatchObject({ droppedAudioSeconds: 1, silenceSecondsSkipped: 0 });
    } finally { vi.useRealTimers(); }
  });

  it('stops uploading new audio after the Railway 402 billing failure', async () => {
    const backend = { name: 'test', transcribe: vi.fn(async () => { throw new Error('402 This request requires at least $0.50 in balance for audio'); }) };
    const onUnavailable = vi.fn();
    const { instance } = transcriber({ backend, windowMs: 1000, onUnavailable });
    instance.acceptPcm(pcm(1000, 0.2));
    await vi.waitFor(() => expect(instance.getStats().failures).toBe(1));
    instance.acceptPcm(pcm(10000, 0.2));
    expect(backend.transcribe).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

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
    // Two go out immediately; one fresh window waits for a slot.
    await vi.waitFor(() => expect(created.mock.calls.length).toBe(3));
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

describe('model meta-output leaking as a transcript', () => {
  it('catches the exact production leak and its near shapes', () => {
    // The real string that reached a StreamEvent as if someone had said it on stream.
    expect(looksLikeModelMeta('thought The user wants transcription of the speech in the provided video clip. The speakers are talking about the game.')).toBe(true);
    expect(looksLikeModelMeta('The user wants a transcription of the audio.')).toBe(true);
    expect(looksLikeModelMeta('I will transcribe the provided audio clip now.')).toBe(true);
    expect(looksLikeModelMeta('As an AI language model, I cannot hear tone.')).toBe(true);
  });

  it('never touches real bilingual speech, even English-heavy lines', () => {
    for (const speech of [
      'S: Здорово, чат. O: Го обзор на труханы',
      'S: I support Yandex. Yandex so good.',
      'O: он сказал think about it и ушёл',
      'S: юзер в чате спрашивает про доту',
      'клип получился смешной, надо сохранить',
    ]) {
      expect(looksLikeModelMeta(speech)).toBe(false);
    }
  });
});

describe('strict transcript contract — production leaks from the 2026-08-23 live test', () => {
  it('drops unlabeled English descriptive prose — the model paraphrasing its task, not speech', () => {
    const result = enforceTranscriptContract('Usually the streamer is the male host (e.g.');
    expect(result.text).toBeUndefined();
    expect(result.rejected).toEqual([
      expect.objectContaining({ reason: 'unlabeled_english_prose' }),
    ]);
  });

  it('keeps labeled English — this stream genuinely mixes languages', () => {
    const result = enforceTranscriptContract('S: было тут быть. Я говорила: I am operator Iron Wing,');
    expect(result.text).toContain('Iron Wing');
    expect(result.rejected).toEqual([]);
    const camera = enforceTranscriptContract('S: The camera is fixed on a tripod');
    expect(camera.text).toBe('S: The camera is fixed on a tripod');
  });

  it('drops format-artifact lines — the model correcting its own output mid-response', () => {
    const result = enforceTranscriptContract('но доделать вот эту вот штучку.") -> O');
    expect(result.text).toBeUndefined();
    expect(result.rejected).toEqual([expect.objectContaining({ reason: 'format_artifact' })]);
    const arrows = enforceTranscriptContract('походу. / устал, по-моему. -> "на');
    expect(arrows.text).toBeUndefined();
  });

  it('keeps an unlabeled Russian continuation — a window often opens mid-sentence', () => {
    const result = enforceTranscriptContract('кой пользоваться? Помогите. Помогите.');
    expect(result.text).toBe('кой пользоваться? Помогите. Помогите.');
    expect(result.rejected).toEqual([]);
  });

  it('salvages the good lines around a bad one instead of dropping the window', () => {
    const result = enforceTranscriptContract(
      'S: Привет, как дела?\nUsually the streamer is the male host describing the scene here\nO: нормально всё',
    );
    expect(result.text).toBe('S: Привет, как дела?\nO: нормально всё');
    expect(result.rejected).toHaveLength(1);
  });
});
