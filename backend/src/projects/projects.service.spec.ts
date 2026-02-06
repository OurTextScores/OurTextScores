import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Model } from 'mongoose';
import { ProjectsService } from './projects.service';
import { Project } from './schemas/project.schema';
import { ProjectSourceRow } from './schemas/project-source-row.schema';
import { Source } from '../works/schemas/source.schema';
import { Work } from '../works/schemas/work.schema';
import { User } from '../users/schemas/user.schema';

function leanExec<T>(result: T) {
  return {
    lean: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(result)
  } as any;
}

describe('ProjectsService (unit, mocked models)', () => {
  let service: ProjectsService;
  let projectModel: jest.Mocked<Partial<Model<Project>>> & any;
  let rowModel: jest.Mocked<Partial<Model<ProjectSourceRow>>> & any;
  let sourceModel: jest.Mocked<Partial<Model<Source>>> & any;
  let workModel: jest.Mocked<Partial<Model<Work>>> & any;
  let userModel: jest.Mocked<Partial<Model<User>>> & any;
  const imslpService = { ensureByPermalink: jest.fn() } as any;
  const uploadSourceService = { upload: jest.fn() } as any;

  beforeEach(() => {
    jest.resetAllMocks();

    projectModel = {
      exists: jest.fn(),
      create: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      countDocuments: jest.fn(),
      updateOne: jest.fn()
    } as any;

    rowModel = {
      exists: jest.fn(),
      create: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findOneAndDelete: jest.fn(),
      countDocuments: jest.fn(),
      updateOne: jest.fn()
    } as any;

    sourceModel = {
      exists: jest.fn(),
      countDocuments: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      updateOne: jest.fn()
    } as any;

    workModel = {
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn()
    } as any;

    userModel = {
      find: jest.fn()
    } as any;

    userModel.find.mockReturnValue({
      select: jest.fn().mockReturnValue(leanExec([]))
    });

    service = new ProjectsService(
      projectModel as any,
      rowModel as any,
      sourceModel as any,
      workModel as any,
      userModel as any,
      imslpService,
      uploadSourceService
    );
  });

  it('createProject uses actor as default lead and strips lead from members', async () => {
    projectModel.exists.mockResolvedValue(false);
    projectModel.create.mockResolvedValue({
      toObject: () => ({
        projectId: 'prj_1',
        slug: 'my-project',
        title: 'My Project',
        description: 'Desc',
        leadUserId: 'u1',
        memberUserIds: ['u2'],
        visibility: 'public',
        status: 'active',
        rowCount: 0,
        linkedSourceCount: 0,
        createdBy: 'u1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z')
      })
    } as any);

    const out = await service.createProject(
      { title: '  My Project  ', description: 'Desc', memberUserIds: ['u1', 'u2'] },
      { userId: 'u1', roles: ['user'] }
    );

    expect(projectModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'My Project',
        leadUserId: 'u1',
        memberUserIds: ['u2'],
        createdBy: 'u1'
      })
    );
    expect(out.projectId).toBe('prj_1');
    expect(out.lead.userId).toBe('u1');
  });

  it('createProject defaults description to empty string when omitted', async () => {
    projectModel.exists.mockResolvedValue(false);
    projectModel.create.mockResolvedValue({
      toObject: () => ({
        projectId: 'prj_2',
        slug: 'project-no-description',
        title: 'Project No Description',
        description: '',
        leadUserId: 'u1',
        memberUserIds: [],
        visibility: 'public',
        status: 'active',
        rowCount: 0,
        linkedSourceCount: 0,
        createdBy: 'u1',
      })
    } as any);

    const out = await service.createProject(
      { title: 'Project No Description' },
      { userId: 'u1', roles: ['user'] }
    );

    expect(projectModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        description: ''
      })
    );
    expect(out.projectId).toBe('prj_2');
  });

  it('updateRow blocks verified toggle when actor is not source owner/lead/admin', async () => {
    projectModel.findOne.mockReturnValueOnce(leanExec({
      projectId: 'prj_1',
      leadUserId: 'lead_1',
      memberUserIds: ['member_1'],
      visibility: 'public',
      status: 'active'
    }));
    rowModel.findOne.mockReturnValueOnce(leanExec({
      projectId: 'prj_1',
      rowId: 'row_1',
      verified: false,
      rowVersion: 1
    }));

    await expect(
      service.updateRow(
        'prj_1',
        'row_1',
        { rowVersion: 1, verified: true },
        { userId: 'member_1', roles: ['user'] }
      )
    ).rejects.toThrow(ForbiddenException);
  });

  it('updateRow throws conflict when rowVersion does not match', async () => {
    projectModel.findOne.mockReturnValueOnce(leanExec({
      projectId: 'prj_1',
      leadUserId: 'lead_1',
      memberUserIds: ['member_1'],
      visibility: 'public',
      status: 'active'
    }));
    rowModel.findOne.mockReturnValueOnce(leanExec({
      projectId: 'prj_1',
      rowId: 'row_1',
      notes: 'before',
      rowVersion: 1,
      verified: false
    }));
    rowModel.findOneAndUpdate.mockReturnValueOnce(leanExec(null));

    await expect(
      service.updateRow(
        'prj_1',
        'row_1',
        { rowVersion: 1, notes: 'after' },
        { userId: 'member_1', roles: ['user'] }
      )
    ).rejects.toThrow(ConflictException);
  });

  it('createInternalSource returns existing linked source without creating new source', async () => {
    projectModel.findOne.mockReturnValueOnce(leanExec({
      projectId: 'prj_1',
      title: 'Proj',
      leadUserId: 'lead_1',
      memberUserIds: ['member_1'],
      visibility: 'public',
      status: 'active'
    }));
    rowModel.findOne.mockReturnValueOnce(leanExec({
      projectId: 'prj_1',
      rowId: 'row_1',
      linkedWorkId: '100',
      linkedSourceId: 'src_1'
    }));

    const out = await service.createInternalSource(
      'prj_1',
      'row_1',
      {},
      { userId: 'member_1', roles: ['user'] }
    );

    expect(out).toEqual(
      expect.objectContaining({ ok: true, workId: '100', sourceId: 'src_1' })
    );
    expect(sourceModel.create).not.toHaveBeenCalled();
  });

  it('createInternalSource uses external filename as label and includes URLs in description', async () => {
    projectModel.findOne.mockReturnValueOnce(leanExec({
      projectId: 'prj_1',
      title: 'Proj',
      leadUserId: 'lead_1',
      memberUserIds: ['member_1'],
      visibility: 'public',
      status: 'active'
    }));
    rowModel.findOne.mockReturnValueOnce(leanExec({
      projectId: 'prj_1',
      rowId: 'row_1',
      externalScoreUrl: 'https://github.com/DCMLab/schema_annotation_data/blob/master/data/mozart_sonatas/mscore/K279-1.mscx',
      imslpUrl: 'https://imslp.org/wiki/Piano_Sonata_No.1',
      notes: 'curation note',
      hasReferencePdf: false
    }));

    sourceModel.exists.mockResolvedValue(false);
    sourceModel.create.mockResolvedValue({} as any);
    workModel.findOneAndUpdate.mockReturnValue(leanExec({}));
    workModel.updateOne.mockReturnValue(leanExec({}));
    sourceModel.updateOne.mockReturnValue(leanExec({}));
    projectModel.updateOne.mockReturnValue(leanExec({}));
    sourceModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue(leanExec({ projectIds: ['prj_1'] }))
    } as any);
    rowModel.findOneAndUpdate.mockReturnValue(leanExec({ rowId: 'row_1', rowVersion: 2 }));
    rowModel.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(1) } as any);
    sourceModel.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(1) } as any);

    const out = await service.createInternalSource(
      'prj_1',
      'row_1',
      { workId: '5000' },
      { userId: 'member_1', roles: ['user'] }
    );

    expect(sourceModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'K279-1.mscx',
        description: expect.stringContaining('External source: https://github.com/DCMLab/schema_annotation_data/blob/master/data/mozart_sonatas/mscore/K279-1.mscx')
      })
    );
    expect(sourceModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('IMSLP: https://imslp.org/wiki/Piano_Sonata_No.1')
      })
    );
    expect(out).toEqual(expect.objectContaining({ ok: true, workId: '5000' }));
  });

  it('joinProject adds user to members when eligible', async () => {
    projectModel.findOne.mockReturnValueOnce(leanExec({
      projectId: 'prj_1',
      leadUserId: 'lead_1',
      memberUserIds: ['member_1'],
      visibility: 'public',
      status: 'active',
      title: 'Project',
      slug: 'project',
      description: '',
      rowCount: 0,
      linkedSourceCount: 0,
      createdBy: 'lead_1'
    }));
    projectModel.findOneAndUpdate.mockReturnValueOnce(leanExec({
      projectId: 'prj_1',
      leadUserId: 'lead_1',
      memberUserIds: ['member_1', 'member_2'],
      visibility: 'public',
      status: 'active',
      title: 'Project',
      slug: 'project',
      description: '',
      rowCount: 0,
      linkedSourceCount: 0,
      createdBy: 'lead_1'
    }));

    const out = await service.joinProject('prj_1', { userId: 'member_2', roles: ['user'] });
    expect(projectModel.findOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'prj_1' },
      { $addToSet: { memberUserIds: 'member_2' } },
      { new: true }
    );
    expect(out.members.map((m: any) => m.userId)).toContain('member_2');
  });

  it('removeSource requires project lead', async () => {
    projectModel.findOne.mockReturnValueOnce(leanExec({
      projectId: 'prj_1',
      leadUserId: 'lead_1',
      memberUserIds: ['member_1'],
      visibility: 'public',
      status: 'active'
    }));

    await expect(
      service.removeSource('prj_1', 'src_1', { userId: 'member_1', roles: ['user'] })
    ).rejects.toThrow(ForbiddenException);
  });
});
