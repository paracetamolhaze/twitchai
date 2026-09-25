import { describe, expect, it, vi } from 'vitest';
import { Application } from '../src/application';
import { loadConfig } from '../src/config';

describe('application pause boundary', () => {
  it('invalidates hearing, buffered speech and vision when the operator stops bots', async () => {
    const app = new Application(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }));
    const transcriber = { reset: vi.fn() };
    const speechEvents = { stop: vi.fn() };
    const sceneWatcher = { stop: vi.fn() };
    const perception = { reconfigureMedia: vi.fn<(channel: string, fps: number) => Promise<void>>(async () => undefined) };
    Object.assign(app, { transcriber, speechEvents, sceneWatcher,
      coordinator: { clearPendingContexts: vi.fn(), logSessionSummary: vi.fn() },
      perception, startCategoryMonitor: vi.fn(),
      botManager: { stop: vi.fn(async () => undefined), reconfigureChannel: vi.fn(async () => undefined) },
    });
    await (app as unknown as { updateSettings(input: Record<string, unknown>): Promise<unknown> }).updateSettings({ paused: true });
    expect(transcriber.reset).toHaveBeenCalledOnce();
    expect(speechEvents.stop).toHaveBeenCalledOnce();
    expect(sceneWatcher.stop).toHaveBeenCalledOnce();
    perception.reconfigureMedia.mockClear();
    await (app as unknown as { updateSettings(input: Record<string, unknown>): Promise<unknown> }).updateSettings({ channel: 'new-channel' });
    expect(perception.reconfigureMedia).toHaveBeenCalledOnce();
    expect(perception.reconfigureMedia.mock.calls[0]?.[0]).toBe('');
  });
});
