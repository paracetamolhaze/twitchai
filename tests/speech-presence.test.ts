import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { LocalSpeechPresence } from '../src/transcription/speech-presence';

describe('local speech detector with real acoustic inputs', () => {
  it('hears known speech, including quiet speech, and resets between windows', async () => {
    const speech = gunzipSync(readFileSync('tests/fixtures/synthetic-speech.pcm.gz'));
    const quiet = Buffer.from(speech);
    for (let i = 0; i < quiet.length; i += 2) quiet.writeInt16LE(Math.round(quiet.readInt16LE(i) / 8), i);
    const vad = new LocalSpeechPresence();
    expect(await vad.hasSpeech(speech)).toBe(true);
    expect(await vad.hasSpeech(Buffer.alloc(speech.length))).toBe(false);
    expect(await vad.hasSpeech(quiet)).toBe(true);
  }, 15000);
});
