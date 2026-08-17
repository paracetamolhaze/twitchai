import { Logger } from '../logger';
import { TranscriptionBackend } from './transcription-backend';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE / 1000) * FRAME_MS * BYTES_PER_SAMPLE;

export interface SpeechTranscriberOptions {
  backend: TranscriptionBackend;
  logger: Logger;
  /**
   * Names in play — the streamer, the accounts, whatever the stream keeps coming back to. Sent
   * with every segment so proper nouns stop drifting, which is the one thing a segment heard on
   * its own loses against a session that listens continuously.
   */
  vocabulary?: () => string[];
  /** What the stream is about, in the operator's own words. */
  streamContext?: () => string;
  /** What the watching layer last described, so a heard word can be matched to a seen thing. */
  currentScene?: () => string | undefined;
  onTranscript: (text: string, meta: { audioMs: number; latencyMs: number }) => void | Promise<void>;
  /** Every attempt, transcript or not, so the bill is counted where it is actually incurred. */
  onUsage?: (usage: { costUsd?: number; audioSeconds: number; failed: boolean }) => void;
  /**
   * Audible level. Deliberately near digital silence: this exists only to skip a dead stream, not
   * to decide what counts as speech. The adaptive floor it replaces measured the room and then
   * measured the speech too — in a restaurant with constant background the quietest moment of any
   * six-second window was itself talking, so the threshold climbed to speech level and the layer
   * went nearly deaf: 24 seconds of audio heard out of 38 minutes.
   */
  audibleRms?: number;
  /** Silence that closes a window early, so a sentence is not cut mid-word when a pause offers. */
  hangoverMs?: number;
  /** Audio that must be audible before a window is worth sending at all. */
  minSegmentMs?: number;
  /** How much audio goes in one request. Longer is cheaper per second and slower to arrive. */
  windowMs?: number;
  /**
   * Audio repeated from the end of the previous window.
   *
   * A window that closes on the clock rather than on a pause cuts a word in half, and both halves
   * come back wrong: production windows ended "ты платишь там 300 баксов за" and the next began
   * "вкусна. Хочется один раз попробовать". Overlapping costs a second of audio per window — a
   * fraction of a cent an hour — and makes the word whole in at least one of them.
   */
  overlapMs?: number;
}

export interface SpeechTranscriberStats {
  segmentsSent: number;
  transcriptsReceived: number;
  audioSecondsSent: number;
  silenceSecondsSkipped: number;
  failures: number;
  lastTranscript?: string;
  lastLatencyMs?: number;
}

/**
 * Hearing as a sensor rather than a conversation.
 *
 * Audio is cut into windows and each is transcribed on its own: nothing is retained between them,
 * so a second of audio is paid for exactly once. The layer this replaces was a stateful session
 * that re-read its whole retained window on every turn, billing roughly eight times per second
 * heard, and it could go deaf while still reporting itself connected.
 *
 * It listens to everything audible rather than trying to find the speech first. Deciding that
 * locally was a mistake worth naming: a floor measured from the room rises to meet continuous
 * conversation, and a restaurant left 24 seconds heard out of 38 minutes. An hour of audio is
 * about ninety thousand tokens — three cents — so there is nothing to save by guessing, and
 * everything to lose. Only a genuinely dead stream is skipped.
 */
export class SpeechTranscriber {
  private readonly logger: Logger;
  private readonly audibleRms: number;
  private readonly hangoverMs: number;
  private readonly minSegmentMs: number;
  private readonly windowMs: number;
  private readonly overlapFrames: number;
  /** Tail of the window just sent, prepended to the next one so a cut word survives somewhere. */
  private overlap: Buffer[] = [];
  /** The last few windows of text, for the hint and for spotting the words this stream repeats. */
  private readonly recentTranscripts: string[] = [];

  private window: Buffer[] = [];
  private windowMsFilled = 0;
  private audibleMs = 0;
  private trailingQuietMs = 0;
  private carry = Buffer.alloc(0);
  private inFlight = 0;
  private readonly stats: SpeechTranscriberStats = {
    segmentsSent: 0,
    transcriptsReceived: 0,
    audioSecondsSent: 0,
    silenceSecondsSkipped: 0,
    failures: 0,
  };

  constructor(private readonly options: SpeechTranscriberOptions) {
    this.logger = options.logger.child('TRANSCRIPTION');
    this.audibleRms = options.audibleRms ?? 0.004;
    this.minSegmentMs = options.minSegmentMs ?? 600;
    this.windowMs = options.windowMs ?? 12_000;
    this.overlapFrames = Math.max(0, Math.round((options.overlapMs ?? 1_500) / FRAME_MS));
    // Shorter than the pause that ends a sentence, because the point is to cut at any gap at all
    // rather than only at a deliberate one: in continuous conversation there is no 900ms silence
    // inside twelve seconds, so every window closed on the clock and every stitch lost a word.
    this.hangoverMs = options.hangoverMs ?? 450;
  }

  getStats(): SpeechTranscriberStats { return { ...this.stats }; }

  acceptPcm(pcm: Buffer): void {
    const buffer = this.carry.length > 0 ? Buffer.concat([this.carry, pcm]) : pcm;
    let offset = 0;
    while (offset + FRAME_BYTES <= buffer.length) {
      this.acceptFrame(buffer.subarray(offset, offset + FRAME_BYTES));
      offset += FRAME_BYTES;
    }
    this.carry = offset < buffer.length ? Buffer.from(buffer.subarray(offset)) : Buffer.alloc(0);
  }

  /** Sends whatever is buffered — used when the stream stops rather than on a pause. */
  flush(): void {
    if (this.window.length > 0) this.closeWindow();
  }

  reset(): void {
    this.overlap = [];
    this.window = [];
    this.windowMsFilled = 0;
    this.audibleMs = 0;
    this.trailingQuietMs = 0;
    this.carry = Buffer.alloc(0);
  }

  private acceptFrame(frame: Buffer): void {
    const audible = rms(frame) >= this.audibleRms;
    this.window.push(Buffer.from(frame));
    this.windowMsFilled += FRAME_MS;
    if (audible) {
      this.audibleMs += FRAME_MS;
      this.trailingQuietMs = 0;
    } else {
      this.trailingQuietMs += FRAME_MS;
    }

    // A pause is a good place to cut, so a sentence arrives whole; the window length is the
    // backstop for someone who never pauses.
    const pausedAfterSpeech = this.trailingQuietMs >= this.hangoverMs && this.audibleMs >= this.minSegmentMs;
    if (pausedAfterSpeech || this.windowMsFilled >= this.windowMs) this.closeWindow();
  }

  private closeWindow(): void {
    const frames = this.window;
    const pcm = Buffer.concat([...this.overlap, ...frames]);
    const { audibleMs, windowMsFilled } = this;
    this.overlap = this.overlapFrames > 0 ? frames.slice(-this.overlapFrames) : [];
    this.window = [];
    this.windowMsFilled = 0;
    this.audibleMs = 0;
    this.trailingQuietMs = 0;
    // Nothing but a dead stream in it. Uploading that costs money for no transcript and invites an
    // invented sentence in return.
    if (audibleMs < this.minSegmentMs) {
      this.stats.silenceSecondsSkipped += windowMsFilled / 1000;
      return;
    }
    // Two at a time absorbs a slow answer without letting a backlog build: the model runs far
    // faster than real time, and a third window means the stream is outrunning transcription.
    if (this.inFlight >= 2) {
      this.logger.warn('Dropped an audio window because transcription was still busy', {
        windowMs: windowMsFilled, inFlight: this.inFlight,
      });
      this.stats.silenceSecondsSkipped += windowMsFilled / 1000;
      return;
    }
    void this.transcribe(pcm, windowMsFilled);
  }

  /**
   * What a listener would already know before hearing this window.
   *
   * Names alone were not enough: a stream about carrying a power bank around Shanghai produced
   * "Парис" for a nickname, "Тайкофф", "по скрбе", and павербанк spelled two different ways in
   * consecutive windows. Given the subject, what is on screen, and the words this conversation
   * keeps using, those stop being guesses.
   */
  private buildHint(): string {
    const names = (this.options.vocabulary?.() ?? []).filter(Boolean).slice(0, 40);
    const previous = this.recentTranscripts.slice(-2).join(' ').slice(-300);
    return [
      this.options.streamContext?.() ? `Stream: ${this.options.streamContext?.()}` : '',
      this.options.currentScene?.() ? `On screen: ${this.options.currentScene?.()}` : '',
      names.length > 0 ? `Names: ${names.join(', ')}` : '',
      this.recurringWords().length > 0 ? `Words this conversation keeps using: ${this.recurringWords().join(', ')}` : '',
      previous ? `Said just before this: ${previous}` : '',
    ].filter(Boolean).join('\n');
  }

  /**
   * Words the last few minutes kept returning to, which is where the mishearing hurts most: a term
   * the stream says ten times should not be spelled three ways.
   */
  private recurringWords(): string[] {
    const counts = new Map<string, number>();
    for (const line of this.recentTranscripts) {
      for (const word of line.toLowerCase().match(/[\p{L}\p{N}-]{4,}/gu) ?? []) {
        counts.set(word, (counts.get(word) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .filter(([, count]) => count >= 3)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12)
      .map(([word]) => word);
  }

  private async transcribe(pcm: Buffer, audioMs: number): Promise<void> {
    this.inFlight += 1;
    this.stats.segmentsSent += 1;
    this.stats.audioSecondsSent += audioMs / 1000;
    const startedAt = Date.now();
    try {
      const result = await this.options.backend.transcribe(wav(pcm), this.buildHint());
      const latencyMs = Date.now() - startedAt;
      this.options.onUsage?.({
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
        audioSeconds: audioMs / 1000,
        failed: false,
      });
      const text = withoutRepeatedTail(this.stats.lastTranscript, result.text);
      if (!text) return;
      this.stats.transcriptsReceived += 1;
      this.stats.lastTranscript = text;
      this.recentTranscripts.push(text);
      if (this.recentTranscripts.length > 12) this.recentTranscripts.shift();
      this.stats.lastLatencyMs = latencyMs;
      await this.options.onTranscript(text, { audioMs, latencyMs });
    } catch (cause) {
      this.stats.failures += 1;
      this.options.onUsage?.({ audioSeconds: audioMs / 1000, failed: true });
      this.logger.warn('Speech transcription failed', { audioMs, cause });
    } finally {
      this.inFlight -= 1;
    }
  }
}

function rms(frame: Buffer): number {
  let sum = 0;
  for (let offset = 0; offset + 1 < frame.length; offset += BYTES_PER_SAMPLE) {
    const sample = frame.readInt16LE(offset) / 32_768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / (frame.length / BYTES_PER_SAMPLE));
}

function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Removes the words the overlap made the model say twice.
 *
 * Windows deliberately repeat a second and a half of audio so a word cut by the clock survives, and
 * the model duly transcribes that second twice: one window ended "Не знаю, всё нормально" and the
 * next began with the same phrase, which reached the decision layer as a stutter. The audio overlap
 * is worth keeping; its echo in the text is not.
 */
export function withoutRepeatedTail(previous: string | undefined, next: string | undefined): string | undefined {
  const text = next?.trim();
  if (!text) return undefined;
  const tail = previous?.trim();
  if (!tail) return text;
  const normalise = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
  const flatTail = normalise(tail);
  const flatText = normalise(text);
  // Longest overlap first, so "Не знаю, всё нормально" wins over the single word "нормально".
  for (let length = Math.min(120, flatTail.length, flatText.length); length >= 12; length -= 1) {
    const candidate = flatTail.slice(-length);
    if (!flatText.startsWith(candidate)) continue;
    // Walk the original text until the same number of comparable characters has been consumed, so
    // punctuation and casing survive on whatever is left.
    let seen = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (normalise(text[index]!).length > 0) seen += 1;
      if (seen >= candidate.replace(/ /g, '').length) {
        const rest = text.slice(index + 1).replace(/^[\s,.!?:;-]+/u, '').trim();
        return rest.length >= 3 ? rest : undefined;
      }
    }
    return undefined;
  }
  return text;
}
