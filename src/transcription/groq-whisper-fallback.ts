import { createReadStream } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Groq from 'groq-sdk';
import { Logger } from '../logger';

export interface GroqWhisperFallbackOptions {
  apiKey: string;
  language: string;
  chunkSeconds?: number;
  logger: Logger;
  onTranscript: (text: string) => void | Promise<void>;
}

export class GroqWhisperFallback {
  private readonly groq: Groq;
  private readonly logger: Logger;
  private readonly targetBytes: number;
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private transcribing = false;

  constructor(private readonly options: GroqWhisperFallbackOptions) {
    this.groq = new Groq({ apiKey: options.apiKey });
    this.logger = options.logger.child('TRANSCRIPTION');
    this.targetBytes = Math.max(10, options.chunkSeconds ?? 20) * 16_000 * 2;
  }

  acceptPcm(pcm: Buffer): void {
    this.chunks.push(Buffer.from(pcm));
    this.bufferedBytes += pcm.length;
    if (this.bufferedBytes >= this.targetBytes && !this.transcribing) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.transcribing || this.bufferedBytes === 0) return;
    this.transcribing = true;
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    this.bufferedBytes = 0;
    const file = path.join(os.tmpdir(), `twitch-ai-${randomUUID()}.wav`);
    try {
      await writeFile(file, wav(pcm));
      const request: Parameters<typeof this.groq.audio.transcriptions.create>[0] = {
        file: createReadStream(file),
        model: 'whisper-large-v3',
        response_format: 'json',
        ...(this.options.language && this.options.language !== 'auto' ? { language: this.options.language } : {}),
      };
      const result = await this.groq.audio.transcriptions.create(request);
      const text = result.text?.trim();
      if (text && text.length >= 3) await this.options.onTranscript(text);
    } catch (cause) {
      this.logger.warn('Optional Groq Whisper transcription failed', { cause });
    } finally {
      await unlink(file).catch(() => undefined);
      this.transcribing = false;
      if (this.bufferedBytes >= this.targetBytes) void this.flush();
    }
  }
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
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
