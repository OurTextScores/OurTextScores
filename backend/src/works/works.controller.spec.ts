jest.mock('uuid', () => ({ v4: () => '00000000-0000-0000-0000-000000000000' }));
import { WorksController } from './works.controller';
import { StorageService } from '../storage/storage.service';
import { WorksService } from './works.service';
import { FossilService } from '../fossil/fossil.service';
import { UploadSourceService } from './upload-source.service';
import { ProgressService } from '../progress/progress.service';
import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { AdminRequiredGuard } from '../auth/guards/admin-required.guard';

function createMockResponse() {
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    send: jest.fn()
  };
  return { res, headers };
}

describe('WorksController (unit)', () => {
  const worksService = {
    getWorkDetail: jest.fn(),
    ensureWorkWithMetadata: jest.fn(),
    saveWorkByImslpUrl: jest.fn(),
    updateWorkMetadata: jest.fn(),
    updateSource: jest.fn(),
    getRevisionContent: jest.fn(),
    approveRevision: jest.fn(),
    rejectRevision: jest.fn(),
    prunePendingSources: jest.fn(),
    deleteAllSources: jest.fn(),
    deleteSource: jest.fn(),
    textDiffOnDemand: jest.fn(),
  } as any as jest.Mocked<WorksService>;
  const uploadSourceService = {
    upload: jest.fn(),
    uploadRevision: jest.fn(),
  } as any as jest.Mocked<UploadSourceService>;
  const storageService = { getObjectBuffer: jest.fn() } as any as jest.Mocked<StorageService>;
  const fossilService = {} as any as jest.Mocked<FossilService>;
  const progressService = {
    stream: jest.fn(),
  } as any as jest.Mocked<ProgressService>;

  const controller = new WorksController(worksService, uploadSourceService, storageService, fossilService, progressService);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('ensureWork', () => {
    it('should create a work from a workId', async () => {
      const workId = '12345';
      const work = { workId: '123' };
      const metadata = { title: 'Symphony No.5, Op.67' };
      worksService.ensureWorkWithMetadata.mockResolvedValue({ work, metadata } as any);

      const result = await controller.ensureWork(workId);

      expect(worksService.ensureWorkWithMetadata).toHaveBeenCalledWith(workId);
      expect(result).toEqual({ work, metadata });
    });
  });

  describe('findOne', () => {
    it('should return a work', async () => {
      const work = { workId: '123' };
      worksService.getWorkDetail.mockResolvedValue(work as any);

      const result = await controller.findOne('123');

      expect(worksService.getWorkDetail).toHaveBeenCalledWith('123', undefined);
      expect(result).toEqual(work);
    });

    it('should throw not found if work does not exist', async () => {
      worksService.getWorkDetail.mockRejectedValue(new Error('not found'));

      await expect(controller.findOne('123')).rejects.toThrow('not found');
    });
  });

  describe('updateMetadata', () => {
    it('should update a work', async () => {
      const work = { workId: '123', title: 'New Title' };
      worksService.updateWorkMetadata.mockResolvedValue(work as any);

      const result = await controller.updateMetadata('123', 'New Title');

      expect(worksService.updateWorkMetadata).toHaveBeenCalledWith('123', { title: 'New Title' });
      expect(result).toEqual(work);
    });

    it('should require auth and admin guards', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, WorksController.prototype.updateMetadata);
      expect(guards).toEqual(expect.arrayContaining([AuthRequiredGuard, AdminRequiredGuard]));
      expect(guards).toHaveLength(2);
    });
  });

  describe('prunePending', () => {
    it('should prune pending sources', async () => {
      const workId = '123';
      worksService.prunePendingSources.mockResolvedValue({ removed: 1 });

      const result = await controller.prunePending(workId);

      expect(worksService.prunePendingSources).toHaveBeenCalledWith(workId);
      expect(result).toEqual({ removed: 1 });
    });
  });

  describe('deleteAll', () => {
    it('should delete all sources', async () => {
      const workId = '123';
      worksService.deleteAllSources.mockResolvedValue({ removed: 2 });

      const result = await controller.deleteAll(workId);

      expect(worksService.deleteAllSources).toHaveBeenCalledWith(workId);
      expect(result).toEqual({ removed: 2 });
    });
  });

  describe('deleteSource', () => {
    it('should delete a source', async () => {
      const workId = '123';
      const sourceId = 's1';
      worksService.deleteSource.mockResolvedValue({ removed: true });

      const user = { userId: 'user-1', roles: ['admin'] };
      const result = await controller.deleteSource(workId, sourceId, user as any);

      expect(worksService.deleteSource).toHaveBeenCalledWith(workId, sourceId, { userId: user.userId, roles: user.roles });
      expect(result).toEqual({ removed: true });
    });
  });

  it('downloadNormalized sets headers and returns buffer', async () => {
    worksService.getWorkDetail.mockResolvedValue({
      workId: '1',
      sourceCount: 1,
      availableFormats: [],
      sources: [
        {
          sourceId: 's',
          label: 'Uploaded source',
          sourceType: 'score',
          format: 'application/xml',
          isPrimary: true,
          originalFilename: 'file.mscz',
          storage: { bucket: 'raw', objectKey: 'rawk', sizeBytes: 1, checksum: { algorithm: 'sha256', hexDigest: 'r' }, contentType: 'application/octet-stream', lastModifiedAt: new Date() },
          validation: { status: 'passed', issues: [] },
          provenance: { ingestType: 'manual', uploadedAt: new Date(), notes: [] },
          revisions: [],
          derivatives: { normalizedMxl: { bucket: 'b', objectKey: 'k', sizeBytes: 1, checksum: { algorithm: 'sha256', hexDigest: 'x' }, contentType: 'application/vnd.recordare.musicxml', lastModifiedAt: new Date() } }
        }
      ]
    });
    storageService.getObjectBuffer.mockResolvedValue(Buffer.from('data'));
    const { res, headers } = createMockResponse();
    await controller.downloadNormalized('1', 's', undefined, res as any, undefined);
    expect(headers['Content-Type']).toMatch('application/vnd.recordare.musicxml');
    expect(headers['Content-Disposition']).toMatch('attachment; filename=');
    expect(headers['Cache-Control']).toBe('no-cache');
    expect(res.send).toHaveBeenCalled();
  });

  it('download throws not found if derivative is not available', async () => {
    worksService.getWorkDetail.mockResolvedValue({
      workId: '1',
      sourceCount: 1,
      availableFormats: [],
      sources: [
        {
          sourceId: 's',
          label: 'Uploaded source',
          sourceType: 'score',
          format: 'application/xml',
          isPrimary: true,
          originalFilename: 'file.mscz',
          storage: { bucket: 'raw', objectKey: 'rawk', sizeBytes: 1, checksum: { algorithm: 'sha256', hexDigest: 'r' }, contentType: 'application/octet-stream', lastModifiedAt: new Date() },
          validation: { status: 'passed', issues: [] },
          provenance: { ingestType: 'manual', uploadedAt: new Date(), notes: [] },
          revisions: [],
          derivatives: {}
        }
      ]
    });
    const { res } = createMockResponse();
    await expect(controller.downloadNormalized('1', 's', undefined, res as any, undefined)).rejects.toThrow('Normalized MXL not found for this source');
  });

  describe('uploadSource', () => {
    it('should upload a source', async () => {
      const workId = '123';
      const body = { isPrimary: true };
      const file = { buffer: Buffer.from('file data') } as Express.Multer.File;
      const progressId = 'progress-123';
      const user = { userId: 'user-1' };
      uploadSourceService.upload.mockResolvedValue({} as any);

      await controller.uploadSource(workId, body, { file: [file] }, progressId, user as any);

      expect(uploadSourceService.upload).toHaveBeenCalledWith(workId, { ...body, formatHint: undefined, isPrimary: true }, file, undefined, progressId, user);
    });
  });

  describe('uploadRevision', () => {
    it('should upload a revision', async () => {
      const workId = '123';
      const sourceId = 's1';
      const body = { isPrimary: true };
      const file = { buffer: Buffer.from('file data') } as Express.Multer.File;
      const progressId = 'progress-123';
      const user = { userId: 'user-1' };
      uploadSourceService.uploadRevision.mockResolvedValue({} as any);

      await controller.uploadRevision(workId, sourceId, body, { file: [file] }, progressId, user as any);

      expect(uploadSourceService.uploadRevision).toHaveBeenCalledWith(workId, sourceId, { ...body, formatHint: undefined, createBranch: undefined, branchName: undefined, isPrimary: true }, file, undefined, progressId, user);
    });
  });

  describe('approveRevision', () => {
    it('should approve a revision', async () => {
      const workId = '123';
      const sourceId = 's1';
      const revisionId = 'r1';
      const user = { userId: 'user-1', roles: ['admin'] };
      worksService.approveRevision.mockResolvedValue({ status: 'approved' });

      const result = await controller.approveRevision(workId, sourceId, revisionId, user as any);

      expect(worksService.approveRevision).toHaveBeenCalledWith(workId, sourceId, revisionId, { userId: user.userId, roles: user.roles });
      expect(result).toEqual({ status: 'approved' });
    });
  });

  describe('rejectRevision', () => {
    it('should reject a revision', async () => {
      const workId = '123';
      const sourceId = 's1';
      const revisionId = 'r1';
      const user = { userId: 'user-1', roles: ['admin'] };
      worksService.rejectRevision.mockResolvedValue({ status: 'rejected' });

      const result = await controller.rejectRevision(workId, sourceId, revisionId, user as any);

      expect(worksService.rejectRevision).toHaveBeenCalledWith(workId, sourceId, revisionId, { userId: user.userId, roles: user.roles });
      expect(result).toEqual({ status: 'rejected' });
    });
  });

  describe('progress', () => {
    it('should return a progress stream', () => {
      const progressId = 'progress-123';
      const stream = {} as any;
      progressService.stream.mockReturnValue(stream);

      const result = controller.progress(progressId);

      expect(progressService.stream).toHaveBeenCalledWith(progressId);
      expect(result).toEqual(stream);
    });
  });

  describe('findAll', () => {
    beforeEach(() => {
      worksService.findAll = jest.fn();
    });

    it('should return paginated works with default params', async () => {
      const mockResponse = { works: [], total: 0, limit: 20, offset: 0 };
      (worksService.findAll as jest.Mock).mockResolvedValue(mockResponse);

      const result = await controller.findAll(undefined, undefined);

      expect(worksService.findAll).toHaveBeenCalledWith({ limit: 20, offset: 0, filter: undefined, onlyWithSources: false });
      expect(result).toEqual(mockResponse);
    });

    it('should parse limit and offset from query params', async () => {
      const mockResponse = { works: [], total: 100, limit: 50, offset: 10 };
      (worksService.findAll as jest.Mock).mockResolvedValue(mockResponse);

      const result = await controller.findAll('50', '10');

      expect(worksService.findAll).toHaveBeenCalledWith({ limit: 50, offset: 10, filter: undefined, onlyWithSources: false });
      expect(result).toEqual(mockResponse);
    });

    it('should cap limit at 100', async () => {
      (worksService.findAll as jest.Mock).mockResolvedValue({} as any);

      await controller.findAll('500', '0');

      expect(worksService.findAll).toHaveBeenCalledWith({ limit: 100, offset: 0, filter: undefined, onlyWithSources: false });
    });

    it('should ensure offset is not negative', async () => {
      (worksService.findAll as jest.Mock).mockResolvedValue({} as any);

      await controller.findAll('20', '-5');

      expect(worksService.findAll).toHaveBeenCalledWith({ limit: 20, offset: 0, filter: undefined, onlyWithSources: false });
    });
  });

  describe('ensureWork input validation', () => {
    it('should throw BadRequestException for missing workId', async () => {
      try {
        await controller.ensureWork('');
        fail('Should have thrown BadRequestException');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toContain('workId is required');
      }
    });

    it('should throw BadRequestException for whitespace-only workId', async () => {
      try {
        await controller.ensureWork('   ');
        fail('Should have thrown BadRequestException');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toContain('workId is required');
      }
    });

    it('should throw BadRequestException for non-numeric workId', async () => {
      try {
        await controller.ensureWork('abc123');
        fail('Should have thrown BadRequestException');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toContain('workId must be the numeric IMSLP page_id');
      }
    });

    it('should throw BadRequestException for workId with letters', async () => {
      try {
        await controller.ensureWork('123abc');
        fail('Should have thrown BadRequestException');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toContain('workId must be the numeric IMSLP page_id');
      }
    });

    it('should accept numeric workId', async () => {
      worksService.ensureWorkWithMetadata.mockResolvedValue({ work: {}, metadata: {} } as any);

      await controller.ensureWork('12345');

      expect(worksService.ensureWorkWithMetadata).toHaveBeenCalledWith('12345');
    });

    it('should trim workId before validation', async () => {
      worksService.ensureWorkWithMetadata.mockResolvedValue({ work: {}, metadata: {} } as any);

      await controller.ensureWork('  12345  ');

      expect(worksService.ensureWorkWithMetadata).toHaveBeenCalledWith('12345');
    });
  });

  describe('saveWorkByUrl', () => {
    beforeEach(() => {
      worksService.saveWorkByImslpUrl = jest.fn();
    });

    it('should throw BadRequestException for missing URL', async () => {
      try {
        await controller.saveWorkByUrl('');
        fail('Should have thrown BadRequestException');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toContain('url is required');
      }
    });

    it('should throw BadRequestException for whitespace-only URL', async () => {
      try {
        await controller.saveWorkByUrl('   ');
        fail('Should have thrown BadRequestException');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toContain('url is required');
      }
    });

    it('should trim and save valid URL', async () => {
      worksService.saveWorkByImslpUrl.mockResolvedValue({ work: {}, metadata: {} } as any);

      await controller.saveWorkByUrl('  https://example.com  ');

      expect(worksService.saveWorkByImslpUrl).toHaveBeenCalledWith('https://example.com');
    });
  });

  describe('findOne with user', () => {
    it('should pass user info to service when user is authenticated', async () => {
      const work = { workId: '123' };
      const user = { userId: 'user-1', roles: ['user'] };
      worksService.getWorkDetail.mockResolvedValue(work as any);

      const result = await controller.findOne('123', user as any);

      expect(worksService.getWorkDetail).toHaveBeenCalledWith('123', { userId: 'user-1', roles: ['user'] });
      expect(result).toEqual(work);
    });

    it('should pass undefined viewer when no user', async () => {
      const work = { workId: '123' };
      worksService.getWorkDetail.mockResolvedValue(work as any);

      const result = await controller.findOne('123', undefined);

      expect(worksService.getWorkDetail).toHaveBeenCalledWith('123', undefined);
      expect(result).toEqual(work);
    });
  });

  describe('updateMetadata with all fields', () => {
    it('should update title, composer, and catalogNumber', async () => {
      const work = { workId: '123', title: 'New Title', composer: 'New Composer', catalogNumber: 'Op. 1' };
      worksService.updateWorkMetadata.mockResolvedValue(work as any);

      const result = await controller.updateMetadata('123', 'New Title', 'New Composer', 'Op. 1');

      expect(worksService.updateWorkMetadata).toHaveBeenCalledWith('123', {
        title: 'New Title',
        composer: 'New Composer',
        catalogNumber: 'Op. 1'
      });
      expect(result).toEqual(work);
    });

    it('should handle partial updates', async () => {
      const work = { workId: '123', title: 'New Title' };
      worksService.updateWorkMetadata.mockResolvedValue(work as any);

      await controller.updateMetadata('123', 'New Title', undefined, undefined);

      expect(worksService.updateWorkMetadata).toHaveBeenCalledWith('123', {
        title: 'New Title',
        composer: undefined,
        catalogNumber: undefined
      });
    });
  });

  describe('downloadCanonical', () => {
    it('should download canonical XML and set headers', async () => {
      worksService.getWorkDetail.mockResolvedValue({
        workId: '1',
        sources: [{
          sourceId: 's',
          originalFilename: 'score.mscz',
          derivatives: {
            canonicalXml: {
              bucket: 'b',
              objectKey: 'k',
              sizeBytes: 100,
              checksum: { algorithm: 'sha256', hexDigest: 'x' },
              contentType: 'application/xml',
              lastModifiedAt: new Date()
            }
          }
        }]
      } as any);
      storageService.getObjectBuffer.mockResolvedValue(Buffer.from('<score/>'));
      const { res, headers } = createMockResponse();

      await controller.downloadCanonical('1', 's', undefined, res as any, undefined);

      expect(headers['Content-Type']).toContain('application/xml');
      expect(headers['Content-Disposition']).toContain('score.xml');
      expect(headers['Cache-Control']).toBe('no-cache');
      expect(res.send).toHaveBeenCalled();
    });

    it('should throw not found when canonical XML is missing', async () => {
      worksService.getWorkDetail.mockResolvedValue({
        workId: '1',
        sources: [{ sourceId: 's', derivatives: {} }]
      } as any);
      const { res } = createMockResponse();

      await expect(controller.downloadCanonical('1', 's', undefined, res as any, undefined))
        .rejects.toThrow('Canonical XML not found for this source');
    });
  });

  describe('downloadPdf', () => {
    it('should download PDF and set inline disposition', async () => {
      worksService.getWorkDetail.mockResolvedValue({
        workId: '1',
        sources: [{
          sourceId: 's',
          originalFilename: 'score.mscz',
          derivatives: {
            pdf: {
              bucket: 'b',
              objectKey: 'k',
              sizeBytes: 100,
              checksum: { algorithm: 'sha256', hexDigest: 'x' },
              contentType: 'application/pdf',
              lastModifiedAt: new Date()
            }
          }
        }]
      } as any);
      storageService.getObjectBuffer.mockResolvedValue(Buffer.from('pdf'));
      const { res, headers } = createMockResponse();

      await controller.downloadPdf('1', 's', undefined, res as any, undefined);

      expect(headers['Content-Type']).toContain('application/pdf');
      expect(headers['Content-Disposition']).toContain('inline');
      expect(headers['Content-Disposition']).toContain('score.pdf');
      expect(headers['Cache-Control']).toBe('no-cache');
      expect(res.send).toHaveBeenCalled();
    });

    it('should throw not found when PDF is missing', async () => {
      worksService.getWorkDetail.mockResolvedValue({
        workId: '1',
        sources: [{ sourceId: 's', derivatives: {} }]
      } as any);
      const { res } = createMockResponse();

      await expect(controller.downloadPdf('1', 's', undefined, res as any, undefined))
        .rejects.toThrow('PDF not found for this source');
    });
  });

  describe('downloadMscz', () => {
    it('should download MSCZ file and set attachment disposition', async () => {
      worksService.getWorkDetail.mockResolvedValue({
        workId: '1',
        sources: [{
          sourceId: 's',
          originalFilename: 'my-composition.mscz',
          derivatives: {
            mscz: {
              bucket: 'b',
              objectKey: 'k',
              sizeBytes: 5000,
              checksum: { algorithm: 'sha256', hexDigest: 'x' },
              contentType: 'application/vnd.musescore.mscz',
              lastModifiedAt: new Date()
            }
          }
        }]
      } as any);
      storageService.getObjectBuffer.mockResolvedValue(Buffer.from('mscz-data'));
      const { res, headers } = createMockResponse();

      await controller.downloadMscz('1', 's', undefined, res as any, undefined);

      expect(headers['Content-Type']).toContain('application/vnd.musescore.mscz');
      expect(headers['Content-Disposition']).toContain('attachment');
      expect(headers['Content-Disposition']).toContain('my-composition.mscz');
      expect(headers['Cache-Control']).toBe('no-cache');
      expect(res.send).toHaveBeenCalled();
    });

    it('should throw not found when MSCZ is missing', async () => {
      worksService.getWorkDetail.mockResolvedValue({
        workId: '1',
        sources: [{ sourceId: 's', derivatives: {} }]
      } as any);
      const { res } = createMockResponse();

      await expect(controller.downloadMscz('1', 's', undefined, res as any, undefined))
        .rejects.toThrow('MuseScore file not found for this source');
    });

    it('should download MSCZ for a specific revision when revisionId is provided', async () => {
      worksService.getWorkDetail.mockResolvedValue({
        workId: '1',
        sources: [{
          sourceId: 's',
          originalFilename: 'score.mscz',
          revisions: [{
            revisionId: 'rev-123',
            derivatives: {
              mscz: {
                bucket: 'b',
                objectKey: 'k-rev',
                sizeBytes: 4500,
                checksum: { algorithm: 'sha256', hexDigest: 'y' },
                contentType: 'application/vnd.musescore.mscz',
                lastModifiedAt: new Date()
              }
            }
          }]
        }]
      } as any);
      storageService.getObjectBuffer.mockResolvedValue(Buffer.from('mscz-rev-data'));
      const { res, headers } = createMockResponse();

      await controller.downloadMscz('1', 's', 'rev-123', res as any, undefined);

      expect(storageService.getObjectBuffer).toHaveBeenCalledWith('b', 'k-rev');
      expect(headers['Content-Disposition']).toContain('attachment');
      expect(headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
      expect(res.send).toHaveBeenCalled();
    });
  });

  describe('downloadManifest', () => {
    it('should download manifest JSON', async () => {
      worksService.getWorkDetail.mockResolvedValue({
        workId: '1',
        sources: [{
          sourceId: 's',
          derivatives: {
            manifest: {
              bucket: 'b',
              objectKey: 'k',
              sizeBytes: 100,
              checksum: { algorithm: 'sha256', hexDigest: 'x' },
              contentType: 'application/json',
              lastModifiedAt: new Date()
            }
          }
        }]
      } as any);
      storageService.getObjectBuffer.mockResolvedValue(Buffer.from('{}'));
      const { res, headers } = createMockResponse();

      await controller.downloadManifest('1', 's', undefined, res as any, undefined);

      expect(headers['Content-Type']).toContain('application/json');
      expect(headers['Content-Disposition']).toContain('manifest.json');
      expect(headers['Cache-Control']).toBe('no-cache');
      expect(res.send).toHaveBeenCalled();
    });

    it('should throw not found when manifest is missing', async () => {
      worksService.getWorkDetail.mockResolvedValue({
        workId: '1',
        sources: [{ sourceId: 's', derivatives: {} }]
      } as any);
      const { res } = createMockResponse();

      await expect(controller.downloadManifest('1', 's', undefined, res as any, undefined))
        .rejects.toThrow('Manifest not found for this source');
    });
  });

  describe('toBoolean helper', () => {
    it('should return true for boolean true', () => {
      expect((controller as any).toBoolean(true)).toBe(true);
    });

    it('should return false for boolean false', () => {
      expect((controller as any).toBoolean(false)).toBe(false);
    });

    it('should return true for string "true"', () => {
      expect((controller as any).toBoolean('true')).toBe(true);
    });

    it('should return false for string "false"', () => {
      expect((controller as any).toBoolean('false')).toBe(false);
    });

    it('should return true for uppercase "TRUE"', () => {
      expect((controller as any).toBoolean('TRUE')).toBe(true);
    });

    it('should return false for uppercase "FALSE"', () => {
      expect((controller as any).toBoolean('FALSE')).toBe(false);
    });

    it('should return true for string with whitespace "  true  "', () => {
      expect((controller as any).toBoolean('  true  ')).toBe(true);
    });

    it('should return undefined for invalid string', () => {
      expect((controller as any).toBoolean('yes')).toBeUndefined();
    });

    it('should return undefined for number', () => {
      expect((controller as any).toBoolean(1)).toBeUndefined();
    });

    it('should return undefined for null', () => {
      expect((controller as any).toBoolean(null)).toBeUndefined();
    });

    it('should return undefined for undefined', () => {
      expect((controller as any).toBoolean(undefined)).toBeUndefined();
    });
  });

  describe('updateSource', () => {
    it('should update source label and description', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const label = 'Piano Score';
      const description = 'Full piano arrangement';
      const user = { userId: 'owner-1', roles: ['user'] };

      worksService.updateSource.mockResolvedValue({ ok: true });

      const result = await controller.updateSource(workId, sourceId, label, description, user as any);

      expect(worksService.updateSource).toHaveBeenCalledWith(workId, sourceId, {
        label,
        description
      }, {
        userId: user.userId,
        roles: user.roles
      });
      expect(result).toEqual({ ok: true });
    });

    it('should update only label when description not provided', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const label = 'Vocal Parts';
      const user = { userId: 'owner-1', roles: ['user'] };

      worksService.updateSource.mockResolvedValue({ ok: true });

      const result = await controller.updateSource(workId, sourceId, label, undefined, user as any);

      expect(worksService.updateSource).toHaveBeenCalledWith(workId, sourceId, {
        label,
        description: undefined
      }, {
        userId: user.userId,
        roles: user.roles
      });
      expect(result).toEqual({ ok: true });
    });

    it('should update only description when label not provided', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const description = 'Updated description';
      const user = { userId: 'owner-1', roles: ['user'] };

      worksService.updateSource.mockResolvedValue({ ok: true });

      const result = await controller.updateSource(workId, sourceId, undefined, description, user as any);

      expect(worksService.updateSource).toHaveBeenCalledWith(workId, sourceId, {
        label: undefined,
        description
      }, {
        userId: user.userId,
        roles: user.roles
      });
      expect(result).toEqual({ ok: true });
    });

    it('should handle empty updates', async () => {
      const workId = 'work-1';
      const sourceId = 'source-1';
      const user = { userId: 'owner-1', roles: ['user'] };

      worksService.updateSource.mockResolvedValue({ ok: true });

      const result = await controller.updateSource(workId, sourceId, undefined, undefined, user as any);

      expect(worksService.updateSource).toHaveBeenCalledWith(workId, sourceId, {
        label: undefined,
        description: undefined
      }, {
        userId: user.userId,
        roles: user.roles
      });
      expect(result).toEqual({ ok: true });
    });
  });
});
