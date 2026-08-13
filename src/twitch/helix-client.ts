import { Logger } from '../logger';

export interface TwitchStreamInfo { isLive: boolean; category: string; title: string; }

export class TwitchHelixClient {
  private appToken?: { value: string; expiresAt: number };
  private readonly logger: Logger;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    logger: Logger,
  ) { this.logger = logger.child('TWITCH'); }

  async getStream(channel: string): Promise<TwitchStreamInfo> {
    const token = await this.getAppToken();
    const headers = { 'Client-Id': this.clientId, Authorization: `Bearer ${token}` };
    const users = await this.request<{ data: Array<{ id: string }> }>(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(channel)}`,
      headers,
    );
    const userId = users.data[0]?.id;
    if (!userId) return { isLive: false, category: '', title: '' };
    const streams = await this.request<{ data: Array<{ game_name: string; title: string }> }>(
      `https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(userId)}`,
      headers,
    );
    const stream = streams.data[0];
    return stream
      ? { isLive: true, category: stream.game_name, title: stream.title }
      : { isLive: false, category: '', title: '' };
  }

  private async getAppToken(): Promise<string> {
    if (this.appToken && this.appToken.expiresAt > Date.now() + 60_000) return this.appToken.value;
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'client_credentials' });
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST', body, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Twitch app authentication failed (${response.status})`);
    const data = await response.json() as { access_token: string; expires_in: number };
    this.appToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    this.logger.debug('Twitch app token refreshed', { expiresIn: data.expires_in });
    return data.access_token;
  }

  private async request<T>(url: string, headers: Record<string, string>): Promise<T> {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Twitch Helix request failed (${response.status})`);
    return response.json() as Promise<T>;
  }
}
