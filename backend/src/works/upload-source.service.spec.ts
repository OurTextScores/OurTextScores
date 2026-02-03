jest.mock('uuid', () => ({ v4: () => '00000000-0000-0000-0000-000000000000' }));
import { BadRequestException } from '@nestjs/common';
import { UploadSourceService } from './upload-source.service';
import { WorksService } from './works.service';
import { DerivativePipelineService } from './derivative-pipeline.service';
import { FossilService } from '../fossil/fossil.service';
import { ProgressService } from '../progress/progress.service';
import { BranchesService } from '../branches/branches.service';
import { NotificationsService } from '../notifications/notifications.service';
import { createHash } from 'node:crypto';

describe('UploadSourceService (unit)', () => {
  let service: UploadSourceService;
  const worksService = {
    ensureWork: jest.fn(),
    recordSourceUpload: jest.fn(),
    recordSourceRevision: jest.fn(),
    recomputeWorkStats: jest.fn()
  } as unknown as jest.Mocked<WorksService>;

  const storageService = {
    putRawObject: jest.fn(),
    putDerivativeObject: jest.fn(),
    putAuxiliaryObject: jest.fn(),
    getObjectBuffer: jest.fn()
  } as any;

  const derivativePipeline = {
    process: jest.fn()
  } as unknown as jest.Mocked<DerivativePipelineService>;

  const fossilService = {
    commitRevision: jest.fn()
  } as unknown as jest.Mocked<FossilService>;

  const progress = new ProgressService();

  const sourceModel = {
    create: jest.fn(),
    updateOne: jest.fn(),
    findOne: jest.fn()
  } as any;
  const sourceRevisionModel = {
    create: jest.fn(),
    updateOne: jest.fn(),
    findOne: jest.fn()
  } as any;

  const branchesService = {
    getBranchPolicy: jest.fn().mockResolvedValue('public'),
    ensureDefaultTrunk: jest.fn().mockResolvedValue(undefined)
  } as unknown as jest.Mocked<BranchesService>;

  const notifications = {
    queuePushRequest: jest.fn()
  } as unknown as jest.Mocked<NotificationsService>;

  const imslpService = {
    getRawByWorkId: jest.fn()
  } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new UploadSourceService(
      worksService,
      storageService,
      derivativePipeline,
      fossilService,
      progress,
      branchesService,
      notifications,
      imslpService,
      sourceModel,
      sourceRevisionModel
    );
  });

  it('upload() creates a new source, runs pipeline, and commits to Fossil', async () => {
    worksService.ensureWork = jest.fn().mockResolvedValue({ workId: '10', sourceCount: 0, availableFormats: [] });
    // chainable findOne().sort().lean() for previousRevision
    sourceRevisionModel.findOne.mockReturnValue({ sort: () => ({ lean: () => ({}) }) });
    storageService.putRawObject.mockResolvedValue({ bucket: 'raw', objectKey: '10/s1/raw/file.xml', etag: 'e' });
    const derivLoc = (path: string, type: string) => ({ bucket: 'der', objectKey: path, sizeBytes: type === 'pdf' ? 5 : 3, checksum: { algorithm: 'sha256', hexDigest: 'x' }, contentType: type === 'pdf' ? 'application/pdf' : 'application/xml', lastModifiedAt: new Date() });
    derivativePipeline.process = jest.fn().mockResolvedValue({
      pending: false,
      notes: ['ok'],
      manifest: derivLoc('10/s1/rev-0001/manifest.json', 'json'),
      manifestData: { version: 1, generatedAt: new Date().toISOString(), workId: '10', sourceId: 's1', sequenceNumber: 1, tooling: { musescore3: 'v' }, notes: [], pending: false, artifacts: [] },
      derivatives: {
        canonicalXml: derivLoc('10/s1/rev-0001/canonical.xml', 'xml'),
        normalizedMxl: { bucket: 'der', objectKey: '10/s1/rev-0001/normalized.mxl', sizeBytes: 4, checksum: { algorithm: 'sha256', hexDigest: 'x' }, contentType: 'application/vnd.recordare.musicxml', lastModifiedAt: new Date() },
        pdf: derivLoc('10/s1/rev-0001/score.pdf', 'pdf')
      }
    });
    storageService.getObjectBuffer.mockResolvedValue(Buffer.from('content'));
    fossilService.commitRevision = jest.fn().mockResolvedValue({ artifactId: 'abc', repositoryPath: '/repo', branchName: 'trunk' });

    const file = { originalname: 'file.xml', mimetype: 'application/xml', size: 12, buffer: Buffer.from('<xml/>') } as any;
    const res = await service.upload('10', { label: 'Uploaded source' }, file, undefined, 'pid');

    expect(res.status).toBe('accepted');
    expect(derivativePipeline.process).toHaveBeenCalled();
    expect(sourceModel.create).toHaveBeenCalled();
    expect(sourceRevisionModel.create).toHaveBeenCalled();
    expect(worksService.recordSourceUpload).toHaveBeenCalledWith('10', expect.arrayContaining(['application/xml', 'application/vnd.recordare.musicxml']), expect.any(Date));
    expect(fossilService.commitRevision).toHaveBeenCalled();
  });

  it('uploadRevision() updates an existing source and records revision', async () => {
    sourceModel.findOne.mockReturnValue({ lean: () => ({}) });
    sourceRevisionModel.findOne.mockReturnValue({ sort: () => ({ lean: () => ({}) }) });
    storageService.putRawObject.mockResolvedValue({ bucket: 'raw', objectKey: '10/x/raw/file.xml', etag: 'e' });
    derivativePipeline.process = jest.fn().mockResolvedValue({ pending: false, notes: [], derivatives: { canonicalXml: { bucket: 'der', objectKey: 'c', sizeBytes: 1, checksum: { algorithm: 'sha256', hexDigest: 'aa' }, contentType: 'application/xml', lastModifiedAt: new Date() } }, manifest: { bucket: 'der', objectKey: 'm', sizeBytes: 1, checksum: { algorithm: 'sha256', hexDigest: 'cc' }, contentType: 'application/json', lastModifiedAt: new Date() } });
    fossilService.commitRevision = jest.fn().mockResolvedValue({ artifactId: 'xyz', repositoryPath: '/repo', branchName: 'feature' });
    storageService.getObjectBuffer.mockResolvedValue(Buffer.from('x'));

    const file = { originalname: 'file.xml', mimetype: 'application/xml', size: 12, buffer: Buffer.from('<xml/>') } as any;
    const res = await service.uploadRevision('10', 'x', {}, file, undefined, 'pid');
    expect(res.status).toBe('accepted');
    expect(sourceRevisionModel.create).toHaveBeenCalled();
    expect(sourceModel.updateOne).toHaveBeenCalled();
    expect(worksService.recordSourceRevision).toHaveBeenCalled();
  });

  it('uploadReferencePdf() stores reference PDF for latest revision when owner', async () => {
    const buffer = Buffer.from('pdf-content');
    const sha1 = createHash('sha1').update(buffer).digest('hex');
    const sourceDoc = {
      workId: '10',
      sourceId: 's1',
      hasReferencePdf: false,
      derivatives: {},
      provenance: { uploadedByUserId: 'owner-1' },
      latestRevisionId: 'r1'
    };
    sourceModel.findOne.mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(sourceDoc) })
    });
    sourceRevisionModel.findOne.mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve({ revisionId: 'r1', sequenceNumber: 2 }) })
    });
    sourceRevisionModel.updateOne.mockReturnValue({ exec: () => Promise.resolve() });
    sourceModel.updateOne.mockReturnValue({ exec: () => Promise.resolve() });
    storageService.putAuxiliaryObject.mockResolvedValue({ bucket: 'aux', objectKey: '10/s1/rev-0002/reference.pdf' });
    imslpService.getRawByWorkId.mockResolvedValue({
      metadata: {
        files: [
          { name: 'score.pdf', sha1, size: 123, mime_type: 'application/pdf', title: 'Score', url: 'u', timestamp: 't', user: 'u' }
        ]
      }
    });

    const file = { originalname: 'ref.pdf', mimetype: 'application/pdf', size: buffer.length, buffer } as any;
    const res = await service.uploadReferencePdf('10', 's1', file, 'pid', { userId: 'owner-1', roles: ['user'] } as any);
    expect(res.ok).toBe(true);
    expect(sourceModel.updateOne).toHaveBeenCalled();
    expect(sourceRevisionModel.updateOne).toHaveBeenCalled();
    expect((worksService as any).recomputeWorkStats).toHaveBeenCalledWith('10');
  });

  it('uploadReferencePdf() rejects non-owner non-admin', async () => {
    const sourceDoc = {
      workId: '10',
      sourceId: 's1',
      hasReferencePdf: false,
      derivatives: {},
      provenance: { uploadedByUserId: 'owner-1' },
      latestRevisionId: 'r1'
    };
    sourceModel.findOne.mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(sourceDoc) })
    });

    const file = { originalname: 'ref.pdf', mimetype: 'application/pdf', size: 10, buffer: Buffer.from('x') } as any;
    await expect(
      service.uploadReferencePdf('10', 's1', file, 'pid', { userId: 'other', roles: ['user'] } as any)
    ).rejects.toThrow('Only source owner or admin can upload reference PDF');
  });

  it('upload() rejects files larger than 100MB', async () => {
    const bigSize = 100 * 1024 * 1024 + 1;
    const file = {
      originalname: 'big.mscz',
      mimetype: 'application/vnd.musescore.mscz',
      size: bigSize,
      buffer: Buffer.alloc(1)
    } as any;

    await expect(
      service.upload('10', { label: 'Large file' }, file, undefined, 'pid')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storageService.putRawObject).not.toHaveBeenCalled();
    expect(derivativePipeline.process).not.toHaveBeenCalled();
  });

  it('uploadRevision() rejects files larger than 100MB', async () => {
    const bigSize = 100 * 1024 * 1024 + 1;
    const file = {
      originalname: 'big.mscz',
      mimetype: 'application/vnd.musescore.mscz',
      size: bigSize,
      buffer: Buffer.alloc(1)
    } as any;
    sourceModel.findOne.mockReturnValue({ lean: () => ({ label: 'Existing', sourceType: 'score' }) });

    await expect(
      service.uploadRevision('10', 'source-1', {}, file, undefined, 'pid')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storageService.putRawObject).not.toHaveBeenCalled();
    expect(derivativePipeline.process).not.toHaveBeenCalled();
  });

  it('upload() fails for MuseScore files when pipeline cannot produce core derivatives', async () => {
    worksService.ensureWork = jest.fn().mockResolvedValue({ workId: '10', sourceCount: 0, availableFormats: [] });
    sourceRevisionModel.findOne.mockReturnValue({ sort: () => ({ lean: () => ({}) }) });
    storageService.putRawObject.mockResolvedValue({ bucket: 'raw', objectKey: '10/s1/raw/file.mscz', etag: 'e' });
    derivativePipeline.process = jest.fn().mockResolvedValue({
      pending: true,
      notes: ['Canonical MusicXML could not be produced.'],
      derivatives: {},
      manifest: undefined,
      manifestData: undefined
    });

    const file = {
      originalname: 'score.mscz',
      mimetype: 'application/vnd.musescore.mscz',
      size: 1234,
      buffer: Buffer.from('data')
    } as any;

    await expect(
      service.upload('10', { label: 'Uploaded MuseScore' }, file, undefined, 'pid')
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      message: expect.stringContaining('Could not process MuseScore file')
    });
    expect(sourceModel.create).not.toHaveBeenCalled();
    expect(sourceRevisionModel.create).not.toHaveBeenCalled();
  });

  it('uploadRevision() fails for MuseScore files when pipeline cannot produce core derivatives', async () => {
    sourceModel.findOne.mockReturnValue({
      lean: () => ({
        label: 'Existing source',
        sourceType: 'score',
        description: undefined,
        derivatives: undefined
      })
    });
    sourceRevisionModel.findOne.mockReturnValue({ sort: () => ({ lean: () => ({}) }) });
    storageService.putRawObject.mockResolvedValue({ bucket: 'raw', objectKey: '10/s1/raw/file.mscz', etag: 'e' });
    derivativePipeline.process = jest.fn().mockResolvedValue({
      pending: true,
      notes: ['Canonical MusicXML could not be produced.'],
      derivatives: {},
      manifest: undefined,
      manifestData: undefined
    });

    const file = {
      originalname: 'score.mscz',
      mimetype: 'application/vnd.musescore.mscz',
      size: 1234,
      buffer: Buffer.from('data')
    } as any;

    await expect(
      service.uploadRevision('10', 'source-1', {}, file, undefined, 'pid')
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      message: expect.stringContaining('Could not process MuseScore file')
    });
    expect(sourceRevisionModel.create).not.toHaveBeenCalled();
    expect(sourceModel.updateOne).not.toHaveBeenCalled();
  });

  it('upload() saves license to revision', async () => {
    worksService.ensureWork = jest.fn().mockResolvedValue({ workId: '10', sourceCount: 0, availableFormats: [] });
    sourceRevisionModel.findOne.mockReturnValue({ sort: () => ({ lean: () => ({}) }) });
    storageService.putRawObject.mockResolvedValue({ bucket: 'raw', objectKey: '10/s1/raw/file.xml', etag: 'e' });
    derivativePipeline.process = jest.fn().mockResolvedValue({ pending: false, notes: [], derivatives: {}, manifest: undefined });
    storageService.getObjectBuffer.mockResolvedValue(Buffer.from('content'));
    fossilService.commitRevision = jest.fn().mockResolvedValue({ artifactId: 'abc', repositoryPath: '/repo', branchName: 'trunk' });

    const file = { originalname: 'file.xml', mimetype: 'application/xml', size: 12, buffer: Buffer.from('<xml/>') } as any;
    const res = await service.upload('10', { label: 'Source with license', license: 'CC0', licenseUrl: 'http://cc0' }, file, undefined, 'pid');

    expect(res.status).toBe('accepted');
    expect(sourceRevisionModel.create).toHaveBeenCalledWith(expect.objectContaining({
      license: 'CC0',
      licenseUrl: 'http://cc0'
    }));
  });

  it('uploadRevision() saves license to revision', async () => {
    sourceModel.findOne.mockReturnValue({ lean: () => ({}) });
    sourceRevisionModel.findOne.mockReturnValue({ sort: () => ({ lean: () => ({}) }) });
    storageService.putRawObject.mockResolvedValue({ bucket: 'raw', objectKey: '10/x/raw/file.xml', etag: 'e' });
    derivativePipeline.process = jest.fn().mockResolvedValue({ pending: false, notes: [], derivatives: {}, manifest: undefined });
    fossilService.commitRevision = jest.fn().mockResolvedValue({ artifactId: 'xyz', repositoryPath: '/repo', branchName: 'feature' });
    storageService.getObjectBuffer.mockResolvedValue(Buffer.from('x'));

    const file = { originalname: 'file.xml', mimetype: 'application/xml', size: 12, buffer: Buffer.from('<xml/>') } as any;
    const res = await service.uploadRevision('10', 'x', { license: 'CC-BY-4.0' }, file, undefined, 'pid');

    expect(res.status).toBe('accepted');
    expect(sourceRevisionModel.create).toHaveBeenCalledWith(expect.objectContaining({
      license: 'CC-BY-4.0'
    }));
  });

  it('uploadRevision() inherits license from previous revision (via Source) if not provided', async () => {
    // Mock Source with a license (representing the state from previous revision)
    sourceModel.findOne.mockReturnValue({ lean: () => ({ license: 'CC0', licenseUrl: 'http://cc0' }) });
    sourceRevisionModel.findOne.mockReturnValue({ sort: () => ({ lean: () => ({}) }) });
    sourceRevisionModel.findOne.mockReturnValue({ sort: () => ({ lean: () => ({}) }) });

    storageService.putRawObject.mockResolvedValue({ bucket: 'raw', objectKey: '10/x/raw/file.xml', etag: 'e' });
    derivativePipeline.process = jest.fn().mockResolvedValue({ pending: false, notes: [], derivatives: {}, manifest: undefined });
    fossilService.commitRevision = jest.fn().mockResolvedValue({ artifactId: 'xyz', repositoryPath: '/repo', branchName: 'feature' });
    storageService.getObjectBuffer.mockResolvedValue(Buffer.from('x'));

    const file = { originalname: 'file.xml', mimetype: 'application/xml', size: 12, buffer: Buffer.from('<xml/>') } as any;
    // No license provided in request
    const res = await service.uploadRevision('10', 'x', {}, file, undefined, 'pid');

    expect(res.status).toBe('accepted');
    expect(sourceRevisionModel.create).toHaveBeenCalledWith(expect.objectContaining({
      license: 'CC0',
      licenseUrl: 'http://cc0'
    }));
  });

  it('validateReferencePdfAgainstImslp() accepts a matching IMSLP PDF hash', async () => {
    const buffer = Buffer.from('%PDF-1.4 test');
    const sha1 = createHash('sha1').update(buffer).digest('hex');
    imslpService.getRawByWorkId.mockResolvedValue({
      metadata: {
        files: [
          {
            name: 'PMLP0001-Test.pdf',
            title: 'File:PMLP0001-Test.pdf',
            url: 'https://imslp.org/images/abc.pdf',
            sha1,
            size: 123,
            mime_type: 'application/pdf',
            timestamp: '2024-01-01T00:00:00Z',
            user: 'Uploader'
          }
        ]
      }
    });

    const result = await (service as any).validateReferencePdfAgainstImslp({ buffer } as any, '10');

    expect(result.valid).toBe(true);
    expect(result.imslpFile.sha1).toBe(sha1);
  });

  it('validateReferencePdfAgainstImslp() rejects when IMSLP metadata is missing', async () => {
    imslpService.getRawByWorkId.mockResolvedValue(null);
    const result = await (service as any).validateReferencePdfAgainstImslp({ buffer: Buffer.from('x') } as any, '10');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('IMSLP metadata not available');
  });

  it('validateReferencePdfAgainstImslp() rejects when no IMSLP PDFs are available', async () => {
    imslpService.getRawByWorkId.mockResolvedValue({
      metadata: { files: [{ name: 'not-pdf.txt', mime_type: 'text/plain' }] }
    });
    const result = await (service as any).validateReferencePdfAgainstImslp({ buffer: Buffer.from('x') } as any, '10');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('No PDF files found');
  });
});
