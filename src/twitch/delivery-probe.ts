import { Logger } from '../logger';
import { ChatMessage } from '../stream-brain/types';

export interface DeliveryProbeAccount {
  username: string;
  enabled: boolean;
  connectionState: string;
  chatConnected: boolean;
}

export interface DeliveryProbeSender {
  send: (username: string, message: string) => Promise<{ submitted: boolean; reason?: string }>;
  listStatuses: () => DeliveryProbeAccount[];
  getChatReader: () => string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Node's EventEmitter signature
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Node's EventEmitter signature
  off: (event: string, listener: (...args: any[]) => void) => unknown;
}

export interface DeliveryProbeAccountResult {
  username: string;
  /** The number this account was told to post, 1-based in the order accounts were probed. */
  index: number;
  /** Exactly what was posted, so the channel can be read back by eye against this report. */
  message: string;
  skipped?: 'not_enabled' | 'not_connected';
  submitted: boolean;
  submitFailureReason?: string;
  /** True only when the message came back through the reader account. */
  delivered: boolean;
  /** Twitch's own msg-id when it explicitly refused, e.g. msg_banned. */
  rejectionReason?: string;
  /**
   * The reader account sees its own messages echoed locally by tmi.js rather than received from
   * Twitch, so its result cannot distinguish delivered from silently dropped.
   */
  selfEchoUnreliable?: boolean;
}

export interface DeliveryProbeReport {
  channel: string;
  startedAt: number;
  finishedAt: number;
  reader?: string;
  totalAccounts: number;
  delivered: number;
  notDelivered: number;
  /** Every chat message the reader observed while probing, from anyone, including our own. */
  observedChatMessages: number;
  /**
   * Whether "not delivered" can be trusted at all.
   *
   * A silenced account and a broken observation path produce the identical result — nothing comes
   * back — so the probe proves its own eyes work before reporting anything as dropped. tmi.js
   * echoes the reader's own message locally without Twitch involvement, so that one message must
   * always be observed; if even it never arrives, the wiring is at fault and no conclusion about
   * Twitch is available.
   */
  detectionVerified: boolean;
  detectionWarning?: string;
  accounts: DeliveryProbeAccountResult[];
}

export interface DeliveryProbeOptions {
  sender: DeliveryProbeSender;
  logger: Logger;
  channel: () => string;
  /** Gap between accounts. Sending them at once is the pattern Twitch treats as spam. */
  stepMs?: number;
  /** How long to keep waiting for echoes after the last account has been sent. */
  echoWindowMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

/**
 * Posts one short message from every configured account, one at a time, and reports which of them
 * the channel actually showed.
 *
 * This exists because Twitch never acknowledges a message: `say()` resolving only means the bytes
 * reached the socket, so an account silenced by a shadowban looks exactly like a healthy one. The
 * only evidence available is the reader account receiving the message back, which is what this
 * correlates. It deliberately bypasses the reaction pipeline — that path caps replies per event,
 * applies per-persona cooldowns and lets the Brain choose who speaks, none of which can produce
 * "every account posts exactly once".
 */
export class DeliveryProbe {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly stepMs: number;
  private readonly echoWindowMs: number;
  private running = false;

  constructor(private readonly options: DeliveryProbeOptions) {
    this.logger = options.logger.child('DELIVERY_PROBE');
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.stepMs = options.stepMs ?? 2_000;
    this.echoWindowMs = options.echoWindowMs ?? 10_000;
  }

  isRunning(): boolean { return this.running; }

  async run(): Promise<DeliveryProbeReport> {
    if (this.running) throw new Error('delivery_probe_already_running');
    this.running = true;
    const startedAt = this.now();
    const channel = this.options.channel();
    const reader = this.options.sender.getChatReader();
    const accounts = this.options.sender.listStatuses();
    const results = new Map<string, DeliveryProbeAccountResult>();

    let observedChatMessages = 0;
    let readerSawItsOwnMessage = false;
    const onChat = (message: ChatMessage): void => {
      observedChatMessages += 1;
      if (message.kind !== 'bot') return;
      const result = results.get(message.username.toLowerCase());
      if (!result || message.message.trim() !== result.message) return;
      result.delivered = true;
      if (result.selfEchoUnreliable) readerSawItsOwnMessage = true;
    };
    const onRejected = ({ username, msgid }: { username: string; msgid: string }): void => {
      const result = results.get(username.toLowerCase());
      if (result) result.rejectionReason = msgid;
    };
    this.options.sender.on('chat', onChat);
    this.options.sender.on('sendRejected', onRejected);

    try {
      let index = 0;
      for (const account of accounts) {
        index += 1;
        const key = account.username.toLowerCase();
        const message = String(index);
        const base: DeliveryProbeAccountResult = {
          username: account.username, index, message, submitted: false, delivered: false,
          ...(reader && key === reader.toLowerCase() ? { selfEchoUnreliable: true } : {}),
        };
        results.set(key, base);

        if (!account.enabled) { base.skipped = 'not_enabled'; continue; }
        if (account.connectionState !== 'CONNECTED' || !account.chatConnected) {
          base.skipped = 'not_connected';
          continue;
        }
        const outcome = await this.options.sender.send(account.username, message);
        base.submitted = outcome.submitted;
        if (!outcome.submitted && outcome.reason) base.submitFailureReason = outcome.reason;
        this.logger.info('Delivery probe message sent', {
          bot: account.username, index, submitted: outcome.submitted,
        });
        // Spacing matters here as much as in a normal batch: a burst from every account at once is
        // exactly the pattern that gets them silenced, which would corrupt the very measurement.
        await this.wait(this.stepMs);
      }
      await this.wait(this.echoWindowMs);
    } finally {
      this.options.sender.off('chat', onChat);
      this.options.sender.off('sendRejected', onRejected);
      this.running = false;
    }

    const accountResults = [...results.values()].map(({ ...result }) => result);
    const delivered = accountResults.filter((result) => result.delivered).length;
    const readerWasProbed = accountResults.some((result) => result.selfEchoUnreliable && result.submitted);
    // Positive proof the observation path works: either something was seen come back, or the
    // reader's locally generated echo of its own message arrived. Without either, "nothing was
    // delivered" describes this probe's eyes, not Twitch, and must not be reported as a verdict.
    const detectionVerified = delivered > 0 || observedChatMessages > 0
      || (readerWasProbed ? readerSawItsOwnMessage : false);
    const detectionWarning = detectionVerified ? undefined
      : !reader
        ? 'Ни один аккаунт не читает чат, поэтому доставку проверить нечем — результат ничего не доказывает.'
        : readerWasProbed
          ? 'Читающий аккаунт не получил даже собственное сообщение, хотя оно подставляется локально. Сломана связь с чатом на нашей стороне, а не Twitch — результат ничего не доказывает.'
          : 'За время проверки не пришло ни одного сообщения чата, так что подтвердить доставку было нечем — результат ничего не доказывает.';
    const report: DeliveryProbeReport = {
      channel,
      startedAt,
      finishedAt: this.now(),
      ...(reader ? { reader } : {}),
      totalAccounts: accountResults.length,
      delivered,
      notDelivered: accountResults.filter((result) => result.submitted && !result.delivered).length,
      observedChatMessages,
      detectionVerified,
      ...(detectionWarning ? { detectionWarning } : {}),
      accounts: accountResults,
    };
    this.logger.info('Delivery probe finished', {
      channel, total: report.totalAccounts, delivered: report.delivered, notDelivered: report.notDelivered,
      observedChatMessages, detectionVerified,
    });
    if (!detectionVerified) this.logger.warn('Delivery probe could not verify its own observation path', { channel, reader });
    return report;
  }
}
