import { createReadStream } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Groq from 'groq-sdk';
import { Logger } from '../logger';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE / 1000) * FRAME_MS * BYTES_PER_SAMPLE;

export interface SpeechTranscriberOptions {
  apiKey: string;
  language: string;
  model?: string;
  logger: Logger;
  onTranscript: (text: string, meta: { audioMs: number; latencyMs: number }) => void | Promise<void>;
  /** Loudness a frame must clear to count as speech, relative to the measured noise floor. */
  speechFloorRatio?: number;
  /** How far back the quietest moment is looked for when estimating the room. */
  noiseWindowMs?: number;
  /** Audio spent measuring the room before anything is treated as speech. */
  warmupMs?: number;
  /** Absolute floor, so a silent stream never counts as speech no matter how quiet the room. */
  minimumSpeechRms?: number;
  /** Silence that ends a segment. Long enough to keep a thinking-out-loud speaker in one piece. */
  hangoverMs?: number;
  /** Audio kept from before speech was detected, so the first word is not clipped. */
  preRollMs?: number;
  /** Segments shorter than this are noise, not speech, and are never sent. */
  minSegmentMs?: number;
  /** A speaker who never pauses still gets cut here, so a transcript always arrives. */
  maxSegmentMs?: number;
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
 * A speech segment is cut locally and transcribed on its own: nothing is retained between
 * segments, so a second of audio is paid for exactly once. The layer this replaces was a
 * stateful session that re-read its whole retained window on every turn, which billed roughly
 * eight times for each second of speech and could go deaf while still reporting itself connected.
 *
 * Silence is dropped before it ever leaves the machine. That is most of an IRL stream, and it
 * also removes the failure Whisper is known for: given silence, it invents plausible sentences.
 */
export class SpeechTranscriber {
  private readonly groq: Groq;
  private readonly logger: Logger;
  private readonly model: string;
  private readonly speechFloorRatio: number;
  private readonly minimumSpeechRms: number;
  private readonly hangoverMs: number;
  private readonly preRollMs: number;
  private readonly minSegmentMs: number;
  private readonly maxSegmentMs: number;

  /** Frames held while idle so a segment can start slightly before speech was recognised. */
  private preRoll: Buffer[] = [];
  private segment: Buffer[] = [];
  private segmentMs = 0;
  private voicedMs = 0;
  private trailingSilenceMs = 0;
  private carry = Buffer.alloc(0);
  private readonly recentLoudness: number[] = [];
  private noiseWindowFrames: number;
  private warmupFramesRemaining: number;
  private inFlight = 0;
  private readonly stats: SpeechTranscriberStats = {
    segmentsSent: 0,
    transcriptsReceived: 0,
    audioSecondsSent: 0,
    silenceSecondsSkipped: 0,
    failures: 0,
  };

  constructor(private readonly options: SpeechTranscriberOptions) {
    this.groq = new Groq({ apiKey: options.apiKey });
    this.logger = options.logger.child('TRANSCRIPTION');
    this.model = options.model ?? 'whisper-large-v3-turbo';
    this.speechFloorRatio = options.speechFloorRatio ?? 2.5;
    this.minimumSpeechRms = options.minimumSpeechRms ?? 0.012;
    this.hangoverMs = options.hangoverMs ?? 900;
    this.preRollMs = options.preRollMs ?? 300;
    this.minSegmentMs = options.minSegmentMs ?? 700;
    this.maxSegmentMs = options.maxSegmentMs ?? 15_000;
    this.noiseWindowFrames = Math.max(1, Math.round((options.noiseWindowMs ?? 6_000) / FRAME_MS));
    this.warmupFramesRemaining = Math.max(0, Math.round((options.warmupMs ?? 500) / FRAME_MS));
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

  /** Ends the current segment early — used when the stream stops rather than on a pause. */
  flush(): void {
    if (this.segment.length > 0) this.closeSegment();
  }

  reset(): void {
    this.preRoll = [];
    this.segment = [];
    this.segmentMs = 0;
    this.voicedMs = 0;
    this.trailingSilenceMs = 0;
    this.carry = Buffer.alloc(0);
  }

  private acceptFrame(frame: Buffer): void {
    const loudness = rms(frame);
    // The floor is the quietest moment in the last few seconds, not a fixed number: a market
    // street and a quiet kitchen sit several times apart in background level, and one fixed
    // threshold either misses the speech in the first or hears the traffic in the second. Speech
    // has gaps between syllables, so even an unbroken talker leaves the floor where it belongs.
    this.recentLoudness.push(loudness);
    if (this.recentLoudness.length > this.noiseWindowFrames) this.recentLoudness.shift();
    const threshold = Math.max(this.minimumSpeechRms, Math.min(...this.recentLoudness) * this.speechFloorRatio);
    // The first moment of a stream is spent measuring the room. Without it, a loud street is
    // simply "speech" from the first frame and every second of it gets uploaded.
    if (this.warmupFramesRemaining > 0) {
      this.warmupFramesRemaining -= 1;
      this.rememberPreRoll(frame);
      this.stats.silenceSecondsSkipped += FRAME_MS / 1000;
      return;
    }
    const speech = loudness >= threshold;

    if (this.segment.length === 0) {
      if (!speech) {
        this.rememberPreRoll(frame);
        this.stats.silenceSecondsSkipped += FRAME_MS / 1000;
        return;
      }
      this.segment = [...this.preRoll, Buffer.from(frame)];
      this.segmentMs = (this.preRoll.length + 1) * FRAME_MS;
      this.voicedMs = FRAME_MS;
      this.trailingSilenceMs = 0;
      this.preRoll = [];
      return;
    }

    this.segment.push(Buffer.from(frame));
    this.segmentMs += FRAME_MS;
    if (speech) {
      this.voicedMs += FRAME_MS;
      this.trailingSilenceMs = 0;
    } else {
      this.trailingSilenceMs += FRAME_MS;
    }

    if (this.trailingSilenceMs >= this.hangoverMs || this.segmentMs >= this.maxSegmentMs) {
      this.closeSegment();
    }
  }

  private rememberPreRoll(frame: Buffer): void {
    this.preRoll.push(Buffer.from(frame));
    const maxFrames = Math.max(1, Math.round(this.preRollMs / FRAME_MS));
    if (this.preRoll.length > maxFrames) this.preRoll.shift();
  }

  private closeSegment(): void {
    const pcm = Buffer.concat(this.segment);
    const { voicedMs, segmentMs } = this;
    this.segment = [];
    this.segmentMs = 0;
    this.voicedMs = 0;
    this.trailingSilenceMs = 0;
    if (voicedMs < this.minSegmentMs) {
      this.stats.silenceSecondsSkipped += segmentMs / 1000;
      return;
    }
    // Two at a time is enough to absorb a slow response without letting a backlog build up: the
    // segments are short and the model runs far faster than real time.
    if (this.inFlight >= 2) {
      this.logger.warn('Dropped a speech segment because transcription was still busy', {
        segmentMs, inFlight: this.inFlight,
      });
      return;
    }
    void this.transcribe(pcm, segmentMs);
  }

  private async transcribe(pcm: Buffer, audioMs: number): Promise<void> {
    this.inFlight += 1;
    this.stats.segmentsSent += 1;
    this.stats.audioSecondsSent += audioMs / 1000;
    const startedAt = Date.now();
    const file = path.join(os.tmpdir(), `twitch-ai-${randomUUID()}.wav`);
    try {
      await writeFile(file, wav(pcm));
      const request: Parameters<typeof this.groq.audio.transcriptions.create>[0] = {
        file: createReadStream(file),
        model: this.model,
        response_format: 'json',
        ...(this.options.language && this.options.language !== 'auto' ? { language: this.options.language } : {}),
      };
      const result = await this.groq.audio.transcriptions.create(request);
      const text = result.text?.trim();
      const latencyMs = Date.now() - startedAt;
      if (!text || text.length < 3) return;
      this.stats.transcriptsReceived += 1;
      this.stats.lastTranscript = text;
      this.stats.lastLatencyMs = latencyMs;
      await this.options.onTranscript(text, { audioMs, latencyMs });
    } catch (cause) {
      this.stats.failures += 1;
      this.logger.warn('Speech transcription failed', { audioMs, cause });
    } finally {
      await unlink(file).catch(() => undefined);
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
