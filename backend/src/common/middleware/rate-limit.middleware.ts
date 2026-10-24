import type { Request, Response, NextFunction } from 'express';
import type { AuthService } from '../../auth/auth.service';
import type { UsersService } from '../../users/users.service';
import type { UploadOperationsService } from '../../operations/upload-operations.service';
import { uploadKind } from '../../operations/upload-health';

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

function loadDisabledRules(): Set<string> {
  const disabled = new Set<string>();

  const disabledList = (process.env.RATE_LIMIT_DISABLED_RULES || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  for (const item of disabledList) {
    disabled.add(item);
  }

  // Backward-compatible single-rule switch for operational scripts.
  if ((process.env.DISABLE_IMSLP_REFRESH_RATE_LIMIT || '').trim().toLowerCase() === 'true') {
    disabled.add('imslp-refresh');
  }

  return disabled;
}

const disabledRules = loadDisabledRules();

const rules: RateLimitRule[] = [
  {
    name: 'upload-observations',
    windowMs: 60000,
    maxAnonymous: 10,
    maxAuthenticated: 60,
    match: (req) => req.method === 'POST' && req.path === '/api/operations/upload-observations'
  },
  {
    name: 'upload',
    windowMs: 60 * 60 * 1000,
    maxAnonymous: 10,
    maxAuthenticated: 60,
    match: (req) => req.method === 'POST' && Boolean(uploadKind(req.method, req.path))
  },
  {
    name: 'auth',
    windowMs: 60 * 1000,
    maxAnonymous: 120,
    maxAuthenticated: 240,
    match: (req) => /^\/api\/auth\//.test(req.path)
  },
  {
    name: 'analytics-ingest',
    windowMs: 60 * 1000,
    maxAnonymous: 180,
    maxAuthenticated: 900,
    match: (req) => req.method === 'POST' && /^\/api\/analytics\/events$/.test(req.path)
  },
  {
    name: 'expensive',
    windowMs: 15 * 60 * 1000,
    maxAnonymous: 40,
    maxAuthenticated: 120,
    match: (req) =>
      req.method === 'GET' && (/\/textdiff$/.test(req.path) || /\/fossil\/diff$/.test(req.path))
  },
  {
    name: 'imslp-refresh',
    windowMs: 15 * 60 * 1000,
    maxAnonymous: 5,
    maxAuthenticated: 20,
    match: (req) => req.method === 'POST' && /^\/api\/imslp\/works\/[^/]+\/refresh$/.test(req.path)
  }
];

async function getClientId(
  req: Request,
  auth: AuthService,
  users: UsersService
): Promise<{ id: string; authenticated: boolean; userId?: string }> {
  const principal = auth.optionalUser(req.header('authorization'));
  if (principal) {
    const account = principal.email
      ? await users.findByEmail(principal.email)
      : await users.findById(principal.userId).catch(() => null);
    if (account) {
      const userId = String(account._id);
      (req as any).user = { userId, email: account.email, roles: account.roles || [] };
      return { id: `user:${userId}`, authenticated: true, userId };
    }
  }
  // Use Express's trusted-proxy configuration, never an arbitrary forwarded header.
  return { id: `ip:${req.ip || 'unknown'}`, authenticated: false };
}

export function uploadLimitState(userId: string) {
  const bucket = buckets.get(`upload:user:${userId}`);
  return bucket && bucket.resetAt > Date.now() ? { ...bucket } : { count: 0, resetAt: null };
}

export function resetUploadLimit(userId: string): void {
  buckets.delete(`upload:user:${userId}`);
}

export function uploadLimitPolicy() {
  return {
    limit: 60,
    anonymousLimit: 10,
    windowSeconds: 3600,
    disabled: disabledRules.has('upload'),
    scope:
      'Verified account; counters are local to this backend process and reset on restart. Allowances and audit history persist.'
  };
}

function getMatchingRule(req: Request): RateLimitRule | undefined {
  for (const rule of rules) {
    if (disabledRules.has(rule.name.toLowerCase())) continue;
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

export function createRateLimitMiddleware(
  auth: AuthService,
  users: UsersService,
  operations: UploadOperationsService
) {
  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
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

      const { id, authenticated, userId } = await getClientId(req, auth, users);
      const allowance =
        rule.name === 'upload' && userId ? await operations.allowance(userId) : null;
      const limit = allowance?.limit || (authenticated ? rule.maxAuthenticated : rule.maxAnonymous);
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
          message: `Request limit reached. Try again after ${new Date(existing.resetAt).toISOString()}.`,
          code: 'rate_limited',
          retryAfterSeconds: retryAfterSec,
          resetAt: new Date(existing.resetAt).toISOString()
        });
        return;
      }

      existing.count += 1;
      buckets.set(key, existing);
      res.setHeader('x-ratelimit-limit', String(limit));
      res.setHeader('x-ratelimit-remaining', String(Math.max(limit - existing.count, 0)));
      res.setHeader('x-ratelimit-reset', String(Math.ceil(existing.resetAt / 1000)));
      next();
    } catch (error) {
      next(error);
    }
  };
}
