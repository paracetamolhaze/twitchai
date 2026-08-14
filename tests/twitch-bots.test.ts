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
  async function setup(
    accounts: Array<{ username: string; oauthToken: string; enabled: boolean }>,
    storedPersonaId?: string,
    storedEnabled?: boolean,
  ) {
    const repository = new MemoryRepository();
    const personas = new PersonaStore(repository);
    await personas.initialize();
    if (storedPersonaId && accounts[0]) {
      await repository.upsertBot({
        username: accounts[0].username, personaId: storedPersonaId,
        enabled: storedEnabled ?? accounts[0].enabled,
        connectionState: 'DISCONNECTED', chatConnected: false, messagesSent: 0,
      });
    }
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
    return { manager, clients, personas };
  }

  it('keeps healthy accounts connected when one token fails', async () => {
    const { manager } = await setup([
      { username: 'good', oauthToken: 'good', enabled: true },
      { username: 'broken', oauthToken: 'bad', enabled: true },
    ], 'persona-that-no-longer-exists');
    expect(manager.listStatuses().find((bot) => bot.username === 'good')?.connectionState).toBe('CONNECTED');
    expect(manager.listStatuses().find((bot) => bot.username === 'good')?.personaId).not.toBe('persona-that-no-longer-exists');
    expect(new Set(manager.listStatuses().map((bot) => bot.personaId)).size).toBe(2);
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

  it('does not let stale persisted state re-enable a config-disabled account', async () => {
    const { manager } = await setup(
      [{ username: 'legacy', oauthToken: 'legacy', enabled: false }],
      'analyst',
      true,
    );
    expect(manager.listStatuses()[0]).toMatchObject({
      enabled: false,
      connectionState: 'DISABLED',
      chatConnected: false,
    });
    await manager.stop();
  });

  it('validates one-to-one persona assignment without a restart', async () => {
    const { manager, personas } = await setup([
      { username: 'one', oauthToken: 'one', enabled: true },
      { username: 'two', oauthToken: 'two', enabled: true },
    ]);
    const [one, two] = manager.listStatuses();
    expect(one?.personaId).not.toBe(two?.personaId);
    expect(await manager.assignPersona('two', one!.personaId)).toBe('persona_in_use');
    expect(await manager.assignPersona('two', 'missing-persona')).toBe('persona_not_found');
    const free = personas.list().find((persona) => !manager.listStatuses().some((bot) => bot.personaId === persona.id))!;
    expect(await manager.assignPersona('two', free.id)).toBe('updated');
    expect(manager.listStatuses().find((bot) => bot.username === 'two')?.personaId).toBe(free.id);
    await manager.stop();
  });
});
