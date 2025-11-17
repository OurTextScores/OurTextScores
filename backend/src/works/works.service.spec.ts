import { WorksService } from './works.service';
import type { Model } from 'mongoose';
import { Work } from './schemas/work.schema';
import { Source } from './schemas/source.schema';
import { SourceRevision } from './schemas/source-revision.schema';

// Minimal chainable query mock helper
function chain<T>(result: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(result)
  } as any;
}

describe('WorksService (unit, mocked models)', () => {
  let service: WorksService;
  let workModel: jest.Mocked<Partial<Model<Work>>> & any;
  let sourceModel: jest.Mocked<Partial<Model<Source>>> & any;
  let sourceRevisionModel: jest.Mocked<Partial<Model<SourceRevision>>> & any;
  let usersService: any;
  const imslpService = {
    ensureByWorkId: jest.fn(),
    ensureByPermalink: jest.fn(),
    resolvePageIdFromUrl: jest.fn()
  } as any;
  const storageService = {} as any;
  const fossilService = {} as any;
  const watches = { getSubscribersUserIds: jest.fn() } as any;
  const notifications = { queueNewRevision: jest.fn() } as any;
  const searchService = { indexWork: jest.fn() } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    usersService = { userModel: { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue(chain([])) }) } } as any;
    workModel = {
      find: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      countDocuments: jest.fn(),
    } as any;
    sourceModel = {
      find: jest.fn(),
      findOne: jest.fn(),
      updateOne: jest.fn(),
      deleteOne: jest.fn(),
    } as any;
    sourceRevisionModel = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      updateOne: jest.fn(),
      deleteMany: jest.fn(),
    } as any;

    service = new WorksService(
      workModel as any,
      sourceModel as any,
      sourceRevisionModel as any,
      imslpService,
      storageService,
      fossilService,
      watches,
      notifications,
      searchService,
      usersService
    );
  });

  it('findAll returns summaries and enriches missing title/composer from IMSLP', async () => {
    const docs = [
      { workId: '100', sourceCount: 2, availableFormats: ['application/xml'], latestRevisionAt: new Date('2024-01-01') },
      { workId: '101', sourceCount: 0, availableFormats: [], latestRevisionAt: undefined }
    ];
    (workModel.countDocuments as jest.Mock) = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(2) });
    (workModel.find as jest.Mock).mockReturnValue({
      sort: () => ({
        skip: () => ({
          limit: () => ({
            lean: () => ({
              exec: () => Promise.resolve(docs)
            })
          })
        })
      })
    });
    imslpService.ensureByWorkId.mockImplementation(async (id: string) => ({
      workId: id,
      metadata: { workId: id, title: `Title ${id}`, composer: id === '100' ? 'Comp A' : 'Comp B', permalink: '', metadata: {} }
    }));

    const out = await service.findAll();
    expect(workModel.countDocuments).toHaveBeenCalled();
    expect(workModel.find).toHaveBeenCalled();
    expect(out).toMatchObject({
      works: [
        { workId: '100', title: 'Title 100', composer: 'Comp A' },
        { workId: '101', title: 'Title 101', composer: 'Comp B' }
      ],
      total: 2,
      limit: 20,
      offset: 0
    });
  });

  it('findAll supports pagination with custom limit and offset', async () => {
    const docs = [
      { workId: '200', sourceCount: 1, availableFormats: ['application/xml'], latestRevisionAt: new Date('2024-01-01') }
    ];
    (workModel.countDocuments as jest.Mock) = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(50) });
    const skipMock = jest.fn().mockReturnValue({
      limit: () => ({
        lean: () => ({
          exec: () => Promise.resolve(docs)
        })
      })
    });
    const sortMock = jest.fn().mockReturnValue({ skip: skipMock });
    (workModel.find as jest.Mock).mockReturnValue({ sort: sortMock });
    imslpService.ensureByWorkId.mockResolvedValue({
      workId: '200',
      metadata: { workId: '200', title: 'Test Work', composer: 'Test Composer', permalink: '', metadata: {} }
    });

    const out = await service.findAll({ limit: 10, offset: 20 });
    expect(workModel.countDocuments).toHaveBeenCalled();
    expect(sortMock).toHaveBeenCalled();
    expect(skipMock).toHaveBeenCalledWith(20);
    expect(out).toMatchObject({
      works: [{ workId: '200', title: 'Test Work', composer: 'Test Composer' }],
      total: 50,
      limit: 10,
      offset: 20
    });
  });

  it('updateWorkMetadata trims and sets optional fields', async () => {
    const updated = { workId: '200', sourceCount: 0, availableFormats: [], title: 'T', composer: 'C', catalogNumber: 'BWV 1' };
    (workModel.findOneAndUpdate as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(updated) }) });
    const res = await service.updateWorkMetadata('200', { title: '  T  ', composer: ' C ', catalogNumber: ' BWV 1 ' });
    expect(workModel.findOneAndUpdate).toHaveBeenCalled();
    expect(res).toMatchObject({ workId: '200', title: 'T', composer: 'C', catalogNumber: 'BWV 1' });
  });

  it('getWorkDetail throws not found', async () => {
    (workModel.findOne as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(null) }) });
    await expect(service.getWorkDetail('non-existent')).rejects.toThrow('Work non-existent not found');
  });


  it('ensureWorkWithMetadata returns work and metadata', async () => {
    const workId = '12345';
    const metadata = { workId, title: 'Test Work', composer: 'Test Composer', permalink: '', metadata: {} };
    const workDoc = { workId, sourceCount: 0, availableFormats: [] };

    imslpService.ensureByWorkId.mockResolvedValue({ metadata });
    workModel.findOneAndUpdate.mockReturnValue({
      exec: () => Promise.resolve(workDoc)
    });

    const result = await service.ensureWorkWithMetadata(workId);

    expect(imslpService.ensureByWorkId).toHaveBeenCalledWith(workId);
    expect(workModel.findOneAndUpdate).toHaveBeenCalled();
    expect(result.work).toEqual({
      workId,
      sourceCount: 0,
      availableFormats: [],
      title: undefined,
      composer: undefined,
      catalogNumber: undefined,
      latestRevisionAt: undefined
    });
    expect(result.metadata).toEqual(metadata);
  });

  it('ensureWorkWithMetadata throws for invalid workId', async () => {
    await expect(service.ensureWorkWithMetadata('invalid-id')).rejects.toThrow('workId must be the numeric IMSLP page_id');
  });

  it('saveWorkByImslpUrl saves a work from a URL', async () => {
    const url = 'https://imslp.org/wiki/Test_Work';
    const workId = '12345';
    const metadata = { workId, title: 'Test Work', composer: 'Test Composer', permalink: '', metadata: { basic_info: { page_id: workId }, files: [{}] } };
    const workDoc = { workId, sourceCount: 0, availableFormats: [] };

    jest.spyOn(service as any, 'resolvePageIdStrict').mockResolvedValue(workId);
    imslpService.ensureByPermalink.mockResolvedValue({ metadata });
    imslpService.ensureByWorkId.mockResolvedValue({ metadata });
    workModel.findOneAndUpdate.mockReturnValue({
      exec: () => Promise.resolve(workDoc)
    });

    const result = await service.saveWorkByImslpUrl(url);

    expect(result.work.workId).toEqual(workId);
    expect(result.metadata).toEqual(metadata);
  });

  it('saveWorkByImslpUrl throws for unresolvable URL', async () => {
    const url = 'https://imslp.org/wiki/Invalid_Work';
    jest.spyOn(service as any, 'resolvePageIdStrict').mockResolvedValue(null);
    jest.spyOn(service as any, 'resolvePageIdViaNode').mockResolvedValue(null);
    imslpService.resolvePageIdFromUrl.mockResolvedValue(null);

    await expect(service.saveWorkByImslpUrl(url)).rejects.toThrow('Unable to resolve numeric IMSLP page_id from URL');
  });

  describe('approveRevision', () => {
    it('should approve a revision', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const revisionId = 'rev-1';
      const actor = { userId: 'user-1', roles: ['admin'] };
      const revision = {
        workId,
        sourceId,
        revisionId,
        status: 'pending',
        approval: { ownerUserId: 'user-1' },
        save: jest.fn().mockResolvedValue(this),
      };
      sourceRevisionModel.findOne.mockReturnValue(chain(revision));
      sourceModel.updateOne.mockReturnValue(chain(undefined));
      workModel.findOneAndUpdate.mockReturnValue(chain({}));
      watches.getSubscribersUserIds.mockResolvedValue([]);

      const result = await service.approveRevision(workId, sourceId, revisionId, actor);

      expect(revision.status).toEqual('approved');
      expect(revision.save).toHaveBeenCalled();
      expect(sourceModel.updateOne).toHaveBeenCalled();
      expect(workModel.findOneAndUpdate).toHaveBeenCalled();
      expect(notifications.queueNewRevision).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'approved' });
    });

    it('should throw not found if revision does not exist', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const revisionId = 'rev-1';
      const actor = { userId: 'user-1', roles: ['admin'] };
      sourceRevisionModel.findOne.mockReturnValue(chain(null));

      await expect(service.approveRevision(workId, sourceId, revisionId, actor)).rejects.toThrow('Revision not found');
    });

    it('should return approved if revision is already approved', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const revisionId = 'rev-1';
      const actor = { userId: 'user-1', roles: ['admin'] };
      const revision = {
        workId,
        sourceId,
        revisionId,
        status: 'approved',
      };
      sourceRevisionModel.findOne.mockReturnValue(chain(revision));

      const result = await service.approveRevision(workId, sourceId, revisionId, actor);

      expect(result).toEqual({ status: 'approved' });
    });

    it('should throw bad request if user is not authorized', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const revisionId = 'rev-1';
      const actor = { userId: 'user-2' };
      const revision = {
        workId,
        sourceId,
        revisionId,
        status: 'pending',
        approval: { ownerUserId: 'user-1' },
      };
      sourceRevisionModel.findOne.mockReturnValue(chain(revision));

      await expect(service.approveRevision(workId, sourceId, revisionId, actor)).rejects.toThrow('Only branch owner or admin can approve');
    });
  });

  describe('rejectRevision', () => {
    it('should reject a revision', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const revisionId = 'rev-1';
      const actor = { userId: 'user-1', roles: ['admin'] };
      const revision = {
        workId,
        sourceId,
        revisionId,
        status: 'pending',
        approval: { ownerUserId: 'user-1' },
        save: jest.fn().mockResolvedValue(this),
      };
      sourceRevisionModel.findOne.mockReturnValue(chain(revision));

      const result = await service.rejectRevision(workId, sourceId, revisionId, actor);

      expect(revision.status).toEqual('rejected');
      expect(revision.save).toHaveBeenCalled();
      expect(result).toEqual({ status: 'rejected' });
    });

    it('should throw not found if revision does not exist', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const revisionId = 'rev-1';
      const actor = { userId: 'user-1', roles: ['admin'] };
      sourceRevisionModel.findOne.mockReturnValue(chain(null));

      await expect(service.rejectRevision(workId, sourceId, revisionId, actor)).rejects.toThrow('Revision not found');
    });

    it('should return rejected if revision is already rejected', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const revisionId = 'rev-1';
      const actor = { userId: 'user-1', roles: ['admin'] };
      const revision = {
        workId,
        sourceId,
        revisionId,
        status: 'rejected',
      };
      sourceRevisionModel.findOne.mockReturnValue(chain(revision));

      const result = await service.rejectRevision(workId, sourceId, revisionId, actor);

      expect(result).toEqual({ status: 'rejected' });
    });

    it('should throw bad request if user is not authorized', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const revisionId = 'rev-1';
      const actor = { userId: 'user-2' };
      const revision = {
        workId,
        sourceId,
        revisionId,
        status: 'pending',
        approval: { ownerUserId: 'user-1' },
      };
      sourceRevisionModel.findOne.mockReturnValue(chain(revision));

      await expect(service.rejectRevision(workId, sourceId, revisionId, actor)).rejects.toThrow('Only branch owner or admin can reject');
    });
  });

  describe('upsertMusicDiffDerivatives', () => {
    it('should update derivatives', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const revisionId = 'rev-1';
      const updates = {
        musicDiffHtml: { bucket: 'b', objectKey: 'h' },
        musicDiffPdf: { bucket: 'b', objectKey: 'p' },
        musicDiffReport: { bucket: 'b', objectKey: 'r' },
      };
      sourceRevisionModel.updateOne.mockReturnValue(chain(undefined));
      sourceModel.updateOne.mockReturnValue(chain(undefined));

      await service.upsertMusicDiffDerivatives(workId, sourceId, revisionId, updates as any);

      expect(sourceRevisionModel.updateOne).toHaveBeenCalled();
      expect(sourceModel.updateOne).toHaveBeenCalled();
    });

    it('should do nothing if no updates are provided', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const revisionId = 'rev-1';
      const updates = {};

      await service.upsertMusicDiffDerivatives(workId, sourceId, revisionId, updates);

      expect(sourceRevisionModel.updateOne).not.toHaveBeenCalled();
      expect(sourceModel.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('deleteSource', () => {
    it('should delete a source and its revisions', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const source = {
        workId,
        sourceId,
        storage: { bucket: 'b', objectKey: 'k' },
        provenance: { uploadedByUserId: 'owner-1' },
      };
      const revisions = [{ revisionId: 'rev-1', rawStorage: { bucket: 'b', objectKey: 'k' } }];
      sourceModel.findOne.mockReturnValue(chain(source));
      sourceRevisionModel.find.mockReturnValue(chain(revisions));
      storageService.deleteObject = jest.fn().mockResolvedValue(undefined);
      fossilService.removeRepository = jest.fn().mockResolvedValue(undefined);
      sourceRevisionModel.deleteMany.mockReturnValue(chain(undefined));
      sourceModel.deleteOne.mockReturnValue(chain(undefined));
      jest.spyOn(service as any, 'recomputeWorkStats').mockResolvedValue(undefined);

      const result = await service.deleteSource(workId, sourceId, { userId: 'owner-1', roles: ['user'] });

      expect(result).toEqual({ removed: true });
      expect(storageService.deleteObject).toHaveBeenCalled();
      expect(fossilService.removeRepository).toHaveBeenCalled();
      expect(sourceRevisionModel.deleteMany).toHaveBeenCalled();
      expect(sourceModel.deleteOne).toHaveBeenCalled();
      expect((service as any).recomputeWorkStats).toHaveBeenCalledWith(workId);
    });

    it('should return removed: false if source is not found', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      sourceModel.findOne.mockReturnValue(chain(null));

      const result = await service.deleteSource(workId, sourceId, { userId: 'someone', roles: ['admin'] });

      expect(result).toEqual({ removed: false });
    });

    it('should allow admin to delete a source they do not own', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const source = {
        workId,
        sourceId,
        storage: { bucket: 'b', objectKey: 'k' },
        provenance: { uploadedByUserId: 'owner-1' },
      };
      const revisions = [{ revisionId: 'rev-1', rawStorage: { bucket: 'b', objectKey: 'k' } }];
      sourceModel.findOne.mockReturnValue(chain(source));
      sourceRevisionModel.find.mockReturnValue(chain(revisions));
      storageService.deleteObject = jest.fn().mockResolvedValue(undefined);
      fossilService.removeRepository = jest.fn().mockResolvedValue(undefined);
      sourceRevisionModel.deleteMany.mockReturnValue(chain(undefined));
      sourceModel.deleteOne.mockReturnValue(chain(undefined));
      jest.spyOn(service as any, 'recomputeWorkStats').mockResolvedValue(undefined);

      const result = await service.deleteSource(workId, sourceId, { userId: 'admin-1', roles: ['admin'] });

      expect(result).toEqual({ removed: true });
    });

    it('should throw when actor is neither owner nor admin', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const source = {
        workId,
        sourceId,
        storage: { bucket: 'b', objectKey: 'k' },
        provenance: { uploadedByUserId: 'owner-1' },
      };
      const revisions = [
        { workId, sourceId, createdBy: 'owner-1', rawStorage: { bucket: 'b', objectKey: 'k' } }
      ];
      sourceModel.findOne.mockReturnValue(chain(source));
      sourceRevisionModel.find.mockReturnValue(chain(revisions));

      await expect(
        service.deleteSource(workId, sourceId, { userId: 'other-user', roles: ['user'] })
      ).rejects.toThrow('Only source owner or admin can delete source');
    });
  });

  describe('deleteAllSources', () => {
    it('should delete all sources and their revisions', async () => {
      const workId = 'work-1';
      const sources = [{ sourceId: 'source-1', storage: { bucket: 'b', objectKey: 'k' } }, { sourceId: 'source-2', storage: { bucket: 'b', objectKey: 'k' } }];
      const revisions = [{ revisionId: 'rev-1', rawStorage: { bucket: 'b', objectKey: 'k' } }];
      sourceModel.find.mockReturnValue(chain(sources));
      sourceRevisionModel.find.mockReturnValue(chain(revisions));
      storageService.deleteObject = jest.fn().mockResolvedValue(undefined);
      fossilService.removeRepository = jest.fn().mockResolvedValue(undefined);
      sourceRevisionModel.deleteMany.mockReturnValue(chain(undefined));
      sourceModel.deleteOne.mockReturnValue(chain(undefined));
      workModel.findOneAndUpdate.mockReturnValue(chain({}));

      const result = await service.deleteAllSources(workId);

      expect(result).toEqual({ removed: 2 });
      expect(storageService.deleteObject).toHaveBeenCalledTimes(4);
      expect(fossilService.removeRepository).toHaveBeenCalledTimes(2);
      expect(sourceRevisionModel.deleteMany).toHaveBeenCalledTimes(2);
      expect(sourceModel.deleteOne).toHaveBeenCalledTimes(2);
      expect(workModel.findOneAndUpdate).toHaveBeenCalled();
    });
  });

  describe('prunePendingSources', () => {
    it('should prune pending sources', async () => {
      const workId = 'work-1';
      const sources = [{ sourceId: 'source-1', storage: { bucket: 'b', objectKey: 'k' } }];
      const revisions = [{ revisionId: 'rev-1', rawStorage: { bucket: 'b', objectKey: 'k' } }];
      sourceModel.find.mockReturnValue(chain(sources));
      sourceRevisionModel.find.mockReturnValue(chain(revisions));
      storageService.deleteObject = jest.fn().mockResolvedValue(undefined);
      fossilService.removeRepository = jest.fn().mockResolvedValue(undefined);
      sourceRevisionModel.deleteMany.mockReturnValue(chain(undefined));
      sourceModel.deleteOne.mockReturnValue(chain(undefined));
      jest.spyOn(service as any, 'recomputeWorkStats').mockResolvedValue(undefined);

      const result = await service.prunePendingSources(workId);

      expect(result).toEqual({ removed: 1 });
      expect(storageService.deleteObject).toHaveBeenCalled();
      expect(fossilService.removeRepository).toHaveBeenCalled();
      expect(sourceRevisionModel.deleteMany).toHaveBeenCalled();
      expect(sourceModel.deleteOne).toHaveBeenCalled();
      expect((service as any).recomputeWorkStats).toHaveBeenCalledWith(workId);
    });
  });

  describe('recordSourceUpload', () => {
    it('should record a source upload', async () => {
      const workId = 'work-1';
      const formats = ['application/xml'];
      const timestamp = new Date();
      workModel.findOneAndUpdate.mockReturnValue(chain({}));

      await service.recordSourceUpload(workId, formats, timestamp);

      expect(workModel.findOneAndUpdate).toHaveBeenCalledWith(
        { workId },
        {
          $inc: { sourceCount: 1 },
          $set: { latestRevisionAt: timestamp },
          $addToSet: { availableFormats: { $each: formats } },
        },
        { new: true }
      );
    });
  });

  describe('recordSourceRevision', () => {
    it('should record a source revision', async () => {
      const workId = 'work-1';
      const formats = ['application/xml'];
      const timestamp = new Date();
      const updatedWork = { workId };
      workModel.findOneAndUpdate.mockReturnValue(chain(updatedWork));
      jest.spyOn(service as any, 'indexWork').mockResolvedValue(undefined);

      await service.recordSourceRevision(workId, formats, timestamp);

      expect(workModel.findOneAndUpdate).toHaveBeenCalledWith(
        { workId },
        {
          $set: { latestRevisionAt: timestamp },
          $addToSet: { availableFormats: { $each: formats } },
        },
        { new: true }
      );
      expect((service as any).indexWork).toHaveBeenCalled();
    });
  });

  it('getWorkDetail composes sources with revisions', async () => {
    const work = { workId: '300', sourceCount: 1, availableFormats: ['text/plain'], latestRevisionAt: new Date('2024-06-01') };
    const sources = [
      {
        workId: '300',
        sourceId: 's1',
        label: 'Uploaded source',
        sourceType: 'score',
        format: 'application/xml',
        description: 'desc',
        originalFilename: 'file.xml',
        isPrimary: true,
        storage: { bucket: 'b', objectKey: 'k', sizeBytes: 1, checksum: { algorithm: 'sha256', hexDigest: '00' }, contentType: 'application/xml', lastModifiedAt: new Date() },
        validation: { status: 'passed', issues: [] },
        provenance: { ingestType: 'manual', uploadedAt: new Date(), notes: [] },
        derivatives: {},
        latestRevisionId: 'r2',
        latestRevisionAt: new Date('2024-06-01')
      }
    ];
    const revisions = [
      {
        workId: '300',
        sourceId: 's1',
        revisionId: 'r2',
        sequenceNumber: 2,
        createdAt: new Date('2024-06-01'),
        createdBy: 'system',
        rawStorage: { bucket: 'b', objectKey: 'rk', sizeBytes: 1, checksum: { algorithm: 'sha256', hexDigest: 'aa' }, contentType: 'application/octet-stream', lastModifiedAt: new Date() },
        checksum: { algorithm: 'sha256', hexDigest: 'aa' },
        validationSnapshot: { status: 'passed', issues: [] },
        derivatives: { linearizedXml: { bucket: 'b', objectKey: 'l', sizeBytes: 1, checksum: { algorithm: 'sha256', hexDigest: 'bb' }, contentType: 'text/plain', lastModifiedAt: new Date() } },
        manifest: { bucket: 'b', objectKey: 'm', sizeBytes: 1, checksum: { algorithm: 'sha256', hexDigest: 'cc' }, contentType: 'application/json', lastModifiedAt: new Date() },
        fossilArtifactId: 'abc',
        fossilParentArtifactIds: ['def']
      },
      {
        workId: '300',
        sourceId: 's1',
        revisionId: 'r1',
        sequenceNumber: 1,
        createdAt: new Date('2024-05-01'),
        createdBy: 'system',
        rawStorage: { bucket: 'b', objectKey: 'rk1', sizeBytes: 1, checksum: { algorithm: 'sha256', hexDigest: '11' }, contentType: 'application/octet-stream', lastModifiedAt: new Date() },
        checksum: { algorithm: 'sha256', hexDigest: '11' },
        validationSnapshot: { status: 'passed', issues: [] },
        derivatives: {},
        fossilArtifactId: 'def',
        fossilParentArtifactIds: []
      }
    ];

    (workModel.findOne as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(work as any) }) });
    (sourceModel.find as jest.Mock).mockReturnValue(chain(sources as any));
    (sourceRevisionModel.find as jest.Mock).mockReturnValue(chain(revisions as any));

    const detail = await service.getWorkDetail('300');
    expect(detail.workId).toBe('300');
    expect(detail.sources).toHaveLength(1);
    const s = detail.sources[0];
    expect(s.sourceId).toBe('s1');
    expect(s.revisions).toHaveLength(2);
    expect(s.revisions[0]).toMatchObject({ revisionId: 'r2', sequenceNumber: 2 });
  });

  it('getWorkDetail filters revisions for viewer', async () => {
    const work = { workId: '300', sourceCount: 1, availableFormats: ['text/plain'], latestRevisionAt: new Date('2024-06-01') };
    const sources = [{ workId: '300', sourceId: 's1' }];
    const revisions = [
      { workId: '300', sourceId: 's1', revisionId: 'r1', status: 'approved' },
      { workId: '300', sourceId: 's1', revisionId: 'r2', status: 'pending', createdBy: 'user-1', approval: { ownerUserId: 'user-1' } },
      { workId: '300', sourceId: 's1', revisionId: 'r3', status: 'pending', approval: { ownerUserId: 'user-2' } },
    ];
    (workModel.findOne as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(work) }) });
    (sourceModel.find as jest.Mock).mockReturnValue(chain(sources as any));
    (sourceRevisionModel.find as jest.Mock).mockReturnValue(chain(revisions as any));

    const detail = await service.getWorkDetail('300', { userId: 'user-1' });
    expect(detail.sources[0].revisions).toHaveLength(2);
  });

  describe('updateSource', () => {
    it('should update source label and description', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const updates = { label: 'Piano Score', description: 'Full piano arrangement' };
      const updatedSource = { workId, sourceId, label: 'Piano Score', description: 'Full piano arrangement' };

      sourceModel.findOneAndUpdate = jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(updatedSource)
        })
      });

      const result = await service.updateSource(workId, sourceId, updates);

      expect(sourceModel.findOneAndUpdate).toHaveBeenCalledWith(
        { workId, sourceId },
        { $set: { label: 'Piano Score', description: 'Full piano arrangement' } },
        { new: true }
      );
      expect(result).toEqual({ ok: true });
    });

    it('should handle empty strings as undefined', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const updates = { label: '  ', description: '' };
      const updatedSource = { workId, sourceId, label: undefined, description: undefined };

      sourceModel.findOneAndUpdate = jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(updatedSource)
        })
      });

      const result = await service.updateSource(workId, sourceId, updates);

      expect(sourceModel.findOneAndUpdate).toHaveBeenCalledWith(
        { workId, sourceId },
        { $set: { label: undefined, description: undefined } },
        { new: true }
      );
      expect(result).toEqual({ ok: true });
    });

    it('should throw NotFoundException if source not found', async () => {
      const workId = 'work-1';
      const sourceId = 'nonexistent';
      const updates = { label: 'Test' };

      sourceModel.findOneAndUpdate = jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(null)
        })
      });

      await expect(service.updateSource(workId, sourceId, updates)).rejects.toThrow('Source nonexistent not found in work work-1');
    });

    it('should update only label when description not provided', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const updates = { label: 'Vocal Parts' };
      const updatedSource = { workId, sourceId, label: 'Vocal Parts' };

      sourceModel.findOneAndUpdate = jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(updatedSource)
        })
      });

      const result = await service.updateSource(workId, sourceId, updates);

      expect(sourceModel.findOneAndUpdate).toHaveBeenCalledWith(
        { workId, sourceId },
        { $set: { label: 'Vocal Parts' } },
        { new: true }
      );
      expect(result).toEqual({ ok: true });
    });
  });
});
