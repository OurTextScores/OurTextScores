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

import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserAwareThrottlerGuard } from './user-aware-throttler.guard';
import type { RequestUser } from '../../auth/types/auth-user';

describe('UserAwareThrottlerGuard', () => {
  let guard: UserAwareThrottlerGuard;
  let mockReflector: jest.Mocked<Reflector>;
  let mockStorage: any;

  beforeEach(() => {
    mockReflector = {
      getAllAndOverride: jest.fn(),
    } as any;

    mockStorage = {
      increment: jest.fn(),
    };

    guard = new UserAwareThrottlerGuard(
      { throttlers: [{ ttl: 60000, limit: 100 }] } as any,
      mockStorage,
      mockReflector
    );
  });

  describe('getTracker', () => {
    it('should return user-based tracker for authenticated users', async () => {
      const req = {
        user: { userId: 'user123', email: 'test@example.com' } as RequestUser,
        ip: '192.168.1.1',
      };

      const tracker = await (guard as any).getTracker(req);

      expect(tracker).toBe('user:user123');
    });

    it('should return IP-based tracker for anonymous users', async () => {
      const req = {
        user: undefined,
        ip: '192.168.1.1',
      };

      const tracker = await (guard as any).getTracker(req);

      expect(tracker).toBe('192.168.1.1');
    });

    it('should fall back to connection.remoteAddress if IP is not available', async () => {
      const req = {
        user: undefined,
        ip: undefined,
        connection: { remoteAddress: '10.0.0.5' },
      };

      const tracker = await (guard as any).getTracker(req);

      expect(tracker).toBe('10.0.0.5');
    });

    it('should return "unknown" if no IP information is available', async () => {
      const req = {
        user: undefined,
        ip: undefined,
        connection: {},
      };

      const tracker = await (guard as any).getTracker(req);

      expect(tracker).toBe('unknown');
    });
  });

  describe('handleRequest with role-based limits', () => {
    let mockContext: jest.Mocked<ExecutionContext>;
    let mockGetRequest: jest.Mock;
    let parentHandleRequestSpy: jest.SpyInstance;

    beforeEach(() => {
      mockGetRequest = jest.fn();
      mockContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: mockGetRequest,
        }),
        getHandler: jest.fn(),
        getClass: jest.fn(),
      } as any;

      // Spy on parent handleRequest
      parentHandleRequestSpy = jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'handleRequest');
      parentHandleRequestSpy.mockResolvedValue(true);
    });

    afterEach(() => {
      parentHandleRequestSpy.mockRestore();
    });

    it('should apply 10x limit for admin users', async () => {
      const req = {
        user: {
          userId: 'admin123',
          email: 'admin@example.com',
          roles: ['admin'],
        } as RequestUser,
      };

      mockGetRequest.mockReturnValue(req);

      const requestProps = {
        context: mockContext,
        limit: 100,
        ttl: 60000,
        throttler: {},
        blockDuration: 0,
        throttlerName: 'default',
      };

      await (guard as any).handleRequest(requestProps);

      expect(parentHandleRequestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 1000, // 100 * 10
        })
      );
    });

    it('should apply 3x limit for authenticated users', async () => {
      const req = {
        user: {
          userId: 'user123',
          email: 'user@example.com',
          roles: [],
        } as RequestUser,
      };

      mockGetRequest.mockReturnValue(req);

      const requestProps = {
        context: mockContext,
        limit: 100,
        ttl: 60000,
        throttler: {},
        blockDuration: 0,
        throttlerName: 'default',
      };

      await (guard as any).handleRequest(requestProps);

      expect(parentHandleRequestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 300, // 100 * 3
        })
      );
    });

    it('should apply default limit for anonymous users', async () => {
      const req = {
        user: undefined,
      };

      mockGetRequest.mockReturnValue(req);

      const requestProps = {
        context: mockContext,
        limit: 100,
        ttl: 60000,
        throttler: {},
        blockDuration: 0,
        throttlerName: 'default',
      };

      await (guard as any).handleRequest(requestProps);

      expect(parentHandleRequestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 100, // No multiplier
        })
      );
    });

    it('should prioritize admin multiplier over authenticated multiplier', async () => {
      const req = {
        user: {
          userId: 'admin123',
          email: 'admin@example.com',
          roles: ['admin', 'user'], // Has both roles
        } as RequestUser,
      };

      mockGetRequest.mockReturnValue(req);

      const requestProps = {
        context: mockContext,
        limit: 100,
        ttl: 60000,
        throttler: {},
        blockDuration: 0,
        throttlerName: 'default',
      };

      await (guard as any).handleRequest(requestProps);

      expect(parentHandleRequestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 1000, // Should use admin multiplier (10x), not user multiplier (3x)
        })
      );
    });
  });
});
