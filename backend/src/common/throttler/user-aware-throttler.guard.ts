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

import { Injectable, ExecutionContext, Logger } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';
import type { RequestUser } from '../../auth/types/auth-user';

/**
 * Custom throttler guard that applies different rate limits based on user authentication status.
 *
 * Throttling strategy:
 * - Anonymous users: Tracked by IP address with default limits
 * - Authenticated users: Tracked by userId with 3x higher limits
 * - Admin users: Tracked by userId with 10x higher limits
 *
 * This allows fair resource allocation while preventing abuse.
 */
@Injectable()
export class UserAwareThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(UserAwareThrottlerGuard.name);

  /**
   * Generate a unique tracker key for rate limiting.
   * Uses userId for authenticated users, IP address for anonymous users.
   */
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const user = req.user as RequestUser | undefined;

    if (user?.userId) {
      return `user:${user.userId}`;
    }

    // Fall back to IP address for anonymous users
    return req.ip || req.connection?.remoteAddress || 'unknown';
  }

  /**
   * Override to apply custom limit based on user role before checking throttle.
   */
  protected async handleRequest(requestProps: any): Promise<boolean> {
    const { context, limit, ttl } = requestProps;
    const request = context.switchToHttp().getRequest();
    const user = request.user as RequestUser | undefined;

    // Calculate adjusted limit based on user role
    let adjustedLimit = limit;

    if (user?.roles?.includes('admin')) {
      // Admins get 10x higher limits
      adjustedLimit = limit * 10;
    } else if (user?.userId) {
      // Authenticated users get 3x higher limits
      adjustedLimit = limit * 3;
    }

    try {
      // Call parent with adjusted limit
      const modifiedProps = {
        ...requestProps,
        limit: adjustedLimit,
      };
      const result = await super.handleRequest(modifiedProps);
      return result;
    } catch (error) {
      // Log rate limit violations
      const tracker = await this.getTracker(request);
      const endpoint = request.url;
      this.logger.warn(
        `Rate limit exceeded: tracker=${tracker}, endpoint=${endpoint}, limit=${adjustedLimit}, ttl=${ttl}ms`
      );
      throw error;
    }
  }
}
