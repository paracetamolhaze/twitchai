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
export interface TranscriptionResult {
  text?: string;
  /** What the call cost, when the service reports it. Beats any local price table. */
  costUsd?: number;
}

export interface TranscriptionBackend {
  readonly name: string;
  /** `hint` carries the previous transcript and the names in play; a backend may ignore it. */
  transcribe(wav: Buffer, hint: string): Promise<TranscriptionResult>;
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

  async transcribe(wav: Buffer, hint: string): Promise<TranscriptionResult> {
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
      usage?: { cost?: number };
    };
    if (!response.ok || body.error) {
      throw new Error(`${response.status} ${body.error?.message ?? response.statusText}`);
    }
    const text = clean(body.choices?.[0]?.message?.content);
    return {
      ...(text ? { text } : {}),
      ...(typeof body.usage?.cost === 'number' ? { costUsd: body.usage.cost } : {}),
    };
  }

  /**
   * Asks who is speaking as well as what was said.
   *
   * An IRL stream is several people talking across each other, and one undivided blob left the
   * decision layer unable to tell the streamer from the friend beside him: "Закажи. Тебе надо, ты и
   * заказывай. Знаешь, такой бред" is two people arguing, read as one voice. Labelling by role
   * rather than by index is what makes it usable — each window is transcribed on its own, so
   * "speaker 1" would mean a different person in the next one, while S is always whoever holds the
   * camera. Measured on a real window it also transcribed better and cost less than asking for a
   * plain transcript: the whole idiom instead of a truncated one, at 55% of the price.
   */
  private instruction(hint: string): string {
    const language = this.options.language && this.options.language !== 'auto'
      ? `The speech is in ${this.options.language}. `
      : '';
    return `${language}Transcribe the whole recording from the first word to the last, leaving nothing out. `
      + 'No translation, no summary, no commentary, no quotation marks. '
      + 'Several people may talk. Start each turn with "S: " for the person holding the camera and '
      + 'streaming, or "O: " for anyone else. If nobody is speaking, answer with an empty line.'
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

  async transcribe(wav: Buffer, hint: string): Promise<TranscriptionResult> {
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
      const text = clean(result.text);
      return text ? { text } : {};
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
