import { NonRealTimeVAD } from '@ricky0123/vad-node';

export interface SpeechPresence { hasSpeech(pcm: Buffer): Promise<boolean> }

/** Local acoustic check, independent of generative transcription and its hints.
 * This is not speaker identification: voices in songs/videos may still count as speech. */
export class LocalSpeechPresence implements SpeechPresence {
  private model?: Promise<NonRealTimeVAD>;
  private queue: Promise<unknown> = Promise.resolve();

  hasSpeech(pcm: Buffer): Promise<boolean> {
    const check = this.queue.then(async () => {
      this.model ??= NonRealTimeVAD.new({ positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35,
        minSpeechFrames: 3, preSpeechPadFrames: 1, redemptionFrames: 4 });
      const vad = await this.model;
      const samples = new Float32Array(Math.floor(pcm.length / 2));
      for (let i = 0; i < samples.length; i += 1) samples[i] = pcm.readInt16LE(i * 2) / 32768;
      let found = false;
      // Exhaust the generator so endSegment resets the model between independent windows.
      for await (const segment of vad.run(samples, 16_000)) if (segment.audio.length > 0) found = true;
      return found;
    });
    this.queue = check.catch(() => { this.model = undefined; });
    return check;
  }
}
