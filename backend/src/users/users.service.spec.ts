import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UsersService } from './users.service';
import { User, UserDocument } from './schemas/user.schema';

describe('UsersService', () => {
  let service: UsersService;
  let model: jest.Mocked<Model<UserDocument>>;

  beforeEach(async () => {
    const mockModel = {
      findById: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getModelToken(User.name),
          useValue: mockModel,
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    model = module.get(getModelToken(User.name));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findById', () => {
    it('finds user by ID', async () => {
      const mockUser = {
        _id: 'user123',
        email: 'test@example.com',
        displayName: 'Test User',
        roles: ['user'],
      };

      model.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockUser),
      } as any);

      const result = await service.findById('user123');

      expect(model.findById).toHaveBeenCalledWith('user123');
      expect(result).toEqual(mockUser);
    });

    it('returns null when user not found', async () => {
      model.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      } as any);

      const result = await service.findById('nonexistent');

      expect(result).toBeNull();
    });

    it('handles various ID formats', async () => {
      const testIds = ['abc123', '507f1f77bcf86cd799439011', 'user-uuid-123'];

      for (const id of testIds) {
        model.findById.mockReturnValue({
          exec: jest.fn().mockResolvedValue({ _id: id }),
        } as any);

        await service.findById(id);
        expect(model.findById).toHaveBeenCalledWith(id);
      }
    });
  });

  describe('findByEmail', () => {
    it('finds user by email', async () => {
      const mockUser = {
        _id: 'user123',
        email: 'test@example.com',
        displayName: 'Test User',
        roles: ['user'],
      };

      model.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockUser),
      } as any);

      const result = await service.findByEmail('test@example.com');

      expect(model.findOne).toHaveBeenCalledWith({ email: 'test@example.com' });
      expect(result).toEqual(mockUser);
    });

    it('normalizes email to lowercase', async () => {
      model.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      } as any);

      await service.findByEmail('TEST@EXAMPLE.COM');

      expect(model.findOne).toHaveBeenCalledWith({ email: 'test@example.com' });
    });

    it('trims whitespace from email', async () => {
      model.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      } as any);

      await service.findByEmail('  test@example.com  ');

      expect(model.findOne).toHaveBeenCalledWith({ email: 'test@example.com' });
    });

    it('returns null for empty email', async () => {
      const result = await service.findByEmail('');

      expect(model.findOne).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('returns null for whitespace-only email', async () => {
      const result = await service.findByEmail('   ');

      expect(model.findOne).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('returns null for undefined email', async () => {
      const result = await service.findByEmail(undefined as any);

      expect(model.findOne).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('returns null for null email', async () => {
      const result = await service.findByEmail(null as any);

      expect(model.findOne).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('handles email with mixed case and spaces', async () => {
      model.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      } as any);

      await service.findByEmail('  MiXeD@CaSe.COM  ');

      expect(model.findOne).toHaveBeenCalledWith({ email: 'mixed@case.com' });
    });
  });

  describe('getOrCreateByEmail', () => {
    it('creates new user when email does not exist', async () => {
      const mockUser = {
        _id: 'newuser123',
        email: 'new@example.com',
        displayName: 'New User',
        roles: ['user'],
      };

      model.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockUser),
      } as any);

      const result = await service.getOrCreateByEmail('new@example.com', 'New User');

      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        { email: 'new@example.com' },
        {
          $setOnInsert: {
            email: 'new@example.com',
            displayName: 'New User',
            roles: ['user'],
            status: 'active',
            enforcementStrikes: 0,
          },
        },
        { new: true, upsert: true }
      );
      expect(result).toEqual(mockUser);
    });

    it('returns existing user without modifying when email exists', async () => {
      const mockUser = {
        _id: 'existing123',
        email: 'existing@example.com',
        displayName: 'Existing User',
        roles: ['user', 'admin'],
      };

      model.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockUser),
      } as any);

      const result = await service.getOrCreateByEmail('existing@example.com', 'Different Name');

      expect(result).toEqual(mockUser);
    });

    it('normalizes email before get-or-create', async () => {
      model.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({} as any),
      } as any);

      await service.getOrCreateByEmail('  TEST@EXAMPLE.COM  ', 'Test User');

      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        { email: 'test@example.com' },
        expect.objectContaining({
          $setOnInsert: expect.objectContaining({
            email: 'test@example.com',
          }),
        }),
        expect.any(Object)
      );
    });

    it('creates user without displayName when not provided', async () => {
      model.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({} as any),
      } as any);

      await service.getOrCreateByEmail('nodisplay@example.com');

      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        { email: 'nodisplay@example.com' },
        {
          $setOnInsert: {
            email: 'nodisplay@example.com',
            displayName: undefined,
            roles: ['user'],
            status: 'active',
            enforcementStrikes: 0,
          },
        },
        { new: true, upsert: true }
      );
    });

    it('assigns default "user" role to new users', async () => {
      model.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({} as any),
      } as any);

      await service.getOrCreateByEmail('newrole@example.com', 'New User');

      const call = model.findOneAndUpdate.mock.calls[0];
      expect(call[1].$setOnInsert.roles).toEqual(['user']);
    });

    it('uses upsert option to create if not exists', async () => {
      model.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({} as any),
      } as any);

      await service.getOrCreateByEmail('test@example.com');

      const call = model.findOneAndUpdate.mock.calls[0];
      expect(call[2]).toEqual({ new: true, upsert: true });
    });

    it('handles empty displayName', async () => {
      model.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({} as any),
      } as any);

      await service.getOrCreateByEmail('test@example.com', '');

      const call = model.findOneAndUpdate.mock.calls[0];
      expect(call[1].$setOnInsert.displayName).toBeUndefined();
    });
  });

  describe('toBasic', () => {
    it('converts user document to BasicUserInfo', () => {
      const user = {
        _id: 'user123',
        email: 'test@example.com',
        displayName: 'Test User',
        roles: ['user', 'admin'],
      } as any;

      const result = service.toBasic(user);

      expect(result).toEqual({
        id: 'user123',
        email: 'test@example.com',
        displayName: 'Test User',
        roles: ['user', 'admin'],
      });
    });

    it('converts _id to string', () => {
      const user = {
        _id: { toString: () => 'objectid123' },
        email: 'test@example.com',
        roles: ['user'],
      } as any;

      const result = service.toBasic(user);

      expect(result.id).toBe('objectid123');
    });

    it('handles missing displayName', () => {
      const user = {
        _id: 'user123',
        email: 'test@example.com',
        displayName: null,
        roles: ['user'],
      } as any;

      const result = service.toBasic(user);

      expect(result.displayName).toBeUndefined();
    });

    it('handles undefined displayName', () => {
      const user = {
        _id: 'user123',
        email: 'test@example.com',
        roles: ['user'],
      } as any;

      const result = service.toBasic(user);

      expect(result.displayName).toBeUndefined();
    });

    it('handles non-array roles gracefully', () => {
      const user = {
        _id: 'user123',
        email: 'test@example.com',
        roles: null,
      } as any;

      const result = service.toBasic(user);

      expect(result.roles).toEqual([]);
    });

    it('handles undefined roles', () => {
      const user = {
        _id: 'user123',
        email: 'test@example.com',
      } as any;

      const result = service.toBasic(user);

      expect(result.roles).toEqual([]);
    });

    it('preserves empty roles array', () => {
      const user = {
        _id: 'user123',
        email: 'test@example.com',
        roles: [],
      } as any;

      const result = service.toBasic(user);

      expect(result.roles).toEqual([]);
    });

    it('preserves multiple roles', () => {
      const user = {
        _id: 'user123',
        email: 'test@example.com',
        roles: ['user', 'admin', 'moderator', 'editor'],
      } as any;

      const result = service.toBasic(user);

      expect(result.roles).toEqual(['user', 'admin', 'moderator', 'editor']);
    });
  });
});
