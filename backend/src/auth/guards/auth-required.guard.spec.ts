import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthRequiredGuard } from './auth-required.guard';
import { AuthService } from '../auth.service';
import { UsersService } from '../../users/users.service';

describe('AuthRequiredGuard', () => {
  let guard: AuthRequiredGuard;
  let authService: jest.Mocked<AuthService>;
  let usersService: jest.Mocked<UsersService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthRequiredGuard,
        {
          provide: AuthService,
          useValue: {
            requireUser: jest.fn(),
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

    guard = module.get<AuthRequiredGuard>(AuthRequiredGuard);
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
    it('throws UnauthorizedException when no authorization header is present', async () => {
      const context = createMockExecutionContext();
      authService.requireUser.mockImplementation(() => {
        throw new Error('No token');
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Authentication required');
    });

    it('throws UnauthorizedException when invalid token is provided', async () => {
      const context = createMockExecutionContext('Bearer invalid-token');
      authService.requireUser.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('returns true and attaches user when valid token with email is provided', async () => {
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

      authService.requireUser.mockReturnValue(principal);
      usersService.getOrCreateByEmail.mockResolvedValue(userDoc as any);

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(authService.requireUser).toHaveBeenCalledWith('Bearer valid-token');
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

      authService.requireUser.mockReturnValue(principal);
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

      authService.requireUser.mockReturnValue(principal);
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

      authService.requireUser.mockReturnValue(principal);
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

      authService.requireUser.mockReturnValue(principal);
      usersService.getOrCreateByEmail.mockResolvedValue(userDoc as any);

      await guard.canActivate(context);

      expect((request as any).user.roles).toEqual([]);
    });

    it('attaches principal directly when no email is present', async () => {
      const context = createMockExecutionContext('Bearer token');
      const request = context.switchToHttp().getRequest();

      const principal = {
        userId: "test-user-id",
        name: 'Service Account',
        // No email
      };

      authService.requireUser.mockReturnValue(principal);

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(usersService.getOrCreateByEmail).not.toHaveBeenCalled();
      expect((request as any).user).toEqual(principal);
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
        _id: { toString: () => 'objectid456' }, // ObjectId-like object
        email: 'user@example.com',
        displayName: 'Test User',
        roles: ['user'],
      };

      authService.requireUser.mockReturnValue(principal);
      usersService.getOrCreateByEmail.mockResolvedValue(userDoc as any);

      await guard.canActivate(context);

      expect((request as any).user.userId).toBe('objectid456');
    });

    it('throws UnauthorizedException when requireUser throws any error', async () => {
      const context = createMockExecutionContext('Bearer token');
      authService.requireUser.mockImplementation(() => {
        throw new Error('Token expired');
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Authentication required');
    });

    it('passes authorization header to requireUser', async () => {
      const context = createMockExecutionContext('Bearer test-token-123');

      const principal = {
        userId: "test-user-id",
        email: 'user@example.com',
        name: 'User',
      };

      const userDoc = {
        _id: 'user123',
        email: 'user@example.com',
        displayName: 'User',
        roles: ['user'],
      };

      authService.requireUser.mockReturnValue(principal);
      usersService.getOrCreateByEmail.mockResolvedValue(userDoc as any);

      await guard.canActivate(context);

      expect(authService.requireUser).toHaveBeenCalledWith('Bearer test-token-123');
    });

    it('handles missing authorization header gracefully', async () => {
      const context = createMockExecutionContext(); // No auth header
      authService.requireUser.mockImplementation(() => {
        throw new Error('No auth header');
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      expect(authService.requireUser).toHaveBeenCalledWith(undefined);
    });
  });
});
