import { createReadStream } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Groq from 'groq-sdk';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * One segment of speech in, its words out. Deliberately narrow: the segmenting, the silence gate
 * and the hint are the same whichever service is listening, so swapping one for the other is a
 * configuration value rather than a rewrite.
 */
export interface TranscriptionBackend {
  readonly name: string;
  /** `hint` carries the previous transcript and the names in play; a backend may ignore it. */
  transcribe(wav: Buffer, hint: string): Promise<string | undefined>;
}

export interface OpenRouterTranscriptionOptions {
  apiKey: string;
  model: string;
  language: string;
  appUrl?: string;
  appName?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Hearing through the same account that does the thinking.
 *
 * Gemini bills audio input by the second of speech, and with silence already cut this comes to a
 * couple of cents an hour. There is no transcription endpoint — audio is simply a content part of
 * an ordinary chat turn, which is also why the hint works at all: the model is told what was said
 * a moment ago and which names to expect, and stops guessing at proper nouns.
 */
export class OpenRouterTranscriptionBackend implements TranscriptionBackend {
  readonly name = 'openrouter';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenRouterTranscriptionOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(wav: Buffer, hint: string): Promise<string | undefined> {
    const response = await this.fetchImpl(OPENROUTER_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
        ...(this.options.appUrl ? { 'HTTP-Referer': this.options.appUrl } : {}),
        ...(this.options.appName ? { 'X-Title': this.options.appName } : {}),
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: this.instruction(hint) },
            { type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } },
          ],
        }],
        // Transcription, not conversation: no room to editorialise and nothing to think about.
        max_tokens: 400,
        temperature: 0,
      }),
    });
    const body = await response.json() as {
      error?: { message?: string };
      choices?: Array<{ message?: { content?: string } }>;
    };
    if (!response.ok || body.error) {
      throw new Error(`${response.status} ${body.error?.message ?? response.statusText}`);
    }
    return clean(body.choices?.[0]?.message?.content);
  }

  private instruction(hint: string): string {
    const language = this.options.language && this.options.language !== 'auto'
      ? `The speech is in ${this.options.language}. `
      : '';
    return `${language}Write down exactly what is said in this audio and nothing else. `
      + 'No translation, no summary, no speaker labels, no commentary, no quotation marks. '
      + 'If nobody is speaking, answer with an empty line.'
      + (hint ? `\nContext for names and terms only, never to be repeated back: ${hint}` : '');
  }
}

export interface GroqTranscriptionOptions {
  apiKey: string;
  model: string;
  language: string;
}

/** A dedicated speech model, kept as the alternative for when a general one mishears. */
export class GroqWhisperBackend implements TranscriptionBackend {
  readonly name = 'groq';
  private readonly groq: Groq;

  constructor(private readonly options: GroqTranscriptionOptions) {
    this.groq = new Groq({ apiKey: options.apiKey });
  }

  async transcribe(wav: Buffer, hint: string): Promise<string | undefined> {
    const file = path.join(os.tmpdir(), `twitch-ai-${randomUUID()}.wav`);
    try {
      await writeFile(file, wav);
      const result = await this.groq.audio.transcriptions.create({
        file: createReadStream(file),
        model: this.options.model,
        response_format: 'json',
        ...(hint ? { prompt: hint } : {}),
        ...(this.options.language && this.options.language !== 'auto'
          ? { language: this.options.language }
          : {}),
      });
      return clean(result.text);
    } finally {
      await unlink(file).catch(() => undefined);
    }
  }
}

/**
 * Both services answer silence with something rather than nothing — Whisper with a plausible
 * invented sentence, a chat model with a note that it heard no speech. Neither is a transcript.
 */
function clean(value?: string): string | undefined {
  const text = value?.trim().replace(/^["«»']+|["«»']+$/g, '').trim();
  if (!text || text.length < 3) return undefined;
  if (/^\(?(no speech|silence|inaudible|тишина|неразборчиво)\b/i.test(text)) return undefined;
  return text;
}
