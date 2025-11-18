jest.mock('uuid', () => ({ v4: () => '00000000-0000-0000-0000-000000000000' }));
import { BadRequestException } from '@nestjs/common';
import { UploadSourceService } from './upload-source.service';
import { WorksService } from './works.service';
import { DerivativePipelineService } from './derivative-pipeline.service';
import { FossilService } from '../fossil/fossil.service';
import { ProgressService } from '../progress/progress.service';
import { BranchesService } from '../branches/branches.service';
import { NotificationsService } from '../notifications/notifications.service';

describe('UploadSourceService (unit)', () => {
  let service: UploadSourceService;
  const worksService = {
    ensureWork: jest.fn(),
    recordSourceUpload: jest.fn(),
    recordSourceRevision: jest.fn()
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
      sourceModel,
      sourceRevisionModel
    );
  });

  it('upload() creates a new source, runs pipeline, and commits to Fossil', async () => {
    worksService.ensureWork = jest.fn().mockResolvedValue({ workId: '10', sourceCount: 0, availableFormats: [] });
    // chainable findOne().sort().lean() for previousRevision
    sourceRevisionModel.findOne.mockReturnValue({ sort: () => ({ lean: () => ({}) }) });
    storageService.putRawObject.mockResolvedValue({ bucket: 'raw', objectKey: '10/s1/raw/file.xml', etag: 'e' });
    const derivLoc = (path: string, type: string) => ({ bucket: 'der', objectKey: path, sizeBytes: type === 'pdf' ? 5 : 3, checksum: { algorithm: 'sha256', hexDigest: 'x' }, contentType: type === 'pdf' ? 'application/pdf' : (type === 'linearized' ? 'text/plain' : 'application/xml'), lastModifiedAt: new Date() });
    derivativePipeline.process = jest.fn().mockResolvedValue({
      pending: false,
      notes: ['ok'],
      manifest: derivLoc('10/s1/rev-0001/manifest.json', 'json'),
      manifestData: { version: 1, generatedAt: new Date().toISOString(), workId: '10', sourceId: 's1', sequenceNumber: 1, tooling: { musescore3: 'v', linearizedMusicXml: 'v', musicdiff: 'v' }, notes: [], pending: false, artifacts: [] },
      derivatives: {
        canonicalXml: derivLoc('10/s1/rev-0001/canonical.xml', 'xml'),
        linearizedXml: derivLoc('10/s1/rev-0001/linearized.lmx', 'linearized'),
        normalizedMxl: { bucket: 'der', objectKey: '10/s1/rev-0001/normalized.mxl', sizeBytes: 4, checksum: { algorithm: 'sha256', hexDigest: 'x' }, contentType: 'application/vnd.recordare.musicxml', lastModifiedAt: new Date() },
        pdf: derivLoc('10/s1/rev-0001/score.pdf', 'pdf')
      }
    });
    storageService.getObjectBuffer.mockResolvedValue(Buffer.from('content'));
    fossilService.commitRevision = jest.fn().mockResolvedValue({ artifactId: 'abc', repositoryPath: '/repo', branchName: 'trunk' });

    const file = { originalname: 'file.xml', mimetype: 'application/xml', size: 12, buffer: Buffer.from('<xml/>') } as any;
    const res = await service.upload('10', { label: 'Uploaded source' }, file, 'pid');

    expect(res.status).toBe('accepted');
    expect(derivativePipeline.process).toHaveBeenCalled();
    expect(sourceModel.create).toHaveBeenCalled();
    expect(sourceRevisionModel.create).toHaveBeenCalled();
    expect(worksService.recordSourceUpload).toHaveBeenCalledWith('10', expect.arrayContaining(['application/xml', 'text/plain', 'application/vnd.recordare.musicxml']), expect.any(Date));
    expect(fossilService.commitRevision).toHaveBeenCalled();
  });

  it('uploadRevision() updates an existing source and records revision', async () => {
    sourceModel.findOne.mockReturnValue({ lean: () => ({}) });
    sourceRevisionModel.findOne.mockReturnValue({ sort: () => ({ lean: () => ({}) }) });
    storageService.putRawObject.mockResolvedValue({ bucket: 'raw', objectKey: '10/x/raw/file.xml', etag: 'e' });
    derivativePipeline.process = jest.fn().mockResolvedValue({ pending: false, notes: [], derivatives: { canonicalXml: { bucket: 'der', objectKey: 'c', sizeBytes: 1, checksum: { algorithm: 'sha256', hexDigest: 'aa' }, contentType: 'application/xml', lastModifiedAt: new Date() }, linearizedXml: { bucket: 'der', objectKey: 'l', sizeBytes: 1, checksum: { algorithm: 'sha256', hexDigest: 'bb' }, contentType: 'text/plain', lastModifiedAt: new Date() } }, manifest: { bucket: 'der', objectKey: 'm', sizeBytes: 1, checksum: { algorithm: 'sha256', hexDigest: 'cc' }, contentType: 'application/json', lastModifiedAt: new Date() } });
    fossilService.commitRevision = jest.fn().mockResolvedValue({ artifactId: 'xyz', repositoryPath: '/repo', branchName: 'feature' });
    storageService.getObjectBuffer.mockResolvedValue(Buffer.from('x'));
    ;(service as any).generateMusicDiffAsync = jest.fn().mockResolvedValue(undefined);

    const file = { originalname: 'file.xml', mimetype: 'application/xml', size: 12, buffer: Buffer.from('<xml/>') } as any;
    const res = await service.uploadRevision('10', 'x', {}, file, 'pid');
    expect(res.status).toBe('accepted');
    expect(sourceRevisionModel.create).toHaveBeenCalled();
    expect(sourceModel.updateOne).toHaveBeenCalled();
    expect(worksService.recordSourceRevision).toHaveBeenCalled();
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
      service.upload('10', { label: 'Large file' }, file, 'pid')
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
      service.uploadRevision('10', 'source-1', {}, file, 'pid')
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
      service.upload('10', { label: 'Uploaded MuseScore' }, file, 'pid')
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
      service.uploadRevision('10', 'source-1', {}, file, 'pid')
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      message: expect.stringContaining('Could not process MuseScore file')
    });
    expect(sourceRevisionModel.create).not.toHaveBeenCalled();
    expect(sourceModel.updateOne).not.toHaveBeenCalled();
  });
});
