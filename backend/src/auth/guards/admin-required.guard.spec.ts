import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminRequiredGuard } from './admin-required.guard';

describe('AdminRequiredGuard', () => {
  let guard: AdminRequiredGuard;

  beforeEach(() => {
    guard = new AdminRequiredGuard();
  });

  const createContextWithUser = (user: any): ExecutionContext => {
    const request = { user };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  };

  it('allows access when user has admin role', async () => {
    const context = createContextWithUser({ userId: 'u1', roles: ['user', 'admin'] });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
  });

  it('throws ForbiddenException when user has no roles', async () => {
    const context = createContextWithUser({ userId: 'u1' });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(context)).rejects.toThrow('Admin role required');
  });

  it('throws ForbiddenException when user is not admin', async () => {
    const context = createContextWithUser({ userId: 'u1', roles: ['user'] });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when request user is missing', async () => {
    const context = createContextWithUser(undefined);

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });
});

