import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { classifyUpload, uploadKind } from './upload-health';
import type { UploadOperationsService } from './upload-operations.service';

export function observeUploads(operations: UploadOperationsService) {
  return (req: Request, res: Response, next: NextFunction) => {
    const operation = uploadKind(req.method, req.path);
    if (!operation) return next();
    const incoming = req.header('x-upload-attempt-id');
    const attemptId = incoming && /^[a-f0-9-]{36}$/i.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-upload-attempt-id', attemptId);
    const started = Date.now();
    let recorded = false;
    const record = (status: number) => {
      if (recorded) return;
      recorded = true;
      const user = (req as any).user;
      const reset = Number(res.getHeader('x-ratelimit-reset'));
      const size = Number(req.header('content-length'));
      void operations.record({
        attemptId,
        observation: 'backend',
        operation,
        status,
        ...classifyUpload(status),
        durationMs: Date.now() - started,
        sizeBytes: Number.isFinite(size) && size >= 0 ? size : undefined,
        userId: user?.userId,
        role: user?.roles?.includes('admin') ? 'admin' : user ? 'user' : 'anonymous',
        // Use only our generated/validated correlation ID, never arbitrary URL/body text.
        requestId: /^[a-zA-Z0-9_-]{1,100}$/.test((req as any).requestId || '')
          ? (req as any).requestId
          : undefined,
        resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined
      });
    };
    res.on('finish', () => record(res.statusCode));
    res.on('close', () => {
      if (!res.writableFinished) record(0);
    });
    next();
  };
}
