import { Logger } from '../logger';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export interface SceneDescription {
  text?: string;
  /** What the call cost, when the service reports it. Beats any local price table. */
  costUsd?: number;
}

export interface SceneDescriber {
  readonly name: string;
  describe(jpeg: Buffer, hint: string): Promise<SceneDescription>;
}

export interface OpenRouterSceneDescriberOptions {
  apiKey: string;
  model: string;
  appUrl?: string;
  appName?: string;
  fetchImpl?: typeof fetch;
}

/**
 * One frame in, one sentence out, with nothing retained between calls.
 *
 * The layer this replaces held a live video stream and re-read its whole retained window on every
 * turn, which made watching the largest single line on the bill. A frame described on its own is
 * paid for once, and at these prices a description costs a fraction of a cent.
 */
export class OpenRouterSceneDescriber implements SceneDescriber {
  readonly name = 'openrouter';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenRouterSceneDescriberOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async describe(jpeg: Buffer, hint: string): Promise<SceneDescription> {
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
            { type: 'text', text: instruction(hint) },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
          ],
        }],
        max_tokens: 120,
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
    const text = body.choices?.[0]?.message?.content?.trim();
    return {
      ...(text && text.length >= 3 ? { text: text.replace(/\s+/g, ' ') } : {}),
      ...(typeof body.usage?.cost === 'number' ? { costUsd: body.usage.cost } : {}),
    };
  }
}

function instruction(hint: string): string {
  return 'Опиши одним коротким предложением, что видно на кадре трансляции: где человек находится, '
    + 'что делает, что заметного в кадре. Только то, что действительно видно — не додумывай, '
    + 'не описывай интерфейс трансляции и не упоминай, что это кадр или скриншот.'
    + (hint ? `\nЧто было видно до этого: ${hint}` : '');
}

export interface SceneWatcherOptions {
  describer: SceneDescriber;
  logger: Logger;
  /** Called with each new description, whether or not it differs from the last. */
  onScene: (description: string, meta: { latencyMs: number; changed: boolean }) => void;
  /** Every look, described or not, so the bill is counted where it is actually incurred. */
  onUsage?: (usage: { costUsd?: number; failed: boolean }) => void;
  /** How often the scene is looked at. Every look costs a call, so this is the whole cost knob. */
  intervalMs?: number;
  now?: () => number;
}

export interface SceneWatcherStats {
  described: number;
  failures: number;
  framesSeen: number;
  lastDescription?: string;
  lastDescribedAt?: number;
  lastLatencyMs?: number;
}

/**
 * Watching as sampling rather than as streaming.
 *
 * Only the newest frame is kept; everything that arrived while a description was in flight is
 * dropped rather than queued, because a stale frame is worth nothing and paying to describe it
 * twice is worse. On a stream that has stopped sending frames nothing is described at all.
 */
export class SceneWatcher {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private latest?: Buffer;
  private describing = false;
  private timer?: NodeJS.Timeout;
  private readonly stats: SceneWatcherStats = { described: 0, failures: 0, framesSeen: 0 };

  constructor(private readonly options: SceneWatcherOptions) {
    this.logger = options.logger.child('VISION');
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 25_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.describeLatest('scheduled'); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.latest = undefined;
  }

  acceptFrame(jpeg: Buffer): void {
    if (jpeg.length === 0) return;
    this.stats.framesSeen += 1;
    this.latest = jpeg;
    // The first frame of a stream is described immediately: waiting a full interval to learn where
    // we are means the first thing anyone says is answered against nothing.
    if (this.stats.described === 0 && !this.describing) void this.describeLatest('first_frame');
  }

  /** Looks now rather than at the next tick — used when something said suggests it is worth it. */
  lookNow(): void { void this.describeLatest('on_demand'); }

  getStats(): SceneWatcherStats { return { ...this.stats }; }
  currentScene(): string | undefined { return this.stats.lastDescription; }

  private async describeLatest(reason: 'scheduled' | 'first_frame' | 'on_demand'): Promise<void> {
    const frame = this.latest;
    if (!frame || this.describing) return;
    // Dropped rather than described twice: without this the on-demand look and the timer can both
    // pay for the same frame.
    this.latest = undefined;
    this.describing = true;
    const startedAt = this.now();
    try {
      const previous = this.stats.lastDescription;
      const result = await this.options.describer.describe(frame, previous ?? '');
      this.options.onUsage?.({
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
        failed: false,
      });
      const description = result.text;
      if (!description) return;
      const latencyMs = this.now() - startedAt;
      const changed = description !== previous;
      this.stats.described += 1;
      this.stats.lastDescription = description;
      this.stats.lastDescribedAt = this.now();
      this.stats.lastLatencyMs = latencyMs;
      this.logger.info('Scene described', { reason, description, latencyMs, changed });
      this.options.onScene(description, { latencyMs, changed });
    } catch (cause) {
      this.stats.failures += 1;
      this.options.onUsage?.({ failed: true });
      this.logger.warn('Scene description failed', { reason, cause });
    } finally {
      this.describing = false;
    }
  }
}
