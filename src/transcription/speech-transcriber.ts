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
    this.hangoverMs = options.hangoverMs ?? 900;
    this.minSegmentMs = options.minSegmentMs ?? 600;
    this.windowMs = options.windowMs ?? 12_000;
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
    const pcm = Buffer.concat(this.window);
    const { audibleMs, windowMsFilled } = this;
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

  private buildHint(): string {
    const names = (this.options.vocabulary?.() ?? []).filter(Boolean).slice(0, 40);
    const previous = this.stats.lastTranscript?.slice(-200);
    return [
      names.length > 0 ? `Names: ${names.join(', ')}` : '',
      previous ? `Previous line: ${previous}` : '',
    ].filter(Boolean).join('. ');
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
      const text = result.text;
      if (!text) return;
      this.stats.transcriptsReceived += 1;
      this.stats.lastTranscript = text;
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
