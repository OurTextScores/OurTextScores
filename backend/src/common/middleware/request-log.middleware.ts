import type { NextFunction, Request, Response } from 'express';

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length) {
    return forwarded[0];
  }
  return req.ip || '';
}

export function requestLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationNs = process.hrtime.bigint() - startedAt;
    const durationMs = Number(durationNs) / 1_000_000;
    const enrichedReq = req as Request & {
      requestId?: string;
      user?: { userId?: string; roles?: string[] };
    };

    const payload = {
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      message: 'http_request',
      timestamp: new Date().toISOString(),
      requestId:
        enrichedReq.requestId ||
        (typeof req.headers['x-request-id'] === 'string'
          ? req.headers['x-request-id']
          : undefined),
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: getClientIp(req),
      userId: enrichedReq.user?.userId,
      userRoles: Array.isArray(enrichedReq.user?.roles) ? enrichedReq.user?.roles : undefined,
      userAgent: req.get('user-agent') || undefined
    };

    const line = `${JSON.stringify(payload)}\n`;
    if (res.statusCode >= 500) {
      process.stderr.write(line);
      return;
    }
    process.stdout.write(line);
  });

  next();
}
