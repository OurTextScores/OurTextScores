jest.mock('uuid', () => ({ v4: () => '00000000-0000-0000-0000-000000000000' }));
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
    ensureDefaultMain: jest.fn().mockResolvedValue(undefined)
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
});
