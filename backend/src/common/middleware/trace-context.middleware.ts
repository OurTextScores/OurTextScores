import { context, trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';

export interface RequestWithTraceId extends Request {
  traceId?: string;
}

function traceIdFromTraceparent(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value.trim().split('-');
  if (parts.length < 4) {
    return undefined;
  }
  const traceId = parts[1];
  if (!/^[0-9a-f]{32}$/i.test(traceId)) {
    return undefined;
  }
  return traceId.toLowerCase();
}

export function traceContextMiddleware(
  req: RequestWithTraceId,
  res: Response,
  next: NextFunction
): void {
  const activeTraceId = trace.getSpan(context.active())?.spanContext().traceId;
  const incomingTraceId =
    traceIdFromTraceparent(req.header('traceparent')) ??
    req.header('x-trace-id')?.trim() ??
    undefined;
  const traceId = activeTraceId || incomingTraceId;

  if (traceId) {
    req.traceId = traceId;
    res.setHeader('x-trace-id', traceId);
  }

  next();
}
