import { TwitchOAuthGateway, TwitchOAuthRequestError, TwitchTokenGrant } from './oauth-service';

const TOKEN_ENDPOINT = 'https://id.twitch.tv/oauth2/token';
const AUTHORIZE_ENDPOINT = 'https://id.twitch.tv/oauth2/authorize';
const CHAT_SCOPES = ['chat:read', 'chat:edit'];

export class OfficialTwitchOAuthGateway implements TwitchOAuthGateway {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  authorizationUrl(state: string): string {
    const url = new URL(AUTHORIZE_ENDPOINT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', CHAT_SCOPES.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('force_verify', 'true');
    return url.toString();
  }

  exchangeCode(code: string): Promise<TwitchTokenGrant> {
    return this.requestToken({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri,
    });
  }

  refresh(refreshToken: string): Promise<TwitchTokenGrant> {
    return this.requestToken({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  private async requestToken(parameters: Record<string, string>): Promise<TwitchTokenGrant> {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(parameters),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new TwitchOAuthRequestError(response.status);
    const body = await response.json() as {
      access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown;
    };
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new Error('Twitch OAuth token exchange returned an invalid response');
    }
    const scopes = Array.isArray(body.scope)
      ? body.scope.filter((scope): scope is string => typeof scope === 'string')
      : typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [];
    return {
      accessToken: body.access_token,
      ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
      expiresIn: body.expires_in,
      scopes,
    };
  }
}
