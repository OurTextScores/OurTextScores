import { DerivativePipelineService } from './derivative-pipeline.service';
import { StorageService } from '../storage/storage.service';
import { ProgressService } from '../progress/progress.service';

describe('DerivativePipelineService (unit, mocked IO)', () => {
  let service: DerivativePipelineService;
  const storage = {
    putDerivativeObject: jest.fn().mockResolvedValue(({ bucket: 'der', objectKey: 'obj', etag: 'e' })),
    putAuxiliaryObject: jest.fn().mockResolvedValue(({ bucket: 'aux', objectKey: 'aux', etag: 'e' }))
  } as any as jest.Mocked<StorageService>;
  const progress = new ProgressService();

  beforeEach(() => {
    jest.resetAllMocks();
    service = new DerivativePipelineService(storage, progress);
    // Stub out calls that hit external tools and file IO complexity
    (service as any).storeDerivative = jest.fn(async (key: string, buf: Buffer, ct: string) => ({ bucket: 'der', objectKey: key, sizeBytes: buf.length, checksum: { algorithm: 'sha256', hexDigest: 'x' }, contentType: ct, lastModifiedAt: new Date() }));
    (service as any).extractCanonicalXml = jest.fn(async () => ({ path: '/tmp/canonical.xml', buffer: Buffer.from('<xml/>') }));
    // Simulate linearize success for MXL path
    (service as any).runCommand = jest.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'python3') return { stdout: 'LMX_CONTENT', stderr: '' };
      if (cmd === 'musescore3') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
  });

  it('process handles compressed MusicXML (.mxl) and stores derivatives', async () => {
    const input = {
      workId: '1',
      sourceId: 's',
      sequenceNumber: 1,
      format: 'application/vnd.recordare.musicxml',
      originalFilename: 'score.mxl',
      buffer: Buffer.from('zipdata'),
      rawStorage: { bucket: 'raw', objectKey: '1/s/raw', sizeBytes: 9, checksum: { algorithm: 'sha256', hexDigest: 'r' }, contentType: 'application/octet-stream', lastModifiedAt: new Date() }
    };
    const out = await service.process(input);
    expect(out.pending).toBe(false);
    expect(out.derivatives.canonicalXml).toBeTruthy();
    expect(out.derivatives.linearizedXml).toBeTruthy();
    expect(out.derivatives.normalizedMxl).toBeTruthy();
    expect(out.manifest).toBeTruthy();
  });

  it('process tolerates failed PDF generation', async () => {
    // Rewire runCommand to throw for musescore PDF
    (service as any).runCommand = jest.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'python3') return { stdout: 'LMX_CONTENT', stderr: '' };
      if (cmd === 'musescore3') throw new Error('no musescore');
      return { stdout: '', stderr: '' };
    });
    const input = {
      workId: '1',
      sourceId: 's',
      sequenceNumber: 1,
      format: 'application/vnd.recordare.musicxml',
      originalFilename: 'score.mxl',
      buffer: Buffer.from('zipdata'),
      rawStorage: { bucket: 'raw', objectKey: '1/s/raw', sizeBytes: 9, checksum: { algorithm: 'sha256', hexDigest: 'r' }, contentType: 'application/octet-stream', lastModifiedAt: new Date() }
    };
    const out = await service.process(input);
    expect(out.pending).toBe(false);
    expect(out.derivatives.pdf).toBeFalsy();
  });

  it('uses MUSESCORE_CLI when provided for MuseScore operations', async () => {
    process.env.MUSESCORE_CLI = 'musescore4';
    const local = new DerivativePipelineService(storage, progress);
    (local as any).storeDerivative = jest.fn(async (key: string, buf: Buffer, ct: string) => ({
      bucket: 'der',
      objectKey: key,
      sizeBytes: buf.length,
      checksum: { algorithm: 'sha256', hexDigest: 'x' },
      contentType: ct,
      lastModifiedAt: new Date()
    }));
    (local as any).extractCanonicalXml = jest.fn(async () => ({
      path: '/tmp/canonical.xml',
      buffer: Buffer.from('<xml/>')
    }));
    const runSpy = jest.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'python3') return { stdout: 'LMX_CONTENT', stderr: '' };
      if (cmd === 'musescore4') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    (local as any).runCommand = runSpy;

    const input = {
      workId: '1',
      sourceId: 's',
      sequenceNumber: 1,
      format: 'application/vnd.musescore.mscz',
      originalFilename: 'score.mscz',
      buffer: Buffer.from('msczdata'),
      rawStorage: {
        bucket: 'raw',
        objectKey: '1/s/raw',
        sizeBytes: 9,
        checksum: { algorithm: 'sha256', hexDigest: 'r' },
        contentType: 'application/octet-stream',
        lastModifiedAt: new Date()
      }
    };

    await local.process(input);
    expect(runSpy).toHaveBeenCalledWith('musescore4', expect.any(Array), expect.any(Object));
    delete process.env.MUSESCORE_CLI;
  });
});
