/*
 * Copyright (C) 2025 OurTextScores Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { ExceptionFilter, Catch, ArgumentsHost, HttpStatus } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response, Request } from 'express';

/**
 * Custom exception filter for rate limiting errors.
 *
 * Provides clear 429 responses with helpful information about:
 * - How many requests were allowed
 * - When the limit will reset
 * - User-friendly error message
 */
@Catch(ThrottlerException)
export class ThrottlerExceptionFilter implements ExceptionFilter {
  catch(exception: ThrottlerException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Extract throttler metadata if available
    const exceptionResponse: any = exception.getResponse();
    const ttl = exceptionResponse?.ttl || 60000; // Default to 60 seconds
    const limit = exceptionResponse?.limit || 100;

    // Calculate retry-after in seconds
    const retryAfterSeconds = Math.ceil(ttl / 1000);

    response.status(HttpStatus.TOO_MANY_REQUESTS).json({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      message: 'You have exceeded the rate limit. Please try again later.',
      details: {
        limit,
        retryAfter: retryAfterSeconds,
        retryAfterMs: ttl,
      },
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
