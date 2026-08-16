import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Logger } from '../src/logger';
import { DeliveryProbe, DeliveryProbeAccount } from '../src/twitch/delivery-probe';

class FakeSender extends EventEmitter {
  readonly sent: Array<{ username: string; message: string }> = [];

  constructor(
    private readonly accounts: DeliveryProbeAccount[],
    private readonly behaviour: (username: string, message: string) => void = () => {},
    private readonly reader?: string,
  ) { super(); }

  getChatReader(): string | undefined { return this.reader; }
  listStatuses(): DeliveryProbeAccount[] { return this.accounts; }

  async send(username: string, message: string): Promise<{ submitted: boolean; reason?: string }> {
    this.sent.push({ username, message });
    this.behaviour(username, message);
    return { submitted: true };
  }

  /** Stands in for Twitch showing the message and the reader account receiving it back. */
  echo(username: string, message: string): void {
    this.emit('chat', { id: '1', timestamp: 1, username, displayName: username, message, kind: 'bot' });
  }

  refuse(username: string, msgid: string): void {
    this.emit('sendRejected', { username, msgid, notice: msgid });
  }
}

function account(username: string, overrides: Partial<DeliveryProbeAccount> = {}): DeliveryProbeAccount {
  return { username, enabled: true, connectionState: 'CONNECTED', chatConnected: true, ...overrides };
}

function probe(sender: FakeSender): DeliveryProbe {
  return new DeliveryProbe({
    sender,
    logger: new Logger('TEST', 'error'),
    channel: () => 'gudini_younger',
    // Real time is irrelevant to what this measures, so the waits collapse.
    wait: async () => {},
    stepMs: 0,
    echoWindowMs: 0,
  });
}

describe('DeliveryProbe', () => {
  it('posts a number from every account and reports which ones the channel showed', async () => {
    // Only some accounts echo back — the rest were accepted by Twitch and silently never shown,
    // which is exactly the shadowban signature this exists to expose.
    const sender = new FakeSender(
      [account('bot_one'), account('bot_two'), account('bot_three')],
      (username, message) => { if (username !== 'bot_two') sender.echo(username, message); },
    );
    const report = await probe(sender).run();

    expect(sender.sent).toEqual([
      { username: 'bot_one', message: '1' },
      { username: 'bot_two', message: '2' },
      { username: 'bot_three', message: '3' },
    ]);
    expect(report.channel).toBe('gudini_younger');
    expect(report.delivered).toBe(2);
    expect(report.notDelivered).toBe(1);
    expect(report.accounts.map(({ username, index, delivered }) => ({ username, index, delivered }))).toEqual([
      { username: 'bot_one', index: 1, delivered: true },
      { username: 'bot_two', index: 2, delivered: false },
      { username: 'bot_three', index: 3, delivered: true },
    ]);
  });

  it('records the reason when Twitch refuses outright', async () => {
    const sender = new FakeSender([account('bot_one')], (username) => sender.refuse(username, 'msg_banned'));
    const report = await probe(sender).run();
    expect(report.accounts[0]).toMatchObject({ username: 'bot_one', delivered: false, rejectionReason: 'msg_banned' });
  });

  it('sends nothing from accounts that are disabled or not in chat, and says which', async () => {
    const sender = new FakeSender([
      account('bot_one', { enabled: false }),
      account('bot_two', { chatConnected: false }),
      account('bot_three', { connectionState: 'DISCONNECTED' }),
    ]);
    const report = await probe(sender).run();
    expect(sender.sent).toEqual([]);
    expect(report.accounts.map(({ skipped }) => skipped)).toEqual(['not_enabled', 'not_connected', 'not_connected']);
    expect(report.notDelivered).toBe(0);
  });

  it('flags the reader account, whose own echo is generated locally rather than received', async () => {
    // tmi.js emits the reader's own messages back without Twitch involvement, so a "delivered"
    // result for that one account proves nothing and must not be read as evidence.
    const sender = new FakeSender(
      [account('reader_bot'), account('bot_two')],
      (username, message) => sender.echo(username, message),
      'reader_bot',
    );
    const report = await probe(sender).run();
    expect(report.reader).toBe('reader_bot');
    expect(report.accounts[0]).toMatchObject({ username: 'reader_bot', selfEchoUnreliable: true });
    expect(report.accounts[1]?.selfEchoUnreliable).toBeUndefined();
  });

  it('refuses to run twice at once so two reports cannot claim the same messages', async () => {
    const sender = new FakeSender([account('bot_one')]);
    const running = probe(sender);
    const first = running.run();
    await expect(running.run()).rejects.toThrow('delivery_probe_already_running');
    await first;
  });
});
