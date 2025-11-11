import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext } from '@nestjs/common';
import { AuthOptionalGuard } from './auth-optional.guard';
import { AuthService } from '../auth.service';
import { UsersService } from '../../users/users.service';

describe('AuthOptionalGuard', () => {
  let guard: AuthOptionalGuard;
  let authService: jest.Mocked<AuthService>;
  let usersService: jest.Mocked<UsersService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthOptionalGuard,
        {
          provide: AuthService,
          useValue: {
            optionalUser: jest.fn(),
          },
        },
        {
          provide: UsersService,
          useValue: {
            getOrCreateByEmail: jest.fn(),
          },
        },
      ],
    }).compile();

    guard = module.get<AuthOptionalGuard>(AuthOptionalGuard);
    authService = module.get(AuthService);
    usersService = module.get(UsersService);
  });

  const createMockExecutionContext = (authHeader?: string): ExecutionContext => {
    const request = {
      headers: authHeader ? { authorization: authHeader } : {},
    };

    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as ExecutionContext;
  };

  describe('canActivate', () => {
    it('returns true when no authorization header is present', async () => {
      const context = createMockExecutionContext();
      authService.optionalUser.mockReturnValue(null);

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(authService.optionalUser).toHaveBeenCalledWith(undefined);
    });

    it('returns true when authorization header is invalid', async () => {
      const context = createMockExecutionContext('invalid-token');
      authService.optionalUser.mockReturnValue(null);

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(authService.optionalUser).toHaveBeenCalledWith('invalid-token');
    });

    it('attaches user to request when valid token with email is provided', async () => {
      const context = createMockExecutionContext('Bearer valid-token');
      const request = context.switchToHttp().getRequest();

      const principal = {
        userId: "test-user-id",
        email: 'user@example.com',
        name: 'Test User',
      };

      const userDoc = {
        _id: 'user123',
        email: 'user@example.com',
        displayName: 'Test User',
        roles: ['user', 'admin'],
      };

      authService.optionalUser.mockReturnValue(principal);
      usersService.getOrCreateByEmail.mockResolvedValue(userDoc as any);

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(authService.optionalUser).toHaveBeenCalledWith('Bearer valid-token');
      expect(usersService.getOrCreateByEmail).toHaveBeenCalledWith('user@example.com', 'Test User');
      expect((request as any).user).toEqual({
        userId: 'user123',
        email: 'user@example.com',
        name: 'Test User',
        roles: ['user', 'admin'],
      });
    });

    it('uses displayName from user doc if available', async () => {
      const context = createMockExecutionContext('Bearer token');
      const request = context.switchToHttp().getRequest();

      const principal = {
        userId: "test-user-id",
        email: 'user@example.com',
        name: 'Token Name',
      };

      const userDoc = {
        _id: 'user123',
        email: 'user@example.com',
        displayName: 'Database Name',
        roles: ['user'],
      };

      authService.optionalUser.mockReturnValue(principal);
      usersService.getOrCreateByEmail.mockResolvedValue(userDoc as any);

      await guard.canActivate(context);

      expect((request as any).user.name).toBe('Database Name');
    });

    it('falls back to principal name when displayName is not set', async () => {
      const context = createMockExecutionContext('Bearer token');
      const request = context.switchToHttp().getRequest();

      const principal = {
        userId: "test-user-id",
        email: 'user@example.com',
        name: 'Principal Name',
      };

      const userDoc = {
        _id: 'user123',
        email: 'user@example.com',
        displayName: null,
        roles: ['user'],
      };

      authService.optionalUser.mockReturnValue(principal);
      usersService.getOrCreateByEmail.mockResolvedValue(userDoc as any);

      await guard.canActivate(context);

      expect((request as any).user.name).toBe('Principal Name');
    });

    it('handles empty roles array', async () => {
      const context = createMockExecutionContext('Bearer token');
      const request = context.switchToHttp().getRequest();

      const principal = {
        userId: "test-user-id",
        email: 'user@example.com',
        name: 'Test User',
      };

      const userDoc = {
        _id: 'user123',
        email: 'user@example.com',
        displayName: 'Test User',
        roles: [],
      };

      authService.optionalUser.mockReturnValue(principal);
      usersService.getOrCreateByEmail.mockResolvedValue(userDoc as any);

      await guard.canActivate(context);

      expect((request as any).user.roles).toEqual([]);
    });

    it('handles non-array roles gracefully', async () => {
      const context = createMockExecutionContext('Bearer token');
      const request = context.switchToHttp().getRequest();

      const principal = {
        userId: "test-user-id",
        email: 'user@example.com',
        name: 'Test User',
      };

      const userDoc = {
        _id: 'user123',
        email: 'user@example.com',
        displayName: 'Test User',
        roles: null, // Invalid roles
      };

      authService.optionalUser.mockReturnValue(principal);
      usersService.getOrCreateByEmail.mockResolvedValue(userDoc as any);

      await guard.canActivate(context);

      expect((request as any).user.roles).toEqual([]);
    });

    it('attaches principal directly when no email is present', async () => {
      const context = createMockExecutionContext('Bearer token');
      const request = context.switchToHttp().getRequest();

      const principal = {
        userId: "test-user-id",
        name: 'Anonymous User',
        // No email
      };

      authService.optionalUser.mockReturnValue(principal);

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(usersService.getOrCreateByEmail).not.toHaveBeenCalled();
      expect((request as any).user).toEqual(principal);
    });

    it('does not set user on request when principal is null', async () => {
      const context = createMockExecutionContext('Bearer invalid');
      const request = context.switchToHttp().getRequest();

      authService.optionalUser.mockReturnValue(null);

      await guard.canActivate(context);

      expect((request as any).user).toBeUndefined();
    });

    it('handles undefined authorization header', async () => {
      const context = createMockExecutionContext();
      authService.optionalUser.mockReturnValue(null);

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(authService.optionalUser).toHaveBeenCalledWith(undefined);
    });

    it('converts user ID to string', async () => {
      const context = createMockExecutionContext('Bearer token');
      const request = context.switchToHttp().getRequest();

      const principal = {
        userId: "test-user-id",
        email: 'user@example.com',
        name: 'Test User',
      };

      const userDoc = {
        _id: { toString: () => 'objectid123' }, // ObjectId-like object
        email: 'user@example.com',
        displayName: 'Test User',
        roles: ['user'],
      };

      authService.optionalUser.mockReturnValue(principal);
      usersService.getOrCreateByEmail.mockResolvedValue(userDoc as any);

      await guard.canActivate(context);

      expect((request as any).user.userId).toBe('objectid123');
    });
  });
});
