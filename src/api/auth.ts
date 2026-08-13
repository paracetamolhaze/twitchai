import { timingSafeEqual } from 'node:crypto';
import { RequestHandler } from 'express';

export function tokenMatches(expected: string | undefined, supplied: unknown): boolean {
  if (!expected || typeof supplied !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function dashboardAuth(expected: string | undefined): RequestHandler {
  return (request, response, next) => {
    if (!expected) {
      response.status(503).json({ error: 'Dashboard authentication is not configured' });
      return;
    }
    const authorization = request.header('authorization');
    const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const token = bearer ?? request.header('x-dashboard-token');
    if (!tokenMatches(expected, token)) {
      response.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}
