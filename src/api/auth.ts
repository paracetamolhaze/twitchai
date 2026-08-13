import { createHmac, timingSafeEqual } from 'node:crypto';
import { RequestHandler, Response } from 'express';

export const DASHBOARD_SESSION_COOKIE = 'twitchai_dashboard_session';

export function tokenMatches(expected: string | undefined, supplied: unknown): boolean {
  if (!expected || typeof supplied !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface DashboardAuthOptions {
  token?: string;
  sessionDays: number;
  secureCookies: boolean;
  now?: () => number;
}

export interface DashboardAuth {
  middleware: RequestHandler;
  authenticate(request: DashboardRequest, suppliedToken?: unknown): boolean;
  issueSession(response: Response): void;
  clearSession(response: Response): void;
  configured(): boolean;
}

export interface DashboardRequest {
  headers: { cookie?: string };
  header(name: string): string | undefined;
}

export function createDashboardAuth(options: DashboardAuthOptions): DashboardAuth {
  const now = options.now ?? Date.now;
  const maxAgeSeconds = options.sessionDays * 24 * 60 * 60;

  const authenticate = (request: DashboardRequest, suppliedToken?: unknown): boolean => {
    if (!options.token) return false;
    if (tokenMatches(options.token, suppliedToken)) return true;
    const authorization = request.header('authorization');
    const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (tokenMatches(options.token, bearer ?? request.header('x-dashboard-token'))) return true;
    const cookieValue = parseCookies(request.headers.cookie)[DASHBOARD_SESSION_COOKIE];
    return verifySession(cookieValue, options.token, now());
  };

  return {
    configured: () => Boolean(options.token),
    authenticate,
    middleware: (request, response, next) => {
      if (!options.token) {
        response.status(503).json({ error: 'Авторизация панели не настроена на сервере' });
        return;
      }
      if (!authenticate(request)) {
        response.status(401).json({ error: 'Сессия истекла или недействительна' });
        return;
      }
      next();
    },
    issueSession: (response) => {
      if (!options.token) return;
      const issuedAt = now();
      const value = signSession({ issuedAt, expiresAt: issuedAt + maxAgeSeconds * 1_000 }, options.token);
      response.append('Set-Cookie', serializeCookie(value, maxAgeSeconds, options.secureCookies));
    },
    clearSession: (response) => {
      response.append('Set-Cookie', serializeCookie('', 0, options.secureCookies));
    },
  };
}

interface SessionPayload { issuedAt: number; expiresAt: number }

function signSession(payload: SessionPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifySession(value: string | undefined, secret: string, now: number): boolean {
  if (!value) return false;
  const [encoded, suppliedSignature, extra] = value.split('.');
  if (!encoded || !suppliedSignature || extra !== undefined) return false;
  const expectedSignature = createHmac('sha256', secret).update(encoded).digest('base64url');
  if (!tokenMatches(expectedSignature, suppliedSignature)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    return typeof payload.issuedAt === 'number'
      && typeof payload.expiresAt === 'number'
      && payload.issuedAt <= now + 60_000
      && payload.expiresAt > now;
  } catch {
    return false;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) return [];
    const rawValue = part.slice(separator + 1).trim();
    try { return [[part.slice(0, separator).trim(), decodeURIComponent(rawValue)]]; }
    catch { return []; }
  }));
}

function serializeCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const attributes = [
    `${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSeconds}`,
    secure ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (secure) attributes.push('Secure', 'Partitioned');
  return attributes.join('; ');
}
