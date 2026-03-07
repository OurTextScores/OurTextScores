import { BranchesService } from './branches.service';
import { NotFoundException, ForbiddenException } from '@nestjs/common';

// minimal chain helper for .lean().exec()
function chain<T>(result: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(result)
  } as any;
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

    it('returns trunk for empty string', () => {
      expect(svc.sanitizeName('')).toBe('trunk');
    });

    it('returns trunk for undefined', () => {
      expect(svc.sanitizeName(undefined)).toBe('trunk');
    });

    it('returns trunk for whitespace only', () => {
      expect(svc.sanitizeName('   ')).toBe('trunk');
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

    it('returns trunk if only special chars are provided', () => {
      expect(svc.sanitizeName('@#$%^&*()')).toBe('trunk');
    });

    it('aliases main to trunk', () => {
      expect(svc.sanitizeName('main')).toBe('trunk');
    });
  });

  describe('listBranches', () => {
    it('returns default trunk when none exist', async () => {
      branchModel.find.mockReturnValue(chain([]));
      const out = await svc.listBranches('w', 's');
      expect(out).toEqual([{ name: 'trunk', policy: 'public', lifecycle: 'open' }]);
    });

    it('returns default trunk when docs is null', async () => {
      branchModel.find.mockReturnValue(chain(null));
      const out = await svc.listBranches('w', 's');
      expect(out).toEqual([{ name: 'trunk', policy: 'public', lifecycle: 'open' }]);
    });

    it('returns branches when they exist', async () => {
      const docs = [
        { name: 'trunk', policy: 'public', ownerUserId: null },
        { name: 'feature', policy: 'owner_approval', ownerUserId: 'user123' }
      ];
      branchModel.find.mockReturnValue(chain(docs));
      const out = await svc.listBranches('w', 's');
      expect(out).toEqual([
        { name: 'feature', policy: 'owner_approval', ownerUserId: 'user123', lifecycle: 'open', baseRevisionId: undefined },
        { name: 'trunk', policy: 'public', ownerUserId: undefined, lifecycle: 'open', baseRevisionId: undefined }
      ]);
    });

    it('maps legacy main branch rows to trunk and deduplicates them', async () => {
      const docs = [
        { name: 'main', policy: 'public', ownerUserId: null },
        { name: 'trunk', policy: 'public', ownerUserId: 'owner1' }
      ];
      branchModel.find.mockReturnValue(chain(docs));
      const out = await svc.listBranches('w', 's');
      expect(out).toEqual([
        { name: 'trunk', policy: 'public', ownerUserId: 'owner1', lifecycle: 'open', baseRevisionId: undefined }
      ]);
    });

    it('maps a legacy main branch row to trunk when no trunk row exists', async () => {
      const docs = [{ name: 'main', policy: 'public', ownerUserId: null }];
      branchModel.find.mockReturnValue(chain(docs));
      const out = await svc.listBranches('w', 's');
      expect(out).toEqual([{ name: 'trunk', policy: 'public', ownerUserId: undefined, lifecycle: 'open', baseRevisionId: undefined }]);
    });

    it('converts null ownerUserId to undefined', async () => {
      const docs = [{ name: 'test', policy: 'public', ownerUserId: null }];
      branchModel.find.mockReturnValue(chain(docs));
      const out = await svc.listBranches('w', 's');
      expect(out[0].ownerUserId).toBeUndefined();
    });
  });

  describe('ensureDefaultTrunk', () => {
    it('creates trunk branch when it does not exist', async () => {
      branchModel.findOne.mockReturnValue(chain(null));
      branchModel.create.mockResolvedValue({});

      await svc.ensureDefaultTrunk('w', 's');

      expect(branchModel.findOne).toHaveBeenCalledWith({
        workId: 'w',
        sourceId: 's',
        name: { $in: ['trunk', 'main'] }
      });
      expect(branchModel.create).toHaveBeenCalledWith({ workId: 'w', sourceId: 's', name: 'trunk', policy: 'public', lifecycle: 'open' });
    });

    it('does not create trunk branch when a legacy main branch already exists', async () => {
      branchModel.findOne.mockReturnValue(chain({ name: 'main', policy: 'public' }));

      await svc.ensureDefaultTrunk('w', 's');

      expect(branchModel.create).not.toHaveBeenCalled();
    });

    it('does not create trunk branch when it already exists', async () => {
      branchModel.findOne.mockReturnValue(chain({ name: 'trunk', policy: 'public' }));

      await svc.ensureDefaultTrunk('w', 's');

      expect(branchModel.findOne).toHaveBeenCalledWith({
        workId: 'w',
        sourceId: 's',
        name: { $in: ['trunk', 'main'] }
      });
      expect(branchModel.create).not.toHaveBeenCalled();
    });
  });

  describe('createBranch', () => {
    it('persists and returns view with ownerUserId', async () => {
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      branchModel.create.mockResolvedValue({ workId: 'w', sourceId: 's', name: 'feature', policy: 'owner_approval', ownerUserId: 'u1' });
      const out = await svc.createBranch({ workId: 'w', sourceId: 's', name: 'feature', policy: 'owner_approval', ownerUserId: 'u1' });
      expect(out).toEqual({ name: 'feature', policy: 'owner_approval', ownerUserId: 'u1', baseRevisionId: undefined, lifecycle: 'open' });
    });

    it('creates branch without ownerUserId', async () => {
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      branchModel.create.mockResolvedValue({ workId: 'w', sourceId: 's', name: 'feature', policy: 'public', ownerUserId: null });
      const out = await svc.createBranch({ workId: 'w', sourceId: 's', name: 'feature', policy: 'public' });
      expect(out).toEqual({ name: 'feature', policy: 'public', ownerUserId: undefined, baseRevisionId: undefined, lifecycle: 'open' });
    });

    it('sanitizes branch name before creating', async () => {
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      branchModel.create.mockResolvedValue({ workId: 'w', sourceId: 's', name: 'My-Feature', policy: 'public', ownerUserId: null });
      await svc.createBranch({ workId: 'w', sourceId: 's', name: '  My Feature  ', policy: 'public' });
      expect(branchModel.create).toHaveBeenCalledWith({
        workId: 'w',
        sourceId: 's',
        name: 'My-Feature',
        policy: 'public',
        ownerUserId: undefined,
        baseRevisionId: undefined,
        lifecycle: 'open'
      });
    });

    it('treats a legacy main branch as the existing trunk branch', async () => {
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue({ name: 'main', policy: 'public', ownerUserId: null }) });
      const out = await svc.createBranch({ workId: 'w', sourceId: 's', name: 'trunk', policy: 'public' });
      expect(out).toEqual({ name: 'trunk', policy: 'public', ownerUserId: undefined, baseRevisionId: undefined, lifecycle: 'open' });
      expect(branchModel.create).not.toHaveBeenCalled();
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

    it('finds a legacy main branch when updating trunk', async () => {
      const doc = { name: 'main', policy: 'public', ownerUserId: 'owner1', save: jest.fn().mockResolvedValue(undefined) } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
      const actor = { userId: 'owner1', roles: [] };
      const out = await svc.updateBranch('w', 's', 'trunk', { policy: 'owner_approval' }, actor);
      expect(out).toMatchObject({ name: 'trunk', policy: 'owner_approval' });
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
      branchModel.findOne.mockReturnValue(chain({ name: 'My-Feature', policy: 'public' }));
      await svc.getBranchPolicy('w', 's', '  My Feature  ');
      expect(branchModel.findOne).toHaveBeenCalledWith({ workId: 'w', sourceId: 's', name: { $in: ['My-Feature'] } });
    });

    it('defaults to trunk when name is undefined', async () => {
      branchModel.findOne.mockReturnValue(chain({ name: 'trunk', policy: 'public' }));
      await svc.getBranchPolicy('w', 's', undefined);
      expect(branchModel.findOne).toHaveBeenCalledWith({ workId: 'w', sourceId: 's', name: { $in: ['trunk', 'main'] } });
    });

    it('treats legacy main row as trunk when querying policy', async () => {
      branchModel.findOne.mockReturnValue(chain({ name: 'main', policy: 'public' }));
      const policy = await svc.getBranchPolicy('w', 's', 'trunk');
      expect(policy).toBe('public');
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
      expect(branchModel.findOne).toHaveBeenCalledWith({ workId: 'w', sourceId: 's', name: { $in: ['My-Feature'] } });
    });

    it('treats legacy main row as trunk when querying owner', async () => {
      branchModel.findOne.mockReturnValue(chain({ name: 'main', policy: 'public', ownerUserId: 'legacy-owner' }));
      const ownerId = await svc.getBranchOwnerUserId('w', 's', 'trunk');
      expect(ownerId).toBe('legacy-owner');
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

    it('prevents deleting trunk branch', async () => {
      const doc = { _id: 'branch123', name: 'trunk', policy: 'public', ownerUserId: 'owner1' } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });

      const actor = { userId: 'owner1', roles: [] };
      const result = await svc.deleteBranch('w', 's', 'trunk', actor);

      expect(result).toEqual({ deleted: false });
      expect(branchModel.deleteOne).not.toHaveBeenCalled();
    });

    it('also prevents deleting a legacy main row through trunk alias', async () => {
      const doc = { _id: 'branch123', name: 'main', policy: 'public', ownerUserId: 'owner1' } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });

      const actor = { userId: 'owner1', roles: [] };
      const result = await svc.deleteBranch('w', 's', 'trunk', actor);

      expect(result).toEqual({ deleted: false });
      expect(branchModel.deleteOne).not.toHaveBeenCalled();
    });

    it('sanitizes name before deleting', async () => {
      const doc = { _id: 'branch123', name: 'my-feature', policy: 'public', ownerUserId: 'owner1' } as any;
      branchModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
      branchModel.deleteOne.mockReturnValue({ exec: jest.fn().mockResolvedValue({}) });

      const actor = { userId: 'owner1', roles: [] };
      await svc.deleteBranch('w', 's', '  My Feature  ', actor);

      expect(branchModel.findOne).toHaveBeenCalledWith({ workId: 'w', sourceId: 's', name: { $in: ['My-Feature'] } });
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
