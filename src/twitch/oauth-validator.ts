export interface ValidatedTwitchToken {
  login: string;
  userId: string;
  scopes: string[];
  expiresIn: number;
}

export interface TwitchTokenValidator {
  validate(token: string): Promise<ValidatedTwitchToken>;
}

export class OfficialTwitchTokenValidator implements TwitchTokenValidator {
  async validate(token: string): Promise<ValidatedTwitchToken> {
    const raw = token.replace(/^oauth:/i, '');
    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${raw}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Twitch token validation failed (${response.status})`);
    const data = await response.json() as {
      login?: string; user_id?: string; scopes?: string[]; expires_in?: number;
    };
    if (!data.login || !data.user_id) throw new Error('Twitch token validation returned no user identity');
    const scopes = data.scopes ?? [];
    for (const required of ['chat:read', 'chat:edit']) {
      if (!scopes.includes(required)) throw new Error(`Twitch token is missing required scope ${required}`);
    }
    return { login: data.login.toLowerCase(), userId: data.user_id, scopes, expiresIn: data.expires_in ?? 0 };
  }
}
