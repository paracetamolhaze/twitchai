import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import tmi from 'tmi.js';
import { BotAccountConfig } from '../config';
import { Logger } from '../logger';
import { PersonaAssignmentProblem, PersonaStore } from '../personas/persona-store';
import { AppRepository, BotAccountRecord } from '../persistence/repository';
import { ReactionBotCandidate, ReactionSendResult } from '../reaction/types';
import { ChatMessage } from '../stream-brain/types';
import { OfficialTwitchTokenValidator, TwitchTokenValidator } from './oauth-validator';
import { TwitchAccessTokenProvider } from './oauth-service';

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
  credentialProvider?: TwitchAccessTokenProvider;
  clientFactory?: (options: tmi.Options) => TwitchChatClient;
}

export type TwitchChatClient = Pick<tmi.Client, 'connect' | 'disconnect' | 'say' | 'on'>;
export type PersonaAssignmentResult = 'updated' | 'bot_not_found' | 'persona_not_found' | 'persona_in_use' | PersonaAssignmentProblem;
export type BotEnabledResult = 'updated' | 'bot_not_found' | PersonaAssignmentProblem;

/**
 * NOTICE msg-ids that mean Twitch refused to show a message we sent. Everything else (room-state
 * announcements, host notices) is informational and must not be reported as a delivery failure.
 */
const SEND_REJECTION_NOTICES = new Set([
  'msg_banned', 'msg_bad_characters', 'msg_channel_blocked', 'msg_channel_suspended',
  'msg_duplicate', 'msg_emoteonly', 'msg_facebook', 'msg_followersonly',
  'msg_followersonly_followed', 'msg_followersonly_zero', 'msg_r9k', 'msg_ratelimit',
  'msg_rejected', 'msg_rejected_mandatory', 'msg_slowmode', 'msg_subsonly', 'msg_suspended',
  'msg_timedout', 'msg_verified_email', 'msg_requires_verified_phone_number',
]);

export class TwitchBotManager extends EventEmitter {
  private readonly bots = new Map<string, ManagedBot>();
  private readonly persistenceTails = new WeakMap<ManagedBot, Promise<void>>();
  private readonly logger: Logger;
  /** Whether the operator has the system running. Nothing joins chat while this is false. */
  private running = false;
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
    const managedUsernames = new Set(this.bots.keys());
    const usedPersonaIds = new Set([...stored.values()]
      .filter((bot) => !managedUsernames.has(bot.username))
      .map((bot) => bot.personaId));
    for (const bot of this.bots.values()) {
      const previous = stored.get(bot.config.username);
      const preferredPersonaId = previous?.personaId ?? bot.config.personaId;
      const persona = await this.options.personas.ensureUniqueForAccount(bot.config.username, preferredPersonaId, usedPersonaIds);
      usedPersonaIds.add(persona.id);
      bot.config.personaId = persona.id;
      bot.status.personaId = persona.id;
      if (previous) {
        // Environment configuration is the safety ceiling: an account imported as
        // ineligible (for example, because its token lacks modern chat scopes)
        // must not be re-enabled by stale persisted dashboard state.
        bot.config.enabled = bot.config.enabled && previous.enabled;
        bot.status = {
          ...bot.status,
          enabled: bot.config.enabled,
          connectionState: bot.config.enabled ? 'DISCONNECTED' : 'DISABLED',
          messagesSent: previous.messagesSent,
          ...(previous.lastMessage ? { lastMessage: previous.lastMessage } : {}),
          ...(previous.lastReactionAt ? { lastReactionAt: previous.lastReactionAt } : {}),
        };
      }
      const assignmentProblem = this.options.personas.assignmentProblem(bot.config.username, persona.id);
      if (assignmentProblem) {
        bot.config.enabled = false;
        bot.status = {
          ...bot.status,
          enabled: false,
          connectionState: 'DISABLED',
          chatConnected: false,
          lastError: assignmentProblemMessage(assignmentProblem),
        };
      }
    }
    await Promise.all([...this.bots.values()].map((bot) => this.persist(bot)));
  }

  async start(): Promise<void> {
    if (!this.channel) return;
    this.running = true;
    await Promise.allSettled([...this.bots.values()].map((bot) => this.connectBot(bot)));
  }

  async stop(): Promise<void> {
    this.running = false;
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
    return [...this.bots.values()].map((bot) => ({
      username: bot.config.username,
      persona: this.options.personas.get(bot.config.personaId),
      enabled: bot.status.enabled,
      connectionState: bot.status.connectionState,
      chatConnected: bot.status.chatConnected,
      ...(bot.status.lastReactionAt ? { lastReactionAt: bot.status.lastReactionAt } : {}),
    }));
  }

  async setEnabled(username: string, enabled: boolean): Promise<BotEnabledResult> {
    const bot = this.bots.get(username.toLowerCase());
    if (!bot) return 'bot_not_found';
    if (enabled) {
      const assignmentProblem = this.options.personas.assignmentProblem(bot.config.username, bot.config.personaId);
      if (assignmentProblem) return assignmentProblem;
    }
    bot.config.enabled = enabled;
    if (!enabled) {
      try { await bot.client?.disconnect(); } catch { /* no-op */ }
      bot.client = undefined;
      await this.patch(bot, { enabled: false, connectionState: 'DISABLED', chatConnected: false });
    } else {
      await this.patch(bot, { enabled: true, connectionState: 'DISCONNECTED', chatConnected: false, lastError: undefined });
      void this.connectBot(bot);
    }
    return 'updated';
  }

  async assignPersona(username: string, personaId: string): Promise<PersonaAssignmentResult> {
    const bot = this.bots.get(username.toLowerCase());
    if (!bot) return 'bot_not_found';
    if (!this.options.personas.has(personaId)) return 'persona_not_found';
    const assignmentProblem = this.options.personas.assignmentProblem(bot.config.username, personaId);
    if (assignmentProblem) return assignmentProblem;
    if (bot.config.personaId === personaId) return 'updated';
    const alreadyAssigned = [...this.bots.values()].some((candidate) =>
      candidate !== bot && candidate.config.personaId === personaId)
      || (await this.options.repository.listBots()).some((candidate) =>
        candidate.username !== bot.config.username && candidate.personaId === personaId);
    if (alreadyAssigned) return 'persona_in_use';
    const previousPersonaId = bot.config.personaId;
    bot.config.personaId = personaId;
    bot.status = { ...bot.status, personaId, lastError: undefined };
    try {
      await this.persist(bot);
    } catch (error) {
      bot.config.personaId = previousPersonaId;
      bot.status = { ...bot.status, personaId: previousPersonaId };
      throw error;
    }
    this.options.personas.unregisterAssignment(previousPersonaId);
    this.options.personas.registerAssignment(bot.config.username, personaId);
    this.emit('status', this.listStatuses());
    return 'updated';
  }

  async revalidatePersona(personaId: string): Promise<void> {
    const affected = [...this.bots.values()].filter((bot) => bot.config.personaId === personaId);
    await Promise.allSettled(affected.map(async (bot) => {
      const assignmentProblem = this.options.personas.assignmentProblem(bot.config.username, personaId);
      if (!assignmentProblem) return;
      bot.config.enabled = false;
      try { await bot.client?.disconnect(); } catch { /* the account is disabled regardless of disconnect outcome */ }
      bot.client = undefined;
      await this.patch(bot, {
        enabled: false,
        connectionState: 'DISABLED',
        chatConnected: false,
        lastError: assignmentProblemMessage(assignmentProblem),
      });
    }));
  }

  async upsertAuthorizedAccount(account: BotAccountConfig, previousUsername?: string): Promise<void> {
    const username = account.username.toLowerCase();
    const existing = this.bots.get(username) ?? (previousUsername ? this.bots.get(previousUsername.toLowerCase()) : undefined);
    if (!existing) {
      const usedPersonaIds = new Set([
        ...[...this.bots.values()].map((bot) => bot.config.personaId),
        ...(await this.options.repository.listBots()).map((bot) => bot.personaId),
      ]);
      const persona = await this.options.personas.ensureUniqueForAccount(username, account.personaId, usedPersonaIds);
      const personaId = persona.id;
      const assignmentProblem = this.options.personas.assignmentProblem(username, personaId);
      const enabled = account.enabled && !assignmentProblem;
      const bot: ManagedBot = {
        config: { ...account, username, personaId, enabled },
        sentAt: [],
        status: {
          username,
          personaId,
          enabled,
          connectionState: enabled ? 'DISCONNECTED' : 'DISABLED',
          chatConnected: false,
          messagesSent: 0,
          ...(assignmentProblem ? { lastError: assignmentProblemMessage(assignmentProblem) } : {}),
        },
      };
      this.bots.set(username, bot);
      await this.persist(bot);
      this.emit('status', this.listStatuses());
      if (this.channel && enabled) await this.connectBot(bot);
      return;
    }

    if (existing.config.username !== username) this.renameManagedBot(existing, username);
    try { await existing.client?.disconnect(); } catch { /* already disconnected */ }
    existing.client = undefined;
    existing.config.oauthToken = account.oauthToken;
    const assignmentProblem = this.options.personas.assignmentProblem(existing.config.username, existing.config.personaId);
    if (assignmentProblem) existing.config.enabled = false;
    await this.patch(existing, {
      connectionState: existing.config.enabled ? 'DISCONNECTED' : 'DISABLED',
      chatConnected: false,
      lastError: assignmentProblem ? assignmentProblemMessage(assignmentProblem) : undefined,
    });
    if (this.channel && existing.config.enabled) await this.connectBot(existing);
  }

  async send(username: string, message: string): Promise<ReactionSendResult> {
    const bot = this.bots.get(username.toLowerCase());
    if (!bot?.client || bot.status.connectionState !== 'CONNECTED' || !bot.status.chatConnected) {
      this.logger.warn('Twitch send skipped because account is unavailable', {
        bot: username,
        channel: this.channel,
        reason: 'account_unavailable',
        connectionState: bot?.status.connectionState ?? 'UNKNOWN',
        chatConnected: bot?.status.chatConnected ?? false,
      });
      return { submitted: false, reason: 'account_unavailable' };
    }
    const now = Date.now();
    bot.sentAt = bot.sentAt.filter((at) => at > now - 30_000);
    if (bot.sentAt.length >= 18 || now - (bot.sentAt.at(-1) ?? 0) < 1_100) {
      this.logger.warn('Bot message blocked by local Twitch rate limiter', {
        bot: username, channel: this.channel, reason: 'local_rate_limit',
      });
      return { submitted: false, reason: 'local_rate_limit' };
    }
    try {
      this.logger.info('Twitch send attempt', {
        bot: username,
        channel: this.channel,
        messageBytes: Buffer.byteLength(message, 'utf8'),
      });
      await bot.client.say(`#${this.channel}`, message);
      const submittedAt = Date.now();
      bot.sentAt.push(submittedAt);
      void this.patch(bot, {
        messagesSent: bot.status.messagesSent + 1,
        lastMessage: message,
        lastReactionAt: submittedAt,
        lastError: undefined,
      });
      this.logger.info('Twitch message submitted', { bot: username, channel: this.channel });
      return { submitted: true, submittedAt };
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      void this.patch(bot, { lastError: error });
      this.logger.warn('Twitch message send failed', { bot: username, channel: this.channel, error: error.slice(0, 240) });
      return { submitted: false, reason: 'twitch_send_failed' };
    }
  }

  private async connectBot(bot: ManagedBot): Promise<void> {
    // Connecting has three other entry points besides start(): enabling an account, adding one,
    // and refreshing its OAuth credential. The last one runs on a timer, so a stopped system put
    // accounts back into chat by itself — production showed three of them rejoining across twenty
    // minutes with no operator action and no way to tell from the dashboard.
    if (!this.running) {
      this.logger.info('Not connecting a chat account while stopped', { username: bot.config.username });
      return;
    }
    if (!bot.config.enabled || bot.client) return;
    await this.patch(bot, { connectionState: 'CONNECTING', chatConnected: false, lastError: undefined });
    try {
      let resolved = this.options.credentialProvider
        ? await this.options.credentialProvider.resolveCredential(bot.config.username, bot.config.oauthToken)
        : { username: bot.config.username, accessToken: bot.config.oauthToken };
      if (resolved.username !== bot.config.username) this.renameManagedBot(bot, resolved.username);
      let validated;
      try {
        validated = await this.validator.validate(resolved.accessToken);
      } catch (validationError) {
        const refreshed = await this.options.credentialProvider?.forceRefresh(bot.config.username);
        if (!refreshed) throw validationError;
        resolved = refreshed;
        if (resolved.username !== bot.config.username) this.renameManagedBot(bot, resolved.username);
        validated = await this.validator.validate(resolved.accessToken);
      }
      if (validated.login !== bot.config.username && this.options.credentialProvider) {
        const refreshed = await this.options.credentialProvider.forceRefresh(bot.config.username);
        if (refreshed) {
          resolved = refreshed;
          if (resolved.username !== bot.config.username) this.renameManagedBot(bot, resolved.username);
          validated = await this.validator.validate(resolved.accessToken);
        }
      }
      if (validated.login !== bot.config.username) throw new Error(`OAuth token belongs to ${validated.login}, not ${bot.config.username}`);
      bot.config.oauthToken = resolved.accessToken;
      const clientOptions: tmi.Options = {
        options: { debug: false, skipUpdatingEmotesets: true },
        identity: {
          username: bot.config.username,
          password: resolved.accessToken.startsWith('oauth:') ? resolved.accessToken : `oauth:${resolved.accessToken}`,
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
      // Twitch does report why it refuses a message — as an IRC NOTICE on the sending account's
      // own connection, never as an error from say(). Without this handler a refusal was
      // indistinguishable from a delivered message: followers-only mode, a ban, a duplicate, slow
      // mode or an AutoMod hold all looked like success.
      client.on('notice', (_channel: string, msgid: string, notice: string) => {
        if (!SEND_REJECTION_NOTICES.has(msgid)) {
          this.logger.info('Twitch notice', { bot: bot.config.username, msgid, notice });
          return;
        }
        void this.patch(bot, { lastError: `${msgid}: ${notice}` });
        this.logger.warn('Twitch refused the message', { bot: bot.config.username, msgid, notice });
        this.emit('sendRejected', { username: bot.config.username, msgid, notice });
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

  /**
   * Whether some account is currently reading channel chat. Only the reader account's connection
   * receives incoming messages, so without one there is no way to observe whether a message we
   * sent actually reached the channel.
   */
  /** The account currently reading channel chat, if any. Its own messages echo locally, not from Twitch. */
  getChatReader(): string | undefined {
    return this.hasChatReader() ? this.readerUsername : undefined;
  }

  hasChatReader(): boolean {
    if (!this.readerUsername) return false;
    const reader = this.bots.get(this.readerUsername);
    return reader?.status.connectionState === 'CONNECTED' && reader.status.chatConnected;
  }

  private chooseReader(excluding: string): void {
    this.readerUsername = [...this.bots.values()].find((candidate) =>
      candidate.config.username !== excluding && candidate.status.connectionState === 'CONNECTED' && candidate.status.chatConnected,
    )?.config.username;
  }

  private renameManagedBot(bot: ManagedBot, nextUsername: string): void {
    const normalized = nextUsername.toLowerCase();
    const previous = bot.config.username;
    const collision = this.bots.get(normalized);
    if (collision && collision !== bot) throw new Error(`Twitch account ${normalized} is already configured`);
    this.bots.delete(previous);
    bot.config.username = normalized;
    bot.status.username = normalized;
    this.bots.set(normalized, bot);
    if (this.readerUsername === previous) this.readerUsername = normalized;
    this.emit('status', this.listStatuses());
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

  private async persist(bot: ManagedBot): Promise<void> {
    const snapshot = structuredClone(bot.status);
    const previous = this.persistenceTails.get(bot) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() => this.options.repository.upsertBot(snapshot));
    this.persistenceTails.set(bot, write);
    try {
      await write;
    } finally {
      if (this.persistenceTails.get(bot) === write) this.persistenceTails.delete(bot);
    }
  }
}

function assignmentProblemMessage(problem: PersonaAssignmentProblem): string {
  return problem === 'persona_username_mismatch'
    ? 'Личность создана для другого Twitch-аккаунта'
    : 'Заполните и проверьте ручную личность перед включением аккаунта';
}
