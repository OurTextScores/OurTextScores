import { WorksService } from './works.service';
import type { Model } from 'mongoose';
import { Work } from './schemas/work.schema';
import { Source } from './schemas/source.schema';
import { SourceRevision } from './schemas/source-revision.schema';

describe('WorksService approvals flow', () => {
  let service: WorksService;
  let workModel: jest.Mocked<Partial<Model<Work>>> & any;
  let sourceModel: jest.Mocked<Partial<Model<Source>>> & any;
  let sourceRevisionModel: jest.Mocked<Partial<Model<SourceRevision>>> & any;
  let projectModel: any;
  let revisionRatingModel: any;
  let revisionCommentModel: any;
  let revisionCommentVoteModel: any;
  const imslpService = {} as any;
  const storageService = {} as any;
  const fossilService = {} as any;
  const watches = { getSubscribersUserIds: jest.fn() } as any;
  const notifications = { queueNewRevision: jest.fn() } as any;
  const searchService = { indexWork: jest.fn() } as any;
  const branchesService = { migrateSource: jest.fn() } as any;
  const usersService = { userModel: { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }) }) }) } } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    workModel = { findOneAndUpdate: jest.fn(), findOne: jest.fn() } as any;
    sourceModel = { updateOne: jest.fn() } as any;
    sourceRevisionModel = { findOne: jest.fn() } as any;
    projectModel = { find: jest.fn() } as any;
    revisionRatingModel = {} as any;
    revisionCommentModel = {} as any;
    revisionCommentVoteModel = {} as any;
    service = new WorksService(
      workModel as any,
      sourceModel as any,
      sourceRevisionModel as any,
      projectModel as any,
      revisionRatingModel as any,
      revisionCommentModel as any,
      revisionCommentVoteModel as any,
      imslpService,
      storageService,
      fossilService,
      watches,
      notifications,
      searchService,
      usersService,
      branchesService
    );
  });

  it('approveRevision updates status, updates latest and notifies watchers', async () => {
    const revDoc: any = {
      workId: 'w', sourceId: 's', revisionId: 'r2', createdAt: new Date('2024-01-02'),
      status: 'pending_approval', approval: { ownerUserId: 'owner1' }, derivatives: { canonicalXml: { bucket: 'b', objectKey: 'c', sizeBytes: 1, checksum: { algorithm: 'sha256', hexDigest: 'x' }, contentType: 'application/xml', lastModifiedAt: new Date() } },
      save: jest.fn().mockResolvedValue(undefined)
    };
    sourceRevisionModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(revDoc) });
    sourceModel.updateOne.mockReturnValue({ exec: () => Promise.resolve({}) });
    const spyRecord = jest.spyOn(service as any, 'recordSourceRevision').mockResolvedValue(null);
    watches.getSubscribersUserIds.mockResolvedValue(['u1', 'u2']);

    const res = await service.approveRevision('w', 's', 'r2', { userId: 'owner1', roles: [] });
    expect(res).toEqual({ status: 'approved' });
    expect(revDoc.status).toBe('approved');
    expect(sourceModel.updateOne).toHaveBeenCalled();
    expect(spyRecord).toHaveBeenCalled();
    expect(watches.getSubscribersUserIds).toHaveBeenCalledWith('w', 's');
    expect(notifications.queueNewRevision).toHaveBeenCalled();
  });
});
