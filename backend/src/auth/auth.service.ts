import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { AuthUserClaims, RequestUser } from './types/auth-user';

function base64UrlEncode(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 2 ? '==' : normalized.length % 4 === 3 ? '=' : '';
  return Buffer.from(normalized + pad, 'base64');
}

@Injectable()
export class AuthService {
  private readonly secret: string;
  constructor(private readonly config: ConfigService) {
    this.secret = this.config.get<string>('AUTH_SECRET', 'dev-secret');
  }

  extractToken(authHeader?: string): string | null {
    if (!authHeader) return null;
    const [scheme, token] = authHeader.split(' ');
    if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
    if (!token) return null;
    return token.trim();
  }

  verifyJwtHs256(token: string): AuthUserClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    try {
      const payloadJson = base64UrlDecode(encodedPayload).toString('utf8');
      const headerJson = base64UrlDecode(encodedHeader).toString('utf8');
      const header = JSON.parse(headerJson) as any;
      if (!header || (header.alg && header.alg !== 'HS256')) return null;

      const data = `${encodedHeader}.${encodedPayload}`;
      const expected = createHmac('sha256', this.secret).update(data).digest();
      const actual = base64UrlDecode(encodedSignature);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return null;
      }

      const claims = JSON.parse(payloadJson) as AuthUserClaims;
      const nowSec = Math.floor(Date.now() / 1000);
      if (typeof claims.exp === 'number' && nowSec >= claims.exp) return null;
      return claims;
    } catch {
      return null;
    }
  }

  requireUser(authHeader?: string): RequestUser {
    const token = this.extractToken(authHeader);
    const claims = token ? this.verifyJwtHs256(token) : null;
    if (!claims || !claims.sub) {
      throw new UnauthorizedException('Invalid or missing token');
    }
    return { userId: String(claims.sub), email: claims.email, name: claims.name };
  }

  optionalUser(authHeader?: string): RequestUser | null {
    const token = this.extractToken(authHeader);
    const claims = token ? this.verifyJwtHs256(token) : null;
    if (!claims || !claims.sub) return null;
    return { userId: String(claims.sub), email: claims.email, name: claims.name };
  }
}

