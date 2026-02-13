import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code = 'internal_error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        message = payload;
      } else if (payload && typeof payload === 'object') {
        const any = payload as any;
        message = (Array.isArray(any.message) ? any.message.join(', ') : any.message) || any.error || message;
        code = any.code || this.mapStatusToCode(status);
      } else {
        code = this.mapStatusToCode(status);
      }
    } else if (exception instanceof Error) {
      message = exception.message || message;
    }

    const requestId = req?.requestId || String(req?.headers?.['x-request-id'] || '');
    res.status(status).json({
      message,
      code,
      requestId: requestId || undefined,
      timestamp: new Date().toISOString()
    });
  }

  private mapStatusToCode(status: number): string {
    switch (status) {
      case 400:
        return 'bad_request';
      case 401:
        return 'unauthorized';
      case 403:
        return 'forbidden';
      case 404:
        return 'not_found';
      case 413:
        return 'payload_too_large';
      case 415:
        return 'unsupported_media_type';
      case 422:
        return 'unprocessable_entity';
      default:
        return 'error';
    }
  }
}
