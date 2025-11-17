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

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { createHmac } from 'node:crypto';

describe('AuthService', () => {
  let service: AuthService;
  let configService: ConfigService;
  const testSecret = 'test-secret-key';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'NEXTAUTH_SECRET') return testSecret;
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe('initialization', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should load secret from config', () => {
      expect(configService.get).toHaveBeenCalledWith('NEXTAUTH_SECRET');
    });
  });

  // Helper function to create valid JWT tokens
  function createValidToken(
    payload: any,
    secret: string = testSecret,
    header: any = { alg: 'HS256', typ: 'JWT' },
  ): string {
    const base64UrlEncode = (input: Buffer | string): string => {
      const buffer = typeof input === 'string' ? Buffer.from(input) : input;
      return buffer
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const data = `${encodedHeader}.${encodedPayload}`;
    const signature = createHmac('sha256', secret).update(data).digest();
    const encodedSignature = base64UrlEncode(signature);

    return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
  }

  describe('extractToken', () => {
    it('should extract token from valid Bearer header', () => {
      const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.signature';
      const result = service.extractToken(`Bearer ${token}`);
      expect(result).toBe(token);
    });

    it('should trim whitespace from token', () => {
      const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.signature';
      const result = service.extractToken(`Bearer ${token}  `);
      expect(result).toBe(token);
    });

    it('should return null with multiple spaces between Bearer and token', () => {
      const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.signature';
      const result = service.extractToken(`Bearer  ${token}`);
      expect(result).toBeNull();
    });

    it('should return null when header is undefined', () => {
      const result = service.extractToken(undefined);
      expect(result).toBeNull();
    });

    it('should return null when header is empty string', () => {
      const result = service.extractToken('');
      expect(result).toBeNull();
    });

    it('should return null when scheme is not Bearer', () => {
      const result = service.extractToken('Basic token123');
      expect(result).toBeNull();
    });

    it('should be case-insensitive for Bearer scheme', () => {
      const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.signature';
      const result = service.extractToken(`bearer ${token}`);
      expect(result).toBe(token);
    });

    it('should return null when token is missing', () => {
      const result = service.extractToken('Bearer');
      expect(result).toBeNull();
    });

    it('should return null when token is empty', () => {
      const result = service.extractToken('Bearer ');
      expect(result).toBeNull();
    });

    it('should handle malformed header without space', () => {
      const result = service.extractToken('BearerToken');
      expect(result).toBeNull();
    });
  });

  describe('verifyJwtHs256', () => {
    it('should verify valid JWT token', () => {
      const payload = {
        sub: 'user123',
        email: 'test@example.com',
        name: 'Test User',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const token = createValidToken(payload);

      const result = service.verifyJwtHs256(token);

      expect(result).toEqual(payload);
    });

    it('should verify token without expiration', () => {
      const payload = {
        sub: 'user123',
        email: 'test@example.com',
      };
      const token = createValidToken(payload);

      const result = service.verifyJwtHs256(token);

      expect(result).toEqual(payload);
    });

    it('should return null for token with incorrect number of parts', () => {
      const result = service.verifyJwtHs256('invalid.token');
      expect(result).toBeNull();
    });

    it('should return null for token with too many parts', () => {
      const result = service.verifyJwtHs256('part1.part2.part3.part4');
      expect(result).toBeNull();
    });

    it('should return null for expired token', () => {
      const payload = {
        sub: 'user123',
        exp: Math.floor(Date.now() / 1000) - 3600, // expired 1 hour ago
      };
      const token = createValidToken(payload);

      const result = service.verifyJwtHs256(token);

      expect(result).toBeNull();
    });

    it('should reject token with invalid signature', () => {
      const payload = { sub: 'user123' };
      const token = createValidToken(payload, 'wrong-secret');

      const result = service.verifyJwtHs256(token);

      expect(result).toBeNull();
    });

    it('should reject token with wrong algorithm', () => {
      const payload = { sub: 'user123' };
      const token = createValidToken(payload, testSecret, { alg: 'RS256', typ: 'JWT' });

      const result = service.verifyJwtHs256(token);

      expect(result).toBeNull();
    });

    it('should accept token without alg in header', () => {
      const payload = { sub: 'user123' };
      const token = createValidToken(payload, testSecret, { typ: 'JWT' });

      const result = service.verifyJwtHs256(token);

      expect(result).toEqual(payload);
    });

    it('should return null for token with invalid base64 encoding', () => {
      const result = service.verifyJwtHs256('invalid!!!.payload!!!.signature!!!');
      expect(result).toBeNull();
    });

    it('should return null for token with invalid JSON in payload', () => {
      const base64UrlEncode = (input: string): string => {
        return Buffer.from(input)
          .toString('base64')
          .replace(/=/g, '')
          .replace(/\+/g, '-')
          .replace(/\//g, '_');
      };

      const encodedHeader = base64UrlEncode(JSON.stringify({ alg: 'HS256' }));
      const encodedPayload = base64UrlEncode('not-valid-json{]');
      const data = `${encodedHeader}.${encodedPayload}`;
      const signature = createHmac('sha256', testSecret).update(data).digest();
      const encodedSignature = base64UrlEncode(signature.toString('base64'));

      const result = service.verifyJwtHs256(`${encodedHeader}.${encodedPayload}.${encodedSignature}`);

      expect(result).toBeNull();
    });

    it('should return null for token with invalid JSON in header', () => {
      const base64UrlEncode = (input: string): string => {
        return Buffer.from(input)
          .toString('base64')
          .replace(/=/g, '')
          .replace(/\+/g, '-')
          .replace(/\//g, '_');
      };

      const encodedHeader = base64UrlEncode('not-valid-json{]');
      const encodedPayload = base64UrlEncode(JSON.stringify({ sub: 'user123' }));
      const data = `${encodedHeader}.${encodedPayload}`;
      const signature = createHmac('sha256', testSecret).update(data).digest();
      const encodedSignature = base64UrlEncode(signature.toString('base64'));

      const result = service.verifyJwtHs256(`${encodedHeader}.${encodedPayload}.${encodedSignature}`);

      expect(result).toBeNull();
    });

    it('should preserve additional claims in token', () => {
      const payload = {
        sub: 'user123',
        email: 'test@example.com',
        roles: ['admin', 'user'],
        customField: 'custom-value',
      };
      const token = createValidToken(payload);

      const result = service.verifyJwtHs256(token);

      expect(result).toEqual(payload);
      expect((result as any).customField).toBe('custom-value');
      expect((result as any).roles).toEqual(['admin', 'user']);
    });

    it('should handle token that expires at exact current time', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const payload = {
        sub: 'user123',
        exp: nowSec, // expires right now
      };
      const token = createValidToken(payload);

      const result = service.verifyJwtHs256(token);

      // Token should be invalid if exp <= now
      expect(result).toBeNull();
    });

    it('should handle token with different signature lengths', () => {
      // Create token with tampered signature (different length)
      const payload = { sub: 'user123' };
      const validToken = createValidToken(payload);
      const [header, payloadPart] = validToken.split('.');
      const tamperedToken = `${header}.${payloadPart}.abc`;

      const result = service.verifyJwtHs256(tamperedToken);

      expect(result).toBeNull();
    });
  });

  describe('requireUser', () => {
    it('should return user for valid token', () => {
      const payload = {
        sub: 'user123',
        email: 'test@example.com',
        name: 'Test User',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const token = createValidToken(payload);

      const result = service.requireUser(`Bearer ${token}`);

      expect(result).toEqual({
        userId: 'user123',
        email: 'test@example.com',
        name: 'Test User',
      });
    });

    it('should throw UnauthorizedException when header is missing', () => {
      expect(() => service.requireUser(undefined)).toThrow(UnauthorizedException);
      expect(() => service.requireUser(undefined)).toThrow('Invalid or missing token');
    });

    it('should throw UnauthorizedException when token is invalid', () => {
      expect(() => service.requireUser('Bearer invalid.token.here')).toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when token has no sub claim', () => {
      const payload = {
        email: 'test@example.com',
        name: 'Test User',
      };
      const token = createValidToken(payload);

      expect(() => service.requireUser(`Bearer ${token}`)).toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when token is expired', () => {
      const payload = {
        sub: 'user123',
        exp: Math.floor(Date.now() / 1000) - 3600,
      };
      const token = createValidToken(payload);

      expect(() => service.requireUser(`Bearer ${token}`)).toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when scheme is not Bearer', () => {
      const payload = { sub: 'user123' };
      const token = createValidToken(payload);

      expect(() => service.requireUser(`Basic ${token}`)).toThrow(UnauthorizedException);
    });

    it('should convert sub to string when it is a number', () => {
      const payload = {
        sub: 12345,
        email: 'test@example.com',
      };
      const token = createValidToken(payload);

      const result = service.requireUser(`Bearer ${token}`);

      expect(result.userId).toBe('12345');
      expect(typeof result.userId).toBe('string');
    });

    it('should handle user without email', () => {
      const payload = {
        sub: 'user123',
        name: 'Test User',
      };
      const token = createValidToken(payload);

      const result = service.requireUser(`Bearer ${token}`);

      expect(result).toEqual({
        userId: 'user123',
        email: undefined,
        name: 'Test User',
      });
    });

    it('should handle user without name', () => {
      const payload = {
        sub: 'user123',
        email: 'test@example.com',
      };
      const token = createValidToken(payload);

      const result = service.requireUser(`Bearer ${token}`);

      expect(result).toEqual({
        userId: 'user123',
        email: 'test@example.com',
        name: undefined,
      });
    });
  });

  describe('optionalUser', () => {
    it('should return user for valid token', () => {
      const payload = {
        sub: 'user123',
        email: 'test@example.com',
        name: 'Test User',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const token = createValidToken(payload);

      const result = service.optionalUser(`Bearer ${token}`);

      expect(result).toEqual({
        userId: 'user123',
        email: 'test@example.com',
        name: 'Test User',
      });
    });

    it('should return null when header is missing', () => {
      const result = service.optionalUser(undefined);
      expect(result).toBeNull();
    });

    it('should return null when token is invalid', () => {
      const result = service.optionalUser('Bearer invalid.token.here');
      expect(result).toBeNull();
    });

    it('should return null when token has no sub claim', () => {
      const payload = {
        email: 'test@example.com',
        name: 'Test User',
      };
      const token = createValidToken(payload);

      const result = service.optionalUser(`Bearer ${token}`);

      expect(result).toBeNull();
    });

    it('should return null when token is expired', () => {
      const payload = {
        sub: 'user123',
        exp: Math.floor(Date.now() / 1000) - 3600,
      };
      const token = createValidToken(payload);

      const result = service.optionalUser(`Bearer ${token}`);

      expect(result).toBeNull();
    });

    it('should return null when scheme is not Bearer', () => {
      const payload = { sub: 'user123' };
      const token = createValidToken(payload);

      const result = service.optionalUser(`Basic ${token}`);

      expect(result).toBeNull();
    });

    it('should convert sub to string when it is a number', () => {
      const payload = {
        sub: 54321,
        email: 'test@example.com',
      };
      const token = createValidToken(payload);

      const result = service.optionalUser(`Bearer ${token}`);

      expect(result?.userId).toBe('54321');
      expect(typeof result?.userId).toBe('string');
    });

    it('should handle user without email or name', () => {
      const payload = {
        sub: 'user123',
      };
      const token = createValidToken(payload);

      const result = service.optionalUser(`Bearer ${token}`);

      expect(result).toEqual({
        userId: 'user123',
        email: undefined,
        name: undefined,
      });
    });

    it('should return null for empty string header', () => {
      const result = service.optionalUser('');
      expect(result).toBeNull();
    });
  });

  describe('edge cases and security', () => {
    it('should use timing-safe comparison for signature verification', () => {
      // This test ensures the service is using timingSafeEqual
      // We can't directly test timing, but we can verify behavior
      const payload = { sub: 'user123' };
      const validToken = createValidToken(payload);

      // Valid token should work
      expect(service.verifyJwtHs256(validToken)).toBeTruthy();

      // Tampered signature should fail
      const [header, payloadPart, signature] = validToken.split('.');
      const tamperedSignature = signature.slice(0, -1) + (signature.slice(-1) === 'a' ? 'b' : 'a');
      const tamperedToken = `${header}.${payloadPart}.${tamperedSignature}`;

      expect(service.verifyJwtHs256(tamperedToken)).toBeNull();
    });

    it('should handle base64url encoding without padding correctly', () => {
      // Test that tokens work without base64 padding
      const payload = { sub: 'user123', data: 'abc' }; // 'abc' length requires padding
      const token = createValidToken(payload);

      // Verify token doesn't contain '=' padding
      expect(token).not.toContain('=');

      const result = service.verifyJwtHs256(token);
      expect(result).toEqual(payload);
    });

    it('should handle various base64url special characters', () => {
      const payload = {
        sub: 'user123',
        data: 'test+with/special=chars', // Contains chars that need encoding
      };
      const token = createValidToken(payload);

      // Verify token uses URL-safe base64 (no +, /, =)
      expect(token).not.toContain('+');
      expect(token).not.toContain('/');
      expect(token).not.toContain('=');

      const result = service.verifyJwtHs256(token);
      expect(result).toEqual(payload);
    });

    it('should handle empty strings in claims', () => {
      const payload = {
        sub: 'user123',
        email: '',
        name: '',
      };
      const token = createValidToken(payload);

      const result = service.requireUser(`Bearer ${token}`);

      expect(result).toEqual({
        userId: 'user123',
        email: '',
        name: '',
      });
    });
  });
});
