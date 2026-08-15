import { ChildProcess, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { ExponentialBackoff } from '../shared/backoff';
import { Logger } from '../logger';

export type MediaPipelineState = 'STOPPED' | 'CONNECTING' | 'STREAMING' | 'OFFLINE' | 'ERROR';

export interface MediaPipelineHandlers {
  onAudio: (pcm: Buffer, durationMs: number) => void | Promise<void>;
  onVideo: (jpeg: Buffer, durationMs: number) => void | Promise<void>;
  onState?: (state: MediaPipelineState, error?: string) => void;
}

export interface MediaPipelineOptions {
  channel: string;
  visionFps: number;
  frameWidth: number;
  handlers: MediaPipelineHandlers;
  logger: Logger;
  streamlinkBinary?: string;
  ffmpegBinary?: string;
  reconnectMinimumMs?: number;
  reconnectMaximumMs?: number;
}

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
const AUDIO_CHUNK_BYTES = 1_280; // 40ms, mono 16-bit PCM at 16kHz.

export class MediaPipeline {
  private readonly backoff: ExponentialBackoff;
  private readonly logger: Logger;
  private channel: string;
  private visionFps: number;
  private abortController?: AbortController;
  private streamlink?: ChildProcess;
  private ffmpeg?: ChildProcess;
  private state: MediaPipelineState = 'STOPPED';

  constructor(private readonly options: MediaPipelineOptions) {
    this.logger = options.logger.child('MEDIA');
    this.backoff = new ExponentialBackoff(
      options.reconnectMinimumMs ?? 3_000,
      options.reconnectMaximumMs ?? 60_000,
    );
    this.channel = options.channel;
    this.visionFps = options.visionFps;
  }

  getState(): MediaPipelineState { return this.state; }

  start(): void {
    if (this.abortController) return;
    this.abortController = new AbortController();
    void this.run(this.abortController.signal);
  }

  async stop(): Promise<void> {
    const controller = this.abortController;
    this.abortController = undefined;
    controller?.abort();
    await this.terminateChildren();
    this.setState('STOPPED');
  }

  async reconfigure(channel: string, visionFps: number): Promise<void> {
    const wasRunning = Boolean(this.abortController);
    await this.stop();
    this.channel = channel;
    this.visionFps = visionFps;
    this.backoff.reset();
    if (wasRunning && channel) this.start();
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.setState('CONNECTING');
      const result = await this.captureOnce(signal);
      if (signal.aborted) break;
      this.setState(result.offline ? 'OFFLINE' : 'ERROR', result.error);
      const delay = this.backoff.next();
      this.logger.warn('Media pipeline reconnect scheduled', { delayMs: delay, reason: result.error });
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, delay);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  private captureOnce(signal: AbortSignal): Promise<{ offline: boolean; error: string }> {
    return new Promise((resolve) => {
      const streamUrl = `https://www.twitch.tv/${this.channel}`;
      const streamlink = spawn(this.options.streamlinkBinary ?? 'streamlink', [
        '--loglevel', 'error',
        '--twitch-low-latency',
        streamUrl,
        'best,720p60,720p,worst',
        '--stdout',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const ffmpeg = spawn(this.options.ffmpegBinary ?? 'ffmpeg', [
        '-hide_banner', '-loglevel', 'warning', '-i', 'pipe:0',
        '-map', '0:a:0?', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:3',
        '-map', '0:v:0?', '-an', '-vf', `fps=${this.visionFps},scale=${this.options.frameWidth}:-2:force_original_aspect_ratio=decrease`,
        '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:4',
      ], { stdio: ['pipe', 'ignore', 'pipe', 'pipe', 'pipe'] });

      this.streamlink = streamlink;
      this.ffmpeg = ffmpeg;
      streamlink.stdout.pipe(ffmpeg.stdin!);

      let settled = false;
      let streamed = false;
      let streamlinkError = '';
      let ffmpegError = '';
      let audioBuffer = Buffer.alloc(0);
      let jpegBuffer = Buffer.alloc(0);

      const finish = (error: string): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        void this.terminateChildren();
        const combined = `${streamlinkError}\n${ffmpegError}\n${error}`.toLowerCase();
        const offline = /offline|no playable streams|no streams found/.test(combined);
        resolve({ offline, error: offline ? 'Twitch stream is offline' : error });
      };

      const abort = (): void => finish('Media pipeline stopped');
      signal.addEventListener('abort', abort, { once: true });

      streamlink.stderr.on('data', (chunk: Buffer) => {
        streamlinkError = `${streamlinkError}${chunk.toString('utf8')}`.slice(-4_000);
      });
      ffmpeg.stderr?.on('data', (chunk: Buffer) => {
        ffmpegError = `${ffmpegError}${chunk.toString('utf8')}`.slice(-4_000);
      });

      const audio = ffmpeg.stdio[3] as Readable;
      audio.on('data', (chunk: Buffer) => {
        if (!streamed) {
          streamed = true;
          this.backoff.reset();
          this.setState('STREAMING');
          this.logger.info('Stream media connected', { channel: this.channel });
        }
        audioBuffer = Buffer.concat([audioBuffer, chunk]);
        while (audioBuffer.length >= AUDIO_CHUNK_BYTES) {
          const pcm = audioBuffer.subarray(0, AUDIO_CHUNK_BYTES);
          audioBuffer = audioBuffer.subarray(AUDIO_CHUNK_BYTES);
          void Promise.resolve(this.options.handlers.onAudio(pcm, 40)).catch((cause: unknown) => {
            this.logger.warn('Audio consumer rejected a chunk', { cause });
          });
        }
      });

      const video = ffmpeg.stdio[4] as Readable;
      video.on('data', (chunk: Buffer) => {
        jpegBuffer = Buffer.concat([jpegBuffer, chunk]);
        while (jpegBuffer.length > 0) {
          const start = jpegBuffer.indexOf(JPEG_START);
          if (start < 0) {
            jpegBuffer = jpegBuffer.subarray(Math.max(0, jpegBuffer.length - 1));
            break;
          }
          const end = jpegBuffer.indexOf(JPEG_END, start + 2);
          if (end < 0) {
            if (start > 0) jpegBuffer = jpegBuffer.subarray(start);
            if (jpegBuffer.length > 5_000_000) jpegBuffer = Buffer.alloc(0);
            break;
          }
          const frame = jpegBuffer.subarray(start, end + 2);
          jpegBuffer = jpegBuffer.subarray(end + 2);
          void Promise.resolve(this.options.handlers.onVideo(frame, 1_000 / this.visionFps)).catch((cause: unknown) => {
            this.logger.warn('Video consumer rejected a frame', { cause });
          });
        }
      });

      streamlink.once('error', (error) => finish(`streamlink failed: ${error.message}`));
      ffmpeg.once('error', (error) => finish(`ffmpeg failed: ${error.message}`));
      streamlink.once('close', (code) => finish(`streamlink exited with code ${String(code)}`));
      ffmpeg.once('close', (code) => finish(`ffmpeg exited with code ${String(code)}`));
    });
  }

  private async terminateChildren(): Promise<void> {
    const children = [this.streamlink, this.ffmpeg].filter(Boolean) as ChildProcess[];
    this.streamlink = undefined;
    this.ffmpeg = undefined;
    for (const child of children) {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    }
    await Promise.all(children.map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 2_000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    })));
  }

  private setState(state: MediaPipelineState, error?: string): void {
    if (this.state === state && !error) return;
    this.state = state;
    this.options.handlers.onState?.(state, error);
  }
}
