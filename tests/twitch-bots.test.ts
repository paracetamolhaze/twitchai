import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { PersonaStore } from '../src/personas/persona-store';
import { generatePersonaV3 } from '../src/personas/generator-v3';
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

class BlockingBotRepository extends MemoryRepository {
  private nextBotWrite?: { started: () => void; wait: Promise<void> };

  blockNextBotWrite(): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.nextBotWrite = { started: markStarted, wait };
    return { started, release };
  }

  override async upsertBot(bot: Parameters<MemoryRepository['upsertBot']>[0]): Promise<void> {
    const gate = this.nextBotWrite;
    if (gate) {
      this.nextBotWrite = undefined;
      gate.started();
      await gate.wait;
    }
    await super.upsertBot(bot);
  }
}

describe('TwitchBotManager isolation', () => {
  async function setup(
    accounts: Array<{ username: string; oauthToken: string; enabled: boolean }>,
    storedPersonaId?: string,
    storedEnabled?: boolean,
    repository: MemoryRepository = new MemoryRepository(),
  ) {
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

  it('keeps every account out of chat while the operator has the system stopped', async () => {
    // Connecting has three entry points besides start(): enabling an account, adding one, and
    // refreshing its OAuth credential. That last one runs on a timer, and production showed three
    // accounts rejoining a stopped system across twenty minutes with nobody touching anything.
    const { manager, clients } = await setup([
      { username: 'gigantiuz', oauthToken: 'gigantiuz', enabled: true },
    ]);
    await manager.stop();
    clients.clear();

    await manager.upsertAuthorizedAccount({ username: 'gigantiuz', oauthToken: 'gigantiuz', enabled: true, personaId: 'analyst' });
    expect(clients.size).toBe(0);
    await manager.setEnabled('gigantiuz', true);
    expect(clients.size).toBe(0);
    expect(manager.listStatuses()[0]?.chatConnected).toBe(false);

    // And they come back the moment it is started again.
    await manager.start();
    expect(manager.listStatuses()[0]?.connectionState).toBe('CONNECTED');
    await manager.stop();
  });

  it('keeps healthy accounts connected when one token fails', async () => {
    const { manager } = await setup([
      { username: 'gigantiuz', oauthToken: 'gigantiuz', enabled: true },
      { username: 'supercser2', oauthToken: 'bad', enabled: true },
    ], 'persona-that-no-longer-exists');
    expect(manager.listStatuses().find((bot) => bot.username === 'gigantiuz')?.connectionState).toBe('CONNECTED');
    expect(manager.listStatuses().find((bot) => bot.username === 'gigantiuz')?.personaId).not.toBe('persona-that-no-longer-exists');
    expect(new Set(manager.listStatuses().map((bot) => bot.personaId)).size).toBe(2);
    expect(manager.listStatuses().find((bot) => bot.username === 'supercser2')?.connectionState).toBe('ERROR');
    await manager.stop();
  });

  it('tracks reconnect state and recovery', async () => {
    const { manager, clients } = await setup([{ username: 'gigantiuz', oauthToken: 'gigantiuz', enabled: true }]);
    clients.get('gigantiuz')?.emit('reconnect');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.listStatuses()[0]?.connectionState).toBe('CONNECTING');
    clients.get('gigantiuz')?.emit('connected', 'localhost', 443);
    clients.get('gigantiuz')?.emit('join', '#channel', 'gigantiuz', true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.listStatuses()[0]?.connectionState).toBe('CONNECTED');
    await manager.stop();
  });

  it('never sends through a disabled account', async () => {
    const { manager } = await setup([{ username: 'gigantiuz', oauthToken: 'gigantiuz', enabled: false }]);
    expect(manager.listStatuses()[0]?.connectionState).toBe('DISABLED');
    expect(await manager.send('gigantiuz', 'hello')).toEqual({ submitted: false, reason: 'account_unavailable' });
    await manager.stop();
  });

  it('returns the Twitch submission timestamp before bot-status persistence finishes', async () => {
    const repository = new BlockingBotRepository();
    const { manager } = await setup(
      [{ username: 'gigantiuz', oauthToken: 'gigantiuz', enabled: true }],
      undefined,
      undefined,
      repository,
    );
    const gate = repository.blockNextBotWrite();
    const sendPromise = manager.send('gigantiuz', 'без искусственной паузы');

    await gate.started;
    await Promise.resolve();
    const result = await sendPromise;

    expect(result).toEqual({ submitted: true, submittedAt: expect.any(Number) });
    expect(manager.listStatuses()[0]).toMatchObject({
      messagesSent: 1,
      lastMessage: 'без искусственной паузы',
      lastReactionAt: result.submitted ? result.submittedAt : undefined,
    });

    gate.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await manager.stop();
  });

  it('does not let stale persisted state re-enable a config-disabled account', async () => {
    const { manager } = await setup(
      [{ username: 'gigantiuz', oauthToken: 'gigantiuz', enabled: false }],
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
      { username: 'gigantiuz', oauthToken: 'gigantiuz', enabled: true },
      { username: 'supercser2', oauthToken: 'supercser2', enabled: true },
    ]);
    const [one, two] = manager.listStatuses();
    expect(one?.personaId).not.toBe(two?.personaId);
    expect(await manager.assignPersona('supercser2', one!.personaId)).toBe('persona_username_mismatch');
    expect(await manager.assignPersona('supercser2', 'missing-persona')).toBe('persona_not_found');
    const manualSource = generatePersonaV3('supercser2', { id: 'operator-authored-free-persona' });
    const free = await personas.create({
      ...manualSource,
      source: 'manual',
      generatedFromUsername: undefined,
      manuallyEdited: true,
      manualOverrides: [],
    });
    expect(await manager.assignPersona('supercser2', free.id)).toBe('updated');
    expect(manager.listStatuses().find((bot) => bot.username === 'supercser2')?.personaId).toBe(free.id);
    await manager.stop();
  });

  it('keeps an unknown username disabled until its manual persona is complete', async () => {
    const { manager } = await setup([{ username: 'unreviewed_account', oauthToken: 'unreviewed_account', enabled: true }]);
    expect(manager.listStatuses()[0]).toMatchObject({ enabled: false, connectionState: 'DISABLED', chatConnected: false });
    expect(manager.listStatuses()[0]?.lastError).toMatch(/Заполните и проверьте/);
    expect(await manager.setEnabled('unreviewed_account', true)).toBe('persona_incomplete');
    await manager.stop();
  });

  it('disconnects an active account when an operator edit breaks its persona mapping', async () => {
    const { manager, personas } = await setup([{ username: 'gigantiuz', oauthToken: 'gigantiuz', enabled: true }]);
    const status = manager.listStatuses()[0]!;
    const edited = personas.get(status.personaId);
    edited.identity.nickname = 'another_account';
    await personas.update(edited);

    await manager.revalidatePersona(status.personaId);

    expect(manager.listStatuses()[0]).toMatchObject({ enabled: false, connectionState: 'DISABLED', chatConnected: false });
    expect(manager.listStatuses()[0]?.lastError).toMatch(/другого Twitch-аккаунта/);
    await manager.stop();
  });
});
