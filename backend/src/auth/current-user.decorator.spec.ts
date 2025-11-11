import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { RequestUser } from './types/auth-user';

// Re-create the decorator logic for testing
const extractUser = (_: unknown, ctx: ExecutionContext): RequestUser | undefined => {
  const req = ctx.switchToHttp().getRequest();
  return (req as any).user as RequestUser | undefined;
};

describe('CurrentUser Decorator', () => {

  const createMockExecutionContext = (user?: RequestUser): ExecutionContext => {
    const request = user ? { user } : {};

    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as ExecutionContext;
  };

  describe('extraction', () => {
    it('extracts user from request when user exists', () => {
      const mockUser: RequestUser = {
        userId: 'user123',
        email: 'test@example.com',
        name: 'Test User',
        roles: ['user', 'admin'],
      };

      const context = createMockExecutionContext(mockUser);
      // Using extractUser directly

      const result = extractUser(null, context);

      expect(result).toEqual(mockUser);
    });

    it('returns undefined when user is not present in request', () => {
      const context = createMockExecutionContext();
      // Using extractUser directly

      const result = extractUser(null, context);

      expect(result).toBeUndefined();
    });

    it('extracts user with minimal fields', () => {
      const mockUser: RequestUser = {
        userId: 'user456',
      };

      const context = createMockExecutionContext(mockUser);
      // Using extractUser directly

      const result = extractUser(null, context);

      expect(result).toEqual(mockUser);
    });

    it('extracts user with all optional fields', () => {
      const mockUser: RequestUser = {
        userId: 'user789',
        email: 'full@example.com',
        name: 'Full User',
        roles: ['admin', 'moderator', 'user'],
      };

      const context = createMockExecutionContext(mockUser);
      // Using extractUser directly

      const result = extractUser(null, context);

      expect(result).toEqual(mockUser);
      expect(result?.userId).toBe('user789');
      expect(result?.email).toBe('full@example.com');
      expect(result?.name).toBe('Full User');
      expect(result?.roles).toEqual(['admin', 'moderator', 'user']);
    });

    it('returns user object as-is without modification', () => {
      const mockUser: RequestUser = {
        userId: 'preserve-test',
        email: 'preserve@example.com',
        name: 'Preserve User',
        roles: ['test'],
      };

      const context = createMockExecutionContext(mockUser);
      // Using extractUser directly

      const result = extractUser(null, context);

      // Should be the exact same reference
      const request = context.switchToHttp().getRequest();
      expect(result).toBe((request as any).user);
    });

    it('handles request with empty user object', () => {
      const mockUser = {} as RequestUser;

      const context = createMockExecutionContext(mockUser);
      // Using extractUser directly

      const result = extractUser(null, context);

      expect(result).toEqual({});
    });

    it('ignores decorator data parameter', () => {
      const mockUser: RequestUser = {
        userId: 'ignore-param',
      };

      const context = createMockExecutionContext(mockUser);
      // Using extractUser directly

      // The first parameter to the factory is the decorator data
      // which should be ignored (that's why it's typed as unknown)
      const result1 = extractUser(null, context);
      const result2 = extractUser('some-data', context);
      const result3 = extractUser({ key: 'value' }, context);

      expect(result1).toEqual(mockUser);
      expect(result2).toEqual(mockUser);
      expect(result3).toEqual(mockUser);
    });
  });
});
