import type { Request, Response, NextFunction } from 'express';

interface RateLimitRule {
  name: string;
  windowMs: number;
  maxAnonymous: number;
  maxAuthenticated: number;
  match: (req: Request) => boolean;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

const rules: RateLimitRule[] = [
  {
    name: 'upload',
    windowMs: 60 * 60 * 1000,
    maxAnonymous: 10,
    maxAuthenticated: 60,
    match: (req) =>
      req.method === 'POST' &&
      (/^\/api\/works\/[^/]+\/sources(\/[^/]+\/revisions)?$/.test(req.path) ||
        /^\/api\/works\/[^/]+\/sources\/[^/]+\/reference\.pdf$/.test(req.path) ||
        /^\/api\/projects\/[^/]+\/sources$/.test(req.path))
  },
  {
    name: 'auth',
    windowMs: 60 * 1000,
    maxAnonymous: 120,
    maxAuthenticated: 240,
    match: (req) => /^\/api\/auth\//.test(req.path)
  },
  {
    name: 'expensive',
    windowMs: 15 * 60 * 1000,
    maxAnonymous: 40,
    maxAuthenticated: 120,
    match: (req) =>
      req.method === 'GET' &&
      (/\/textdiff$/.test(req.path) || /\/fossil\/diff$/.test(req.path))
  },
  {
    name: 'imslp-refresh',
    windowMs: 15 * 60 * 1000,
    maxAnonymous: 5,
    maxAuthenticated: 20,
    match: (req) =>
      req.method === 'POST' && /^\/api\/imslp\/works\/[^/]+\/refresh$/.test(req.path)
  }
];

function getClientToken(req: Request): string | undefined {
  const auth = (req.header('authorization') || '').trim();
  if (!auth) return undefined;
  const [scheme, token] = auth.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return undefined;
  return token.trim();
}

function getClientId(req: Request): { id: string; authenticated: boolean } {
  const token = getClientToken(req);
  if (token) {
    // Do not store full token in memory map keys.
    return { id: `tok:${token.slice(-24)}`, authenticated: true };
  }

  const fwd = (req.header('x-forwarded-for') || '').split(',')[0]?.trim();
  const ip = fwd || req.ip || 'unknown';
  return { id: `ip:${ip}`, authenticated: false };
}

function getMatchingRule(req: Request): RateLimitRule | undefined {
  for (const rule of rules) {
    if (rule.match(req)) return rule;
  }
  return undefined;
}

function pruneExpired(now: number): void {
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

let lastPruneAt = 0;

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const rule = getMatchingRule(req);
  if (!rule) {
    next();
    return;
  }

  const now = Date.now();
  if (now - lastPruneAt > 60 * 1000) {
    pruneExpired(now);
    lastPruneAt = now;
  }

  const { id, authenticated } = getClientId(req);
  const limit = authenticated ? rule.maxAuthenticated : rule.maxAnonymous;
  const key = `${rule.name}:${id}`;
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    res.setHeader('x-ratelimit-limit', String(limit));
    res.setHeader('x-ratelimit-remaining', String(Math.max(limit - 1, 0)));
    res.setHeader('x-ratelimit-reset', String(Math.ceil((now + rule.windowMs) / 1000)));
    next();
    return;
  }

  if (existing.count >= limit) {
    const retryAfterSec = Math.max(Math.ceil((existing.resetAt - now) / 1000), 1);
    res.setHeader('retry-after', String(retryAfterSec));
    res.setHeader('x-ratelimit-limit', String(limit));
    res.setHeader('x-ratelimit-remaining', '0');
    res.setHeader('x-ratelimit-reset', String(Math.ceil(existing.resetAt / 1000)));
    res.status(429).json({
      message: 'Too many requests. Please retry later.',
      code: 'rate_limited',
      retryAfterSeconds: retryAfterSec
    });
    return;
  }

  existing.count += 1;
  buckets.set(key, existing);
  res.setHeader('x-ratelimit-limit', String(limit));
  res.setHeader('x-ratelimit-remaining', String(Math.max(limit - existing.count, 0)));
  res.setHeader('x-ratelimit-reset', String(Math.ceil(existing.resetAt / 1000)));
  next();
}
