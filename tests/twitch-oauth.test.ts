import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../src/persistence/memory-repository';
import {
  TwitchOAuthGateway,
  TwitchOAuthRequestError,
  TwitchOAuthService,
  TwitchTokenGrant,
} from '../src/twitch/oauth-service';
import { TwitchTokenValidator } from '../src/twitch/oauth-validator';

describe('Twitch OAuth lifecycle', () => {
  it('authorizes once and refreshes an expired bot token without another login', async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    let now = 1_700_000_000_000;
    const gateway = new FakeOAuthGateway();
    const validator: TwitchTokenValidator = {
      validate: async (token) => ({
        login: token === 'initial-access' ? 'refreshable_bot' : 'renamed_bot',
        userId: '42',
        scopes: ['chat:read', 'chat:edit'],
        expiresIn: token === 'initial-access' ? 60 : 3_600,
      }),
    };
    const service = new TwitchOAuthService({
      repository,
      gateway,
      validator,
      encryptionKey: 'test-encryption-key-that-is-long-enough',
      callbackUrl: 'https://backend.example/api/twitch/oauth/callback',
      now: () => now,
    });

    const launchUrl = new URL(await service.startAuthorization());
    const launched = await service.launchAuthorization(launchUrl.searchParams.get('ticket')!);
    const authorizationUrl = new URL(launched.authorizationUrl);
    const state = authorizationUrl.searchParams.get('state');
    expect(state).toBeTruthy();
    await service.completeAuthorization('one-time-code', state!, launched.browserState);
    await expect(service.completeAuthorization('second-code', state!, launched.browserState)).rejects.toThrow('OAuth state');
    expect((await service.resolveCredential('refreshable_bot', 'legacy-token')).accessToken).toBe('initial-access');

    now += 61_000;
    expect(await service.resolveCredential('refreshable_bot', 'legacy-token')).toEqual({
      username: 'renamed_bot',
      accessToken: 'refreshed-access',
    });

    const restarted = new TwitchOAuthService({
      repository,
      gateway,
      validator,
      encryptionKey: 'test-encryption-key-that-is-long-enough',
      callbackUrl: 'https://backend.example/api/twitch/oauth/callback',
      now: () => now,
    });
    expect(await restarted.resolveCredential('refreshable_bot', 'legacy-token')).toEqual({
      username: 'renamed_bot',
      accessToken: 'refreshed-access',
    });
    expect(await restarted.status()).toEqual({
      configured: true,
      callbackUrl: 'https://backend.example/api/twitch/oauth/callback',
      accounts: [{
        username: 'renamed_bot',
        scopes: ['chat:read', 'chat:edit'],
        expiresAt: now + 3_600_000,
        refreshable: true,
        refreshState: 'HEALTHY',
        lastRefreshAt: now,
      }],
    });
  });

  it('rejects a callback whose signed state was not issued by this backend', async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeOAuthGateway();
    const service = new TwitchOAuthService({
      repository,
      gateway,
      validator: { validate: async () => { throw new Error('must not validate'); } },
      encryptionKey: 'test-encryption-key-that-is-long-enough',
      callbackUrl: 'https://backend.example/api/twitch/oauth/callback',
    });

    await expect(service.completeAuthorization('code', 'forged-state', 'forged-state')).rejects.toThrow('OAuth state');

    const launch = new URL(await service.startAuthorization());
    const started = await service.launchAuthorization(launch.searchParams.get('ticket')!);
    const issuedState = new URL(started.authorizationUrl).searchParams.get('state')!;
    await service.abandonAuthorization(issuedState, started.browserState);
    await expect(service.completeAuthorization('code', issuedState, started.browserState)).rejects.toThrow('OAuth state');
    expect(gateway.exchangeCount).toBe(0);
  });

  it('marks a revoked refresh token as requiring reconnection', async () => {
    const repository = new MemoryRepository();
    let now = 1_700_000_000_000;
    const gateway = new FakeOAuthGateway();
    const service = new TwitchOAuthService({
      repository,
      gateway,
      validator: {
        validate: async () => ({
          login: 'revoked_bot', userId: '99', scopes: ['chat:read', 'chat:edit'], expiresIn: 1,
        }),
      },
      encryptionKey: 'test-encryption-key-that-is-long-enough',
      callbackUrl: 'https://backend.example/api/twitch/oauth/callback',
      now: () => now,
    });
    const launch = new URL(await service.startAuthorization());
    const started = await service.launchAuthorization(launch.searchParams.get('ticket')!);
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    await service.completeAuthorization('code', state, started.browserState);
    gateway.refreshError = new TwitchOAuthRequestError(400);
    now += 2_000;

    await expect(service.resolveCredential('revoked_bot', 'legacy')).rejects.toThrow('(400)');
    expect((await service.status()).accounts[0]).toMatchObject({
      username: 'revoked_bot',
      refreshable: false,
      refreshState: 'RECONNECT_REQUIRED',
    });
  });

  it('does not let a stale refresh failure overwrite a successful refresh from another instance', async () => {
    const repository = new MemoryRepository();
    let now = 1_700_000_000_000;
    const validator: TwitchTokenValidator = {
      validate: async (token) => ({
        login: 'race_bot', userId: '777', scopes: ['chat:read', 'chat:edit'],
        expiresIn: token === 'initial-access' ? 1 : 3_600,
      }),
    };
    const initial = new TwitchOAuthService({
      repository,
      gateway: new FakeOAuthGateway(),
      validator,
      encryptionKey: 'test-encryption-key-that-is-long-enough',
      callbackUrl: 'https://backend.example/api/twitch/oauth/callback',
      now: () => now,
    });
    const launch = new URL(await initial.startAuthorization());
    const started = await initial.launchAuthorization(launch.searchParams.get('ticket')!);
    await initial.completeAuthorization(
      'code',
      new URL(started.authorizationUrl).searchParams.get('state')!,
      started.browserState,
    );
    now += 2_000;

    const successfulGateway = new ControlledRefreshGateway();
    const failingGateway = new ControlledRefreshGateway();
    const createInstance = (gateway: TwitchOAuthGateway): TwitchOAuthService => new TwitchOAuthService({
      repository,
      gateway,
      validator,
      encryptionKey: 'test-encryption-key-that-is-long-enough',
      callbackUrl: 'https://backend.example/api/twitch/oauth/callback',
      now: () => now,
    });
    const successfulRefresh = createInstance(successfulGateway).forceRefresh('race_bot');
    const staleFailure = createInstance(failingGateway).forceRefresh('race_bot');
    await Promise.all([successfulGateway.started, failingGateway.started]);

    successfulGateway.succeed();
    await expect(successfulRefresh).resolves.toEqual({ username: 'race_bot', accessToken: 'refreshed-access' });
    failingGateway.fail(new TwitchOAuthRequestError(400));
    await expect(staleFailure).rejects.toThrow('(400)');

    expect((await initial.status()).accounts[0]).toMatchObject({
      username: 'race_bot',
      refreshable: true,
      refreshState: 'HEALTHY',
    });
  });
});

class FakeOAuthGateway implements TwitchOAuthGateway {
  exchangeCount = 0;
  refreshError?: Error;

  authorizationUrl(state: string): string {
    const url = new URL('https://id.twitch.tv/oauth2/authorize');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(): Promise<TwitchTokenGrant> {
    this.exchangeCount += 1;
    return {
      accessToken: 'initial-access',
      refreshToken: 'initial-refresh',
      expiresIn: 60,
      scopes: ['chat:read', 'chat:edit'],
    };
  }

  async refresh(): Promise<TwitchTokenGrant> {
    if (this.refreshError) throw this.refreshError;
    return {
      accessToken: 'refreshed-access',
      refreshToken: 'refreshed-refresh',
      expiresIn: 3_600,
      scopes: ['chat:read', 'chat:edit'],
    };
  }
}

class ControlledRefreshGateway extends FakeOAuthGateway {
  readonly started: Promise<void>;
  private signalStarted!: () => void;
  private resolveRefresh!: (grant: TwitchTokenGrant) => void;
  private rejectRefresh!: (error: Error) => void;
  private readonly refreshResult: Promise<TwitchTokenGrant>;

  constructor() {
    super();
    this.started = new Promise((resolve) => { this.signalStarted = resolve; });
    this.refreshResult = new Promise((resolve, reject) => {
      this.resolveRefresh = resolve;
      this.rejectRefresh = reject;
    });
  }

  override async refresh(): Promise<TwitchTokenGrant> {
    this.signalStarted();
    return this.refreshResult;
  }

  succeed(): void {
    this.resolveRefresh({
      accessToken: 'refreshed-access',
      refreshToken: 'refreshed-refresh',
      expiresIn: 3_600,
      scopes: ['chat:read', 'chat:edit'],
    });
  }

  fail(error: Error): void { this.rejectRefresh(error); }
}
