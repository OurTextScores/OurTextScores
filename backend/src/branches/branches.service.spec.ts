import { BranchesService } from './branches.service';
import { NotFoundException, ForbiddenException } from '@nestjs/common';

// minimal chain helper for .lean().exec()
function chain<T>(result: T) {
  return { sort: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(result) } as any;
}

describe('BranchesService', () => {
  let svc: BranchesService;
  const branchModel = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    deleteOne: jest.fn()
  } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    svc = new BranchesService(branchModel as any);
  });

  describe('sanitizeName', () => {
    it('normalizes names with spaces', () => {
      expect(svc.sanitizeName(' Feature Branch ')).toBe('Feature-Branch');
    });

    it('returns main for empty string', () => {
      expect(svc.sanitizeName('')).toBe('main');
    });

    it('returns main for undefined', () => {
      expect(svc.sanitizeName(undefined)).toBe('main');
    });

    it('returns main for whitespace only', () => {
      expect(svc.sanitizeName('   ')).toBe('main');
    });

    it('removes special characters except allowed ones', () => {
      expect(svc.sanitizeName('feature@#$%branch!')).toBe('featurebranch');
      expect(svc.sanitizeName('feat_ure.branch-123')).toBe('feat_ure.branch-123');
    });

    it('replaces multiple spaces with single dash', () => {
      expect(svc.sanitizeName('my    feature    branch')).toBe('my-feature-branch');
    });

    it('truncates to 64 characters', () => {
      const longName = 'a'.repeat(100);
      expect(svc.sanitizeName(longName)).toHaveLength(64);
    });

    it('returns main if only special chars are provided', () => {
      expect(svc.sanitizeName('@#$%^&*()')).toBe('main');
    });
  });

  describe('listBranches', () => {
    it('returns default main when none exist', async () => {
      branchModel.find.mockReturnValue(chain([]));
      const out = await svc.listBranches('w', 's');
      expect(out).toEqual([{ name: 'main', policy: 'public' }]);
    });

    it('returns default main when docs is null', async () => {
      branchModel.find.mockReturnValue(chain(null));
      const out = await svc.listBranches('w', 's');
      expect(out).toEqual([{ name: 'main', policy: 'public' }]);
    });

    it('returns branches when they exist', async () => {
      const docs = [
        { name: 'main', policy: 'public', ownerUserId: null },
        { name: 'feature', policy: 'owner_approval', ownerUserId: 'user123' }
      ];
      branchModel.find.mockReturnValue(chain(docs));
      const out = await svc.listBranches('w', 's');
      expect(out).toEqual([
        { name: 'main', policy: 'public', ownerUserId: undefined },
        { name: 'feature', policy: 'owner_approval', ownerUserId: 'user123' }
      ]);
    });

    it('converts null ownerUserId to undefined', async () => {
      const docs = [{ name: 'test', policy: 'public', ownerUserId: null }];
      branchModel.find.mockReturnValue(chain(docs));
      const out = await svc.listBranches('w', 's');
      expect(out[0].ownerUserId).toBeUndefined();
    });
  });

  describe('ensureDefaultMain', () => {
    it('creates main branch when it does not exist', async () => {
      branchModel.findOne.mockReturnValue(chain(null));
      branchModel.create.mockResolvedValue({});

      await svc.ensureDefaultMain('w', 's');

      expect(branchModel.findOne).toHaveBeenCalledWith({ workId: 'w', sourceId: 's', name: 'main' });
      expect(branchModel.create).toHaveBeenCalledWith({ workId: 'w', sourceId: 's', name: 'main', policy: 'public' });
    });

    it('does not create main branch when it already exists', async () => {
      branchModel.findOne.mockReturnValue(chain({ name: 'main', policy: 'public' }));

      await svc.ensureDefaultMain('w', 's');

      expect(branchModel.findOne).toHaveBeenCalledWith({ workId: 'w', sourceId: 's', name: 'main' });
      expect(branchModel.create).not.toHaveBeenCalled();
    });
  });

  describe('createBranch', () => {
    it('persists and returns view with ownerUserId', async () => {
      branchModel.create.mockResolvedValue({ workId: 'w', sourceId: 's', name: 'feature', policy: 'owner_approval', ownerUserId: 'u1' });
      const out = await svc.createBranch({ workId: 'w', sourceId: 's', name: 'feature', policy: 'owner_approval', ownerUserId: 'u1' });
      expect(out).toEqual({ name: 'feature', policy: 'owner_approval', ownerUserId: 'u1' });
    });

    it('creates branch without ownerUserId', async () => {
      branchModel.create.mockResolvedValue({ workId: 'w', sourceId: 's', name: 'feature', policy: 'public', ownerUserId: null });
      const out = await svc.createBranch({ workId: 'w', sourceId: 's', name: 'feature', policy: 'public' });
      expect(out).toEqual({ name: 'feature', policy: 'public', ownerUserId: undefined });
    });

    it('sanitizes branch name before creating', async () => {
      branchModel.create.mockResolvedValue({ workId: 'w', sourceId: 's', name: 'my-feature', policy: 'public', ownerUserId: null });
      await svc.createBranch({ workId: 'w', sourceId: 's', name: '  My Feature  ', policy: 'public' });
      expect(branchModel.create).toHaveBeenCalledWith({ workId: 'w', sourceId: 's', name: 'My-Feature', policy: 'public', ownerUserId: undefined });
    });
  });

  describe('updateBranch', () => {
    it('allows owner to update branch', async () => {
      const doc = { name: 'feature', policy: 'public', ownerUserId: 'owner1', save: jest.fn().mockResolvedValue(undefined) } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
      const actor = { userId: 'owner1', roles: [] };
      const out = await svc.updateBranch('w', 's', 'feature', { policy: 'owner_approval' }, actor);
      expect(doc.policy).toBe('owner_approval');
      expect(out).toMatchObject({ name: 'feature', policy: 'owner_approval', ownerUserId: 'owner1' });
    });

    it('allows admin to update branch', async () => {
      const doc = { name: 'feature', policy: 'public', ownerUserId: 'owner1', save: jest.fn().mockResolvedValue(undefined) } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
      const actor = { userId: 'admin1', roles: ['admin'] };
      const out = await svc.updateBranch('w', 's', 'feature', { policy: 'owner_approval' }, actor);
      expect(doc.save).toHaveBeenCalled();
      expect(out).toMatchObject({ name: 'feature', policy: 'owner_approval' });
    });

    it('throws NotFoundException when branch does not exist', async () => {
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      const actor = { userId: 'user1', roles: [] };
      await expect(svc.updateBranch('w', 's', 'nonexistent', { policy: 'public' }, actor))
        .rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when user is not owner or admin', async () => {
      const doc = { name: 'feature', policy: 'public', ownerUserId: 'owner1', save: jest.fn() } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
      const actor = { userId: 'other-user', roles: [] };
      await expect(svc.updateBranch('w', 's', 'feature', { policy: 'owner_approval' }, actor))
        .rejects.toThrow(ForbiddenException);
    });

    it('updates ownerUserId when provided', async () => {
      const doc = { name: 'feature', policy: 'public', ownerUserId: 'owner1', save: jest.fn().mockResolvedValue(undefined) } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
      const actor = { userId: 'owner1', roles: [] };
      await svc.updateBranch('w', 's', 'feature', { ownerUserId: 'newowner' }, actor);
      expect(doc.ownerUserId).toBe('newowner');
    });

    it('clears ownerUserId when empty string provided', async () => {
      const doc = { name: 'feature', policy: 'public', ownerUserId: 'owner1', save: jest.fn().mockResolvedValue(undefined) } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
      const actor = { userId: 'owner1', roles: [] };
      await svc.updateBranch('w', 's', 'feature', { ownerUserId: '' }, actor);
      expect(doc.ownerUserId).toBeUndefined();
    });

    it('handles actor without roles array', async () => {
      const doc = { name: 'feature', policy: 'public', ownerUserId: 'owner1', save: jest.fn().mockResolvedValue(undefined) } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
      const actor = { userId: 'owner1' };
      const out = await svc.updateBranch('w', 's', 'feature', { policy: 'owner_approval' }, actor);
      expect(out).toMatchObject({ name: 'feature', policy: 'owner_approval' });
    });
  });

  describe('getBranchPolicy', () => {
    it('returns policy when branch exists', async () => {
      branchModel.findOne.mockReturnValue(chain({ name: 'feature', policy: 'owner_approval' }));
      const policy = await svc.getBranchPolicy('w', 's', 'feature');
      expect(policy).toBe('owner_approval');
    });

    it('returns public when branch does not exist', async () => {
      branchModel.findOne.mockReturnValue(chain(null));
      const policy = await svc.getBranchPolicy('w', 's', 'nonexistent');
      expect(policy).toBe('public');
    });

    it('sanitizes name before querying', async () => {
      branchModel.findOne.mockReturnValue(chain({ name: 'my-feature', policy: 'public' }));
      await svc.getBranchPolicy('w', 's', '  My Feature  ');
      expect(branchModel.findOne).toHaveBeenCalledWith({ workId: 'w', sourceId: 's', name: 'My-Feature' });
    });

    it('defaults to main when name is undefined', async () => {
      branchModel.findOne.mockReturnValue(chain({ name: 'main', policy: 'public' }));
      await svc.getBranchPolicy('w', 's', undefined);
      expect(branchModel.findOne).toHaveBeenCalledWith({ workId: 'w', sourceId: 's', name: 'main' });
    });
  });

  describe('getBranchOwnerUserId', () => {
    it('returns ownerUserId when branch exists', async () => {
      branchModel.findOne.mockReturnValue(chain({ name: 'feature', policy: 'owner_approval', ownerUserId: 'user123' }));
      const ownerId = await svc.getBranchOwnerUserId('w', 's', 'feature');
      expect(ownerId).toBe('user123');
    });

    it('returns undefined when branch does not exist', async () => {
      branchModel.findOne.mockReturnValue(chain(null));
      const ownerId = await svc.getBranchOwnerUserId('w', 's', 'nonexistent');
      expect(ownerId).toBeUndefined();
    });

    it('returns undefined when ownerUserId is null', async () => {
      branchModel.findOne.mockReturnValue(chain({ name: 'feature', policy: 'public', ownerUserId: null }));
      const ownerId = await svc.getBranchOwnerUserId('w', 's', 'feature');
      expect(ownerId).toBeUndefined();
    });

    it('sanitizes name before querying', async () => {
      branchModel.findOne.mockReturnValue(chain(null));
      await svc.getBranchOwnerUserId('w', 's', '  My Feature  ');
      expect(branchModel.findOne).toHaveBeenCalledWith({ workId: 'w', sourceId: 's', name: 'My-Feature' });
    });
  });

  describe('deleteBranch', () => {
    it('deletes branch when user is owner', async () => {
      const doc = { _id: 'branch123', name: 'feature', policy: 'public', ownerUserId: 'owner1' } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
      branchModel.deleteOne.mockReturnValue({ exec: jest.fn().mockResolvedValue({}) });

      const actor = { userId: 'owner1', roles: [] };
      const result = await svc.deleteBranch('w', 's', 'feature', actor);

      expect(result).toEqual({ deleted: true });
      expect(branchModel.deleteOne).toHaveBeenCalledWith({ _id: 'branch123' });
    });

    it('deletes branch when user is admin', async () => {
      const doc = { _id: 'branch123', name: 'feature', policy: 'public', ownerUserId: 'owner1' } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
      branchModel.deleteOne.mockReturnValue({ exec: jest.fn().mockResolvedValue({}) });

      const actor = { userId: 'admin1', roles: ['admin'] };
      const result = await svc.deleteBranch('w', 's', 'feature', actor);

      expect(result).toEqual({ deleted: true });
    });

    it('returns false when branch does not exist', async () => {
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      const actor = { userId: 'user1', roles: [] };
      const result = await svc.deleteBranch('w', 's', 'nonexistent', actor);

      expect(result).toEqual({ deleted: false });
      expect(branchModel.deleteOne).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when user is not owner or admin', async () => {
      const doc = { _id: 'branch123', name: 'feature', policy: 'public', ownerUserId: 'owner1' } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });

      const actor = { userId: 'other-user', roles: [] };
      await expect(svc.deleteBranch('w', 's', 'feature', actor))
        .rejects.toThrow(ForbiddenException);
    });

    it('prevents deleting main branch', async () => {
      const doc = { _id: 'branch123', name: 'main', policy: 'public', ownerUserId: 'owner1' } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });

      const actor = { userId: 'owner1', roles: [] };
      const result = await svc.deleteBranch('w', 's', 'main', actor);

      expect(result).toEqual({ deleted: false });
      expect(branchModel.deleteOne).not.toHaveBeenCalled();
    });

    it('sanitizes name before deleting', async () => {
      const doc = { _id: 'branch123', name: 'my-feature', policy: 'public', ownerUserId: 'owner1' } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
      branchModel.deleteOne.mockReturnValue({ exec: jest.fn().mockResolvedValue({}) });

      const actor = { userId: 'owner1', roles: [] };
      await svc.deleteBranch('w', 's', '  My Feature  ', actor);

      expect(branchModel.findOne).toHaveBeenCalledWith({ workId: 'w', sourceId: 's', name: 'My-Feature' });
    });

    it('handles actor without roles array', async () => {
      const doc = { _id: 'branch123', name: 'feature', policy: 'public', ownerUserId: 'owner1' } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
      branchModel.deleteOne.mockReturnValue({ exec: jest.fn().mockResolvedValue({}) });

      const actor = { userId: 'owner1' };
      const result = await svc.deleteBranch('w', 's', 'feature', actor);

      expect(result).toEqual({ deleted: true });
    });
  });
});

