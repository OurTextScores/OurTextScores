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

import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { ThrottlerExceptionFilter } from './throttler-exception.filter';

describe('ThrottlerExceptionFilter', () => {
  let filter: ThrottlerExceptionFilter;
  let mockArgumentsHost: jest.Mocked<ArgumentsHost>;
  let mockResponse: any;
  let mockRequest: any;

  beforeEach(() => {
    filter = new ThrottlerExceptionFilter();

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockRequest = {
      url: '/api/works',
    };

    mockArgumentsHost = {
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as any;
  });

  it('should return 429 status code', () => {
    const exception = new ThrottlerException();

    filter.catch(exception, mockArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('should include clear error message and details', () => {
    const exception = new ThrottlerException();

    filter.catch(exception, mockArgumentsHost);

    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'You have exceeded the rate limit. Please try again later.',
        details: expect.objectContaining({
          retryAfter: expect.any(Number),
          retryAfterMs: expect.any(Number),
        }),
        timestamp: expect.any(String),
        path: '/api/works',
      })
    );
  });

  it('should calculate retry-after in seconds from ttl', () => {
    // Mock exception with custom ttl
    const exception = new ThrottlerException();
    jest.spyOn(exception, 'getResponse').mockReturnValue({ ttl: 120000, limit: 50 } as any);

    filter.catch(exception, mockArgumentsHost);

    const jsonCall = mockResponse.json.mock.calls[0][0];
    expect(jsonCall.details.retryAfter).toBe(120); // 120000ms / 1000 = 120 seconds
    expect(jsonCall.details.retryAfterMs).toBe(120000);
    expect(jsonCall.details.limit).toBe(50);
  });

  it('should use default values when ttl/limit not available', () => {
    const exception = new ThrottlerException();
    jest.spyOn(exception, 'getResponse').mockReturnValue({} as any);

    filter.catch(exception, mockArgumentsHost);

    const jsonCall = mockResponse.json.mock.calls[0][0];
    expect(jsonCall.details.retryAfter).toBe(60); // Default 60 seconds
    expect(jsonCall.details.limit).toBe(100); // Default limit
  });

  it('should include request path in error response', () => {
    mockRequest.url = '/api/works/123/sources';
    const exception = new ThrottlerException();

    filter.catch(exception, mockArgumentsHost);

    const jsonCall = mockResponse.json.mock.calls[0][0];
    expect(jsonCall.path).toBe('/api/works/123/sources');
  });

  it('should include ISO timestamp', () => {
    const exception = new ThrottlerException();
    const beforeTime = new Date().toISOString();

    filter.catch(exception, mockArgumentsHost);

    const jsonCall = mockResponse.json.mock.calls[0][0];
    const afterTime = new Date().toISOString();

    // Timestamp should be between before and after
    expect(jsonCall.timestamp).toBeTruthy();
    expect(jsonCall.timestamp >= beforeTime).toBe(true);
    expect(jsonCall.timestamp <= afterTime).toBe(true);
  });
});
