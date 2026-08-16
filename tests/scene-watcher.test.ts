import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger';
import { SceneWatcher } from '../src/vision/scene-watcher';

afterEach(() => vi.useRealTimers());

function watcher(describe_: (frame: Buffer, hint: string) => Promise<string | undefined>, intervalMs = 25_000) {
  // The backend returns a result object; these fixtures speak in plain sentences.
  const wrap = async (frame: Buffer, hint: string) => ({ text: await describe_(frame, hint) });
  const scenes: Array<{ description: string; changed: boolean }> = [];
  const describer = vi.fn(wrap);
  const instance = new SceneWatcher({
    describer: { name: 'test', describe: describer },
    logger: new Logger('TEST', 'error'),
    onScene: (description, meta) => scenes.push({ description, changed: meta.changed }),
    intervalMs,
  });
  return { instance, scenes, describer };
}

const frame = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

describe('SceneWatcher', () => {
  it('describes the first frame at once instead of waiting out the interval', async () => {
    // Waiting a full interval to learn where we are means the first thing anyone says is answered
    // against nothing.
    const { instance, scenes, describer } = watcher(async () => 'Мужчина сидит за столом в кафе.');
    instance.acceptFrame(frame);
    await vi.waitFor(() => expect(scenes).toHaveLength(1));
    expect(describer).toHaveBeenCalledTimes(1);
    expect(scenes[0]?.description).toBe('Мужчина сидит за столом в кафе.');
    instance.stop();
  });

  it('describes on its own schedule once running, and never while a look is still in flight', async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let peak = 0;
    const { instance, describer } = watcher(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      inFlight -= 1;
      return 'Улица, вечер, люди идут мимо.';
    }, 5_000);
    instance.start();
    instance.acceptFrame(frame);
    for (let tick = 0; tick < 6; tick += 1) {
      instance.acceptFrame(frame);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(peak).toBe(1);
    expect(describer.mock.calls.length).toBeLessThanOrEqual(2);
    instance.stop();
  });

  it('says nothing at all when the stream has stopped sending frames', async () => {
    vi.useFakeTimers();
    const { instance, describer } = watcher(async () => 'что-то', 1_000);
    instance.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(describer).not.toHaveBeenCalled();
    instance.stop();
  });

  it('reports whether the scene actually changed, so an unchanged one stays quiet', async () => {
    const answers = ['Мужчина сидит за столом в кафе.', 'Мужчина сидит за столом в кафе.'];
    const { instance, scenes } = watcher(async () => answers.shift());
    instance.acceptFrame(frame);
    await vi.waitFor(() => expect(scenes).toHaveLength(1));
    expect(scenes[0]?.changed).toBe(true);
    instance.lookNow();
    instance.acceptFrame(frame);
    instance.lookNow();
    await vi.waitFor(() => expect(scenes).toHaveLength(2));
    expect(scenes[1]?.changed).toBe(false);
    instance.stop();
  });

  it('tells the model what it last saw, so a description reads as a change rather than a restart', async () => {
    const hints: string[] = [];
    const answers = ['Мужчина ест в кафе.', 'Мужчина вышел на улицу.'];
    const { instance, scenes } = watcher(async (_frame, hint) => { hints.push(hint); return answers.shift(); });
    instance.acceptFrame(frame);
    // Waiting on the description rather than the hint: a look asked for while one is still in
    // flight is dropped, which is deliberate — two looks at the same moment cost twice.
    await vi.waitFor(() => expect(scenes).toHaveLength(1));
    expect(hints[0]).toBe('');
    instance.acceptFrame(frame);
    instance.lookNow();
    await vi.waitFor(() => expect(hints).toHaveLength(2));
    expect(hints[1]).toBe('Мужчина ест в кафе.');
    instance.stop();
  });

  it('keeps working after a failed look instead of going quiet for the rest of the stream', async () => {
    let call = 0;
    const { instance, scenes } = watcher(async () => {
      call += 1;
      if (call === 1) throw new Error('502 upstream');
      return 'Кухня, человек готовит.';
    });
    instance.acceptFrame(frame);
    await vi.waitFor(() => expect(instance.getStats().failures).toBe(1));
    instance.acceptFrame(frame);
    instance.lookNow();
    await vi.waitFor(() => expect(scenes).toHaveLength(1));
    instance.stop();
  });
});
