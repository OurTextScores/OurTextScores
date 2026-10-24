import { createHmac } from 'node:crypto';
import { AuthService } from '../../auth/auth.service';
import {
  createRateLimitMiddleware,
  resetUploadLimit,
  uploadLimitState
} from './rate-limit.middleware';

describe('verified account upload limits', () => {
  const secret = 'isolated-limiter-test-secret';
  const auth = new AuthService({ get: () => secret } as any);
  const users: any = {
    findByEmail: jest.fn(async (email) => ({ _id: email, email, roles: ['user'] }))
  };
  const operations: any = { allowance: jest.fn(async () => null) };
  const token = (email: string, nonce: number) => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: email, email, nonce, exp: Date.now() / 1000 + 3600 })
    ).toString('base64url');
    const data = `${header}.${payload}`;
    return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
  };
  async function attempt(bearer: string) {
    const res: any = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    const req: any = {
      method: 'POST',
      path: '/api/projects/1/sources',
      header: () => `Bearer ${bearer}`,
      ip: '127.0.0.99'
    };
    await createRateLimitMiddleware(auth, users, operations)(req, res, next);
    return { res, next };
  }
  beforeEach(() => {
    resetUploadLimit('a@test.local');
    resetUploadLimit('b@test.local');
    operations.allowance.mockResolvedValue(null);
  });
  it('shares the same allowance across token renewal and resets only the target account', async () => {
    for (let n = 0; n < 60; n++)
      expect((await attempt(token('a@test.local', n))).next).toHaveBeenCalledWith();
    expect((await attempt(token('a@test.local', 61))).res.status).toHaveBeenCalledWith(429);
    await attempt(token('b@test.local', 1));
    resetUploadLimit('a@test.local');
    expect(uploadLimitState('a@test.local').count).toBe(0);
    expect(uploadLimitState('b@test.local').count).toBe(1);
    expect((await attempt(token('a@test.local', 62))).next).toHaveBeenCalledWith();
  });
  it('does not trust a forged Bearer token as an authenticated account', async () => {
    users.findByEmail.mockClear();
    await attempt('forged.token.value');
    expect(users.findByEmail).not.toHaveBeenCalled();
  });
  it('applies an active allowance without clearing accumulated usage', async () => {
    await attempt(token('a@test.local', 1));
    operations.allowance.mockResolvedValue({ limit: 200 });
    const { res } = await attempt(token('a@test.local', 2));
    expect(res.setHeader).toHaveBeenCalledWith('x-ratelimit-limit', '200');
    expect(uploadLimitState('a@test.local').count).toBe(2);
  });
});
