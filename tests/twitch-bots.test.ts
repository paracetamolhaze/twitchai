import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { PersonaStore } from '../src/personas/persona-store';
import { Logger } from '../src/logger';
import { TwitchBotManager, TwitchChatClient } from '../src/twitch/bot-manager';
import { TwitchTokenValidator } from '../src/twitch/oauth-validator';

class FakeClient extends EventEmitter {
  sent: string[] = [];
  async connect(): Promise<[string, number]> {
    this.emit('connected', 'localhost', 443);
    const username = (this as FakeClient & { username?: string }).username ?? '';
    this.emit('join', '#channel', username, true);
    return ['localhost', 443];
  }
  async disconnect(): Promise<void> { this.emit('disconnected', 'test shutdown'); }
  async say(_channel: string, message: string): Promise<[string]> { this.sent.push(message); return [message]; }
}

describe('TwitchBotManager isolation', () => {
  async function setup(accounts: Array<{ username: string; oauthToken: string; enabled: boolean }>) {
    const repository = new MemoryRepository();
    const personas = new PersonaStore(repository);
    await personas.initialize();
    const clients = new Map<string, FakeClient>();
    const validator: TwitchTokenValidator = {
      async validate(token) {
        if (token === 'bad') throw new Error('invalid token');
        return { login: token, userId: token, scopes: ['chat:read', 'chat:edit'], expiresIn: 3600 };
      },
    };
    const manager = new TwitchBotManager({
      channel: 'channel', repository, personas, validator, logger: new Logger('TEST', 'error'),
      accounts: accounts.map((account) => ({ ...account, personaId: 'analyst' })),
      clientFactory: (options) => {
        const username = options.identity?.username ?? 'unknown';
        const client = new FakeClient();
        (client as FakeClient & { username?: string }).username = username;
        clients.set(username, client);
        return client as unknown as TwitchChatClient;
      },
    });
    await manager.initialize();
    await manager.start();
    return { manager, clients };
  }

  it('keeps healthy accounts connected when one token fails', async () => {
    const { manager } = await setup([
      { username: 'good', oauthToken: 'good', enabled: true },
      { username: 'broken', oauthToken: 'bad', enabled: true },
    ]);
    expect(manager.listStatuses().find((bot) => bot.username === 'good')?.connectionState).toBe('CONNECTED');
    expect(manager.listStatuses().find((bot) => bot.username === 'broken')?.connectionState).toBe('ERROR');
    await manager.stop();
  });

  it('tracks reconnect state and recovery', async () => {
    const { manager, clients } = await setup([{ username: 'good', oauthToken: 'good', enabled: true }]);
    clients.get('good')?.emit('reconnect');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.listStatuses()[0]?.connectionState).toBe('CONNECTING');
    clients.get('good')?.emit('connected', 'localhost', 443);
    clients.get('good')?.emit('join', '#channel', 'good', true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.listStatuses()[0]?.connectionState).toBe('CONNECTED');
    await manager.stop();
  });

  it('never sends through a disabled account', async () => {
    const { manager } = await setup([{ username: 'disabled', oauthToken: 'disabled', enabled: false }]);
    expect(manager.listStatuses()[0]?.connectionState).toBe('DISABLED');
    expect(await manager.send('disabled', 'hello')).toBe(false);
    await manager.stop();
  });
});
