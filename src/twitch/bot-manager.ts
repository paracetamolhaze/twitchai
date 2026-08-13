import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import tmi from 'tmi.js';
import { BotAccountConfig } from '../config';
import { Logger } from '../logger';
import { PersonaStore } from '../personas/persona-store';
import { AppRepository, BotAccountRecord } from '../persistence/repository';
import { ReactionBotCandidate } from '../reaction/types';
import { ChatMessage } from '../stream-brain/types';
import { OfficialTwitchTokenValidator, TwitchTokenValidator } from './oauth-validator';

interface ManagedBot {
  config: BotAccountConfig;
  client?: TwitchChatClient;
  status: BotAccountRecord;
  sentAt: number[];
}

export interface TwitchBotManagerOptions {
  channel: string;
  accounts: BotAccountConfig[];
  repository: AppRepository;
  personas: PersonaStore;
  logger: Logger;
  validator?: TwitchTokenValidator;
  clientFactory?: (options: tmi.Options) => TwitchChatClient;
}

export type TwitchChatClient = Pick<tmi.Client, 'connect' | 'disconnect' | 'say' | 'on'>;

export class TwitchBotManager extends EventEmitter {
  private readonly bots = new Map<string, ManagedBot>();
  private readonly logger: Logger;
  private readonly validator: TwitchTokenValidator;
  private readerUsername?: string;
  private channel: string;

  constructor(private readonly options: TwitchBotManagerOptions) {
    super();
    this.logger = options.logger.child('TWITCH');
    this.validator = options.validator ?? new OfficialTwitchTokenValidator();
    this.channel = options.channel;
    for (const account of options.accounts) {
      this.bots.set(account.username, {
        config: account,
        sentAt: [],
        status: {
          username: account.username,
          personaId: account.personaId,
          enabled: account.enabled,
          connectionState: account.enabled ? 'DISCONNECTED' : 'DISABLED',
          chatConnected: false,
          messagesSent: 0,
        },
      });
    }
  }

  async initialize(): Promise<void> {
    const stored = new Map((await this.options.repository.listBots()).map((bot) => [bot.username, bot]));
    for (const [index, bot] of [...this.bots.values()].entries()) {
      const configuredPersonaId = this.options.personas.get(bot.config.personaId, index).id;
      const previous = stored.get(bot.config.username);
      if (!previous) {
        bot.config.personaId = configuredPersonaId;
        bot.status.personaId = configuredPersonaId;
        continue;
      }
      // Environment configuration is the safety ceiling: an account imported as
      // ineligible (for example, because its token lacks modern chat scopes)
      // must not be re-enabled by stale persisted dashboard state.
      bot.config.enabled = bot.config.enabled && previous.enabled;
      bot.config.personaId = this.options.personas.has(previous.personaId)
        ? previous.personaId
        : configuredPersonaId;
      bot.status = {
        ...bot.status,
        personaId: bot.config.personaId,
        enabled: bot.config.enabled,
        connectionState: bot.config.enabled ? 'DISCONNECTED' : 'DISABLED',
        messagesSent: previous.messagesSent,
        ...(previous.lastMessage ? { lastMessage: previous.lastMessage } : {}),
        ...(previous.lastReactionAt ? { lastReactionAt: previous.lastReactionAt } : {}),
      };
    }
    await Promise.all([...this.bots.values()].map((bot) => this.persist(bot)));
  }

  async start(): Promise<void> {
    if (!this.channel) return;
    await Promise.allSettled([...this.bots.values()].map((bot) => this.connectBot(bot)));
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.bots.values()].map(async (bot) => {
      try { await bot.client?.disconnect(); } catch { /* already disconnected */ }
      bot.client = undefined;
      await this.patch(bot, {
        connectionState: bot.config.enabled ? 'DISCONNECTED' : 'DISABLED',
        chatConnected: false,
      });
    }));
    this.readerUsername = undefined;
  }

  async reconfigureChannel(channel: string): Promise<void> {
    if (channel === this.channel) return;
    await this.stop();
    this.channel = channel;
    if (channel) await this.start();
  }

  listStatuses(): BotAccountRecord[] { return [...this.bots.values()].map((bot) => structuredClone(bot.status)); }

  candidates(): ReactionBotCandidate[] {
    return [...this.bots.values()].map((bot, index) => ({
      username: bot.config.username,
      persona: this.options.personas.get(bot.config.personaId, index),
      enabled: bot.status.enabled,
      connectionState: bot.status.connectionState,
      chatConnected: bot.status.chatConnected,
      ...(bot.status.lastReactionAt ? { lastReactionAt: bot.status.lastReactionAt } : {}),
    }));
  }

  async setEnabled(username: string, enabled: boolean): Promise<boolean> {
    const bot = this.bots.get(username.toLowerCase());
    if (!bot) return false;
    bot.config.enabled = enabled;
    if (!enabled) {
      try { await bot.client?.disconnect(); } catch { /* no-op */ }
      bot.client = undefined;
      await this.patch(bot, { enabled: false, connectionState: 'DISABLED', chatConnected: false });
    } else {
      await this.patch(bot, { enabled: true, connectionState: 'DISCONNECTED', chatConnected: false });
      void this.connectBot(bot);
    }
    return true;
  }

  async send(username: string, message: string): Promise<boolean> {
    const bot = this.bots.get(username.toLowerCase());
    if (!bot?.client || bot.status.connectionState !== 'CONNECTED' || !bot.status.chatConnected) return false;
    const now = Date.now();
    bot.sentAt = bot.sentAt.filter((at) => at > now - 30_000);
    if (bot.sentAt.length >= 18 || now - (bot.sentAt.at(-1) ?? 0) < 1_100) {
      this.logger.warn('Bot message blocked by local Twitch rate limiter', { bot: username });
      return false;
    }
    try {
      await bot.client.say(`#${this.channel}`, message);
      bot.sentAt.push(Date.now());
      await this.patch(bot, {
        messagesSent: bot.status.messagesSent + 1,
        lastMessage: message,
        lastReactionAt: Date.now(),
        lastError: undefined,
      });
      return true;
    } catch (cause) {
      await this.patch(bot, { lastError: cause instanceof Error ? cause.message : String(cause) });
      this.logger.warn('Twitch message send failed', { bot: username, cause });
      return false;
    }
  }

  private async connectBot(bot: ManagedBot): Promise<void> {
    if (!bot.config.enabled || bot.client) return;
    await this.patch(bot, { connectionState: 'CONNECTING', chatConnected: false, lastError: undefined });
    try {
      const validated = await this.validator.validate(bot.config.oauthToken);
      if (validated.login !== bot.config.username) throw new Error(`OAuth token belongs to ${validated.login}, not ${bot.config.username}`);
      const clientOptions: tmi.Options = {
        options: { debug: false, skipUpdatingEmotesets: true },
        identity: {
          username: bot.config.username,
          password: bot.config.oauthToken.startsWith('oauth:') ? bot.config.oauthToken : `oauth:${bot.config.oauthToken}`,
        },
        channels: [this.channel],
        connection: {
          secure: true,
          reconnect: true,
          reconnectDecay: 1.5,
          reconnectInterval: 2_000,
          maxReconnectInterval: 30_000,
          maxReconnectAttempts: Infinity,
        },
      };
      const client = this.options.clientFactory?.(clientOptions) ?? new tmi.Client(clientOptions);
      bot.client = client;
      client.on('connected', () => {
        void this.patch(bot, { connectionState: 'CONNECTED', chatConnected: false, lastError: undefined });
        this.logger.info('Bot IRC connected; waiting for channel join', { bot: bot.config.username, channel: this.channel });
      });
      client.on('join', (channel, username, self) => {
        if (!self || username.toLowerCase() !== bot.config.username || channel.replace(/^#/, '').toLowerCase() !== this.channel) return;
        if (!this.readerUsername) this.readerUsername = bot.config.username;
        void this.patch(bot, { connectionState: 'CONNECTED', chatConnected: true, lastError: undefined });
        this.logger.info('Bot chat joined', { bot: bot.config.username, channel: this.channel });
      });
      client.on('part', (channel, username, self) => {
        if (!self || username.toLowerCase() !== bot.config.username || channel.replace(/^#/, '').toLowerCase() !== this.channel) return;
        if (this.readerUsername === bot.config.username) this.chooseReader(bot.config.username);
        void this.patch(bot, { chatConnected: false, lastError: 'Bot left the Twitch channel' });
      });
      client.on('reconnect', () => { void this.patch(bot, { connectionState: 'CONNECTING', chatConnected: false }); });
      client.on('disconnected', (reason) => {
        if (this.readerUsername === bot.config.username) this.chooseReader(bot.config.username);
        void this.patch(bot, { connectionState: bot.config.enabled ? 'DISCONNECTED' : 'DISABLED', chatConnected: false, lastError: reason });
      });
      client.on('message', (_channel, tags, message, self) => {
        if (this.readerUsername !== bot.config.username) return;
        const username = (tags.username ?? tags['display-name'] ?? 'unknown').toLowerCase();
        const chat: ChatMessage = {
          id: tags.id ?? randomUUID(),
          timestamp: Number(tags['tmi-sent-ts'] ?? Date.now()),
          username,
          displayName: tags['display-name'] ?? username,
          message,
          kind: self || this.bots.has(username) ? 'bot' : 'viewer',
        };
        this.emit('chat', chat);
      });
      await client.connect();
    } catch (cause) {
      bot.client = undefined;
      const lastError = cause instanceof Error ? cause.message : String(cause);
      await this.patch(bot, { connectionState: 'ERROR', chatConnected: false, lastError });
      this.logger.error('Bot connection failed', { bot: bot.config.username, cause });
    }
  }

  private chooseReader(excluding: string): void {
    this.readerUsername = [...this.bots.values()].find((candidate) =>
      candidate.config.username !== excluding && candidate.status.connectionState === 'CONNECTED' && candidate.status.chatConnected,
    )?.config.username;
  }

  private async patch(bot: ManagedBot, patch: Partial<BotAccountRecord>): Promise<void> {
    bot.status = { ...bot.status, ...patch };
    try {
      await this.persist(bot);
    } catch (cause) {
      this.logger.warn('Bot status persistence failed', { bot: bot.config.username, cause });
    }
    this.emit('status', this.listStatuses());
  }

  private async persist(bot: ManagedBot): Promise<void> { await this.options.repository.upsertBot(bot.status); }
}
