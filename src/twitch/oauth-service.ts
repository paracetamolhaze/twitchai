import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AppRepository,
  EncryptedTwitchCredentialRecord,
  TwitchOAuthNonceRecord,
} from '../persistence/repository';
import { TokenCipher } from '../security/token-cipher';
import { TwitchTokenValidator } from './oauth-validator';

const REQUIRED_CHAT_SCOPES = ['chat:read', 'chat:edit'];
const DEFAULT_REFRESH_LEAD_MS = 30_000;
const LAUNCH_LIFETIME_MS = 5 * 60_000;
const STATE_LIFETIME_MS = 10 * 60_000;

export interface TwitchTokenGrant {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scopes: string[];
}

export interface TwitchOAuthGateway {
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<TwitchTokenGrant>;
  refresh(refreshToken: string): Promise<TwitchTokenGrant>;
}

export interface TwitchOAuthAccountStatus {
  username: string;
  scopes: string[];
  expiresAt: number;
  refreshable: boolean;
  refreshState: EncryptedTwitchCredentialRecord['refreshState'];
  lastRefreshAt?: number;
  lastRefreshError?: string;
}

export interface TwitchOAuthStatus {
  configured: boolean;
  callbackUrl: string;
  accounts: TwitchOAuthAccountStatus[];
}

export interface AuthorizedTwitchAccount extends TwitchOAuthAccountStatus {
  userId: string;
  accessToken: string;
  previousUsername?: string;
}

export interface ResolvedTwitchCredential {
  username: string;
  accessToken: string;
}

export interface TwitchAccessTokenProvider {
  resolveCredential(username: string, fallbackToken: string): Promise<ResolvedTwitchCredential>;
  forceRefresh(username: string): Promise<ResolvedTwitchCredential | undefined>;
}

export interface TwitchOAuthServiceOptions {
  repository: AppRepository;
  gateway: TwitchOAuthGateway;
  validator: TwitchTokenValidator;
  encryptionKey: string;
  callbackUrl: string;
  now?: () => number;
  refreshLeadMs?: number;
}

export interface LaunchedTwitchAuthorization {
  authorizationUrl: string;
  browserState: string;
}

export class TwitchOAuthRequestError extends Error {
  constructor(readonly status: number) {
    super(`Twitch OAuth request failed (${status})`);
    this.name = 'TwitchOAuthRequestError';
  }
}

export class TwitchOAuthService implements TwitchAccessTokenProvider {
  private readonly cipher: TokenCipher;
  private readonly now: () => number;
  private readonly refreshLeadMs: number;
  private readonly refreshes = new Map<string, Promise<AuthorizedTwitchAccount>>();

  constructor(private readonly options: TwitchOAuthServiceOptions) {
    this.cipher = new TokenCipher(options.encryptionKey);
    this.now = options.now ?? Date.now;
    this.refreshLeadMs = options.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS;
  }

  async startAuthorization(): Promise<string> {
    const ticket = randomBytes(32).toString('base64url');
    await this.saveNonce(ticket, 'launch', LAUNCH_LIFETIME_MS);
    const launchUrl = new URL('/api/twitch/oauth/launch', this.options.callbackUrl);
    launchUrl.searchParams.set('ticket', ticket);
    return launchUrl.toString();
  }

  async launchAuthorization(ticket: string): Promise<LaunchedTwitchAuthorization> {
    if (!await this.consumeNonce(ticket, 'launch')) throw new Error('OAuth launch ticket is invalid or expired');
    const state = randomBytes(32).toString('base64url');
    await this.saveNonce(state, 'state', STATE_LIFETIME_MS);
    return {
      authorizationUrl: this.options.gateway.authorizationUrl(state),
      browserState: state,
    };
  }

  async completeAuthorization(code: string, state: string, browserState: string): Promise<AuthorizedTwitchAccount> {
    await this.consumeAuthorizationState(state, browserState);
    const grant = await this.options.gateway.exchangeCode(code);
    if (!grant.refreshToken) throw new Error('Twitch OAuth did not return a refresh token');
    const identity = await this.options.validator.validate(grant.accessToken);
    requireChatScopes(identity.scopes);
    const previous = await this.options.repository.getTwitchCredentialByUserId(identity.userId);
    return this.save({
      username: identity.login.toLowerCase(),
      userId: identity.userId,
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      scopes: identity.scopes,
      expiresAt: this.now() + Math.max(1, identity.expiresIn || grant.expiresIn) * 1_000,
      ...(previous
        ? { previousUsername: previous.username !== identity.login.toLowerCase() ? previous.username : previous.previousUsername }
        : {}),
    });
  }

  async abandonAuthorization(state: string, browserState: string): Promise<void> {
    await this.consumeAuthorizationState(state, browserState);
  }

  async status(): Promise<TwitchOAuthStatus> {
    const records = await this.options.repository.listTwitchCredentials();
    return {
      configured: true,
      callbackUrl: this.options.callbackUrl,
      accounts: records.map(publicStatus),
    };
  }

  async listAuthorizedAccounts(): Promise<TwitchOAuthAccountStatus[]> {
    return (await this.options.repository.listTwitchCredentials()).map(publicStatus);
  }

  async resolveCredential(username: string, fallbackToken: string): Promise<ResolvedTwitchCredential> {
    const normalized = username.toLowerCase();
    const record = await this.options.repository.getTwitchCredential(normalized);
    if (!record) return { username: normalized, accessToken: fallbackToken };
    if (record.expiresAt <= this.now() + this.refreshLeadMs) {
      const refreshed = await this.refreshCredential(normalized);
      return { username: refreshed.username, accessToken: refreshed.accessToken };
    }
    return { username: record.username, accessToken: this.decryptAccessToken(record) };
  }

  async forceRefresh(username: string): Promise<ResolvedTwitchCredential | undefined> {
    const normalized = username.toLowerCase();
    const record = await this.options.repository.getTwitchCredential(normalized);
    if (!record) return undefined;
    if (record.refreshState === 'RECONNECT_REQUIRED') throw new Error('Twitch authorization requires reconnection');
    const refreshed = await this.refreshCredential(normalized);
    return { username: refreshed.username, accessToken: refreshed.accessToken };
  }

  async refreshAccount(username: string): Promise<AuthorizedTwitchAccount> {
    return this.refreshCredential(username.toLowerCase());
  }

  async loadAuthorizedAccount(username: string): Promise<AuthorizedTwitchAccount | undefined> {
    const record = await this.options.repository.getTwitchCredential(username.toLowerCase());
    if (!record) return undefined;
    const resolved = await this.resolveCredential(record.username, '');
    const current = await this.options.repository.getTwitchCredential(resolved.username);
    if (!current) return undefined;
    return {
      ...publicStatus(current),
      userId: current.userId,
      accessToken: resolved.accessToken,
      ...(current.previousUsername ? { previousUsername: current.previousUsername } : {}),
    };
  }

  private async refreshCredential(username: string): Promise<AuthorizedTwitchAccount> {
    const existing = this.refreshes.get(username);
    if (existing) return existing;
    const pending = this.performRefresh(username);
    this.refreshes.set(username, pending);
    try {
      return await pending;
    } finally {
      if (this.refreshes.get(username) === pending) this.refreshes.delete(username);
    }
  }

  private async performRefresh(username: string): Promise<AuthorizedTwitchAccount> {
    const record = await this.options.repository.getTwitchCredential(username);
    if (!record) throw new Error(`No refreshable Twitch authorization exists for ${username}`);
    try {
      const refreshToken = this.cipher.decrypt(record.refreshTokenCiphertext, refreshContext(record.username));
      const grant = await this.options.gateway.refresh(refreshToken);
      const identity = await this.options.validator.validate(grant.accessToken);
      if (identity.userId !== record.userId) throw new Error('Refreshed Twitch token belongs to a different account');
      requireChatScopes(identity.scopes);
      const nextUsername = identity.login.toLowerCase();
      return this.save({
        username: nextUsername,
        userId: record.userId,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken ?? refreshToken,
        scopes: identity.scopes,
        expiresAt: this.now() + Math.max(1, identity.expiresIn || grant.expiresIn) * 1_000,
        refreshedAt: this.now(),
        ...(nextUsername !== record.username
          ? { previousUsername: record.username }
          : record.previousUsername ? { previousUsername: record.previousUsername } : {}),
      });
    } catch (cause) {
      await this.recordRefreshFailure(record, cause);
      throw cause;
    }
  }

  private async recordRefreshFailure(record: EncryptedTwitchCredentialRecord, cause: unknown): Promise<void> {
    try {
      const reconnectRequired = cause instanceof TwitchOAuthRequestError && [400, 401].includes(cause.status);
      await this.options.repository.markTwitchCredentialRefreshFailure({
        userId: record.userId,
        expectedVersion: record.version,
        refreshState: reconnectRequired ? 'RECONNECT_REQUIRED' : 'ERROR',
        lastRefreshAt: this.now(),
        lastRefreshError: reconnectRequired
          ? 'Twitch отозвал refresh token — требуется повторное подключение'
          : 'Временная ошибка обновления — backend повторит попытку',
      });
    } catch {
      // The original refresh failure remains authoritative; persistence failure is handled by the caller log.
    }
  }

  private async save(value: {
    username: string; userId: string; accessToken: string; refreshToken: string; scopes: string[]; expiresAt: number;
    refreshedAt?: number; previousUsername?: string;
  }): Promise<AuthorizedTwitchAccount> {
    const username = value.username.toLowerCase();
    const record: EncryptedTwitchCredentialRecord = {
      username,
      ...(value.previousUsername ? { previousUsername: value.previousUsername } : {}),
      userId: value.userId,
      accessTokenCiphertext: this.cipher.encrypt(value.accessToken, accessContext(username)),
      refreshTokenCiphertext: this.cipher.encrypt(value.refreshToken, refreshContext(username)),
      scopes: [...value.scopes],
      expiresAt: value.expiresAt,
      refreshState: 'HEALTHY',
      ...(value.refreshedAt ? { lastRefreshAt: value.refreshedAt } : {}),
      updatedAt: this.now(),
      version: 0,
    };
    await this.options.repository.upsertTwitchCredential(record);
    return {
      ...publicStatus(record),
      userId: record.userId,
      accessToken: value.accessToken,
      ...(value.previousUsername ? { previousUsername: value.previousUsername } : {}),
    };
  }

  private decryptAccessToken(record: EncryptedTwitchCredentialRecord): string {
    return this.cipher.decrypt(record.accessTokenCiphertext, accessContext(record.username));
  }

  private async saveNonce(value: string, purpose: TwitchOAuthNonceRecord['purpose'], lifetimeMs: number): Promise<void> {
    await this.options.repository.saveTwitchOAuthNonce({
      nonceHash: hashNonce(value),
      purpose,
      expiresAt: this.now() + lifetimeMs,
    });
  }

  private consumeNonce(value: string, purpose: TwitchOAuthNonceRecord['purpose']): Promise<boolean> {
    return this.options.repository.consumeTwitchOAuthNonce(hashNonce(value), purpose, this.now());
  }

  private async consumeAuthorizationState(state: string, browserState: string): Promise<void> {
    if (!safeEqual(state, browserState) || !await this.consumeNonce(state, 'state')) {
      throw new Error('OAuth state is invalid or expired');
    }
  }
}

function publicStatus(record: EncryptedTwitchCredentialRecord): TwitchOAuthAccountStatus {
  return {
    username: record.username,
    scopes: [...record.scopes],
    expiresAt: record.expiresAt,
    refreshable: record.refreshState !== 'RECONNECT_REQUIRED',
    refreshState: record.refreshState,
    ...(record.lastRefreshAt ? { lastRefreshAt: record.lastRefreshAt } : {}),
    ...(record.lastRefreshError ? { lastRefreshError: record.lastRefreshError } : {}),
  };
}

function requireChatScopes(scopes: string[]): void {
  const missing = REQUIRED_CHAT_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length) throw new Error(`Twitch authorization is missing required scopes: ${missing.join(', ')}`);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function hashNonce(value: string): string { return createHash('sha256').update(value, 'utf8').digest('base64url'); }
function accessContext(username: string): string { return `twitch:${username}:access`; }
function refreshContext(username: string): string { return `twitch:${username}:refresh`; }
