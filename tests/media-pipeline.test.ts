import { EventEmitter } from 'node:events';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { MediaPipeline, MediaPipelineState } from '../src/stream-brain/media-pipeline';

describe('MediaPipeline', () => {
  it('classifies Streamlink no-playable-stream output as OFFLINE', async () => {
    const streamlink = fakeChildProcess();
    const ffmpeg = fakeChildProcess(true);
    let streamlinkArgs: string[] = [];

    spawnMock
      .mockImplementationOnce((_command: string, args: string[]) => {
        streamlinkArgs = args;
        setImmediate(() => {
          // Streamlink 8.4 suppresses even errors with --quiet. This fake mirrors
          // that behavior so the lifecycle test catches an unusable invocation.
          if (!args.includes('--quiet')) {
            streamlink.stderr?.write('[cli][error] No playable streams found on this URL');
          }
          streamlink.exitCode = 1;
          streamlink.emit('close', 1);
        });
        return streamlink;
      })
      .mockImplementationOnce(() => ffmpeg);

    let resolveTerminal!: (state: MediaPipelineState) => void;
    const terminalState = new Promise<MediaPipelineState>((resolve) => { resolveTerminal = resolve; });
    const pipeline = new MediaPipeline({
      channel: 'offline_channel',
      visionFps: 1,
      frameWidth: 640,
      reconnectMinimumMs: 10_000,
      reconnectMaximumMs: 10_000,
      logger: new Logger('TEST', 'error'),
      handlers: {
        onAudio: () => undefined,
        onVideo: () => undefined,
        onState: (state) => {
          if (state === 'OFFLINE' || state === 'ERROR') resolveTerminal(state);
        },
      },
    });

    pipeline.start();
    const state = await terminalState;
    await pipeline.stop();

    expect(state).toBe('OFFLINE');
    expect(streamlinkArgs).toContain('--loglevel');
    expect(streamlinkArgs).toContain('error');
    expect(streamlinkArgs).not.toContain('--quiet');
  });
});

function fakeChildProcess(withMediaPipes = false): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const audio = new PassThrough();
  const video = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.stdio = withMediaPipes
    ? [stdin, null, stderr, audio, video]
    : [null, stdout, stderr, null, null];
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.exitCode = 0;
    return true;
  });
  return child;
}
