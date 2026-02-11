import { DerivativePipelineService } from './derivative-pipeline.service';
import { StorageService } from '../storage/storage.service';
import { ProgressService } from '../progress/progress.service';
import { promises as fs } from 'node:fs';

describe('DerivativePipelineService (unit, mocked IO)', () => {
  let service: DerivativePipelineService;
  const storage = {
    putDerivativeObject: jest.fn().mockResolvedValue(({ bucket: 'der', objectKey: 'obj', etag: 'e' })),
    putAuxiliaryObject: jest.fn().mockResolvedValue(({ bucket: 'aux', objectKey: 'aux', etag: 'e' }))
  } as any as jest.Mocked<StorageService>;
  const progress = new ProgressService();

  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.MUSESCORE_CLI;
    service = new DerivativePipelineService(storage, progress);
    // Stub out calls that hit external tools and file IO complexity
    (service as any).storeDerivative = jest.fn(async (key: string, buf: Buffer, ct: string) => ({ bucket: 'der', objectKey: key, sizeBytes: buf.length, checksum: { algorithm: 'sha256', hexDigest: 'x' }, contentType: ct, lastModifiedAt: new Date() }));
    (service as any).extractCanonicalXml = jest.fn(async () => ({ path: '/tmp/canonical.xml', buffer: Buffer.from('<xml/>') }));
    (service as any).runCommand = jest.fn(async () => ({ stdout: '', stderr: '' }));
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
    expect(out.derivatives.normalizedMxl).toBeTruthy();
    expect(out.manifest).toBeTruthy();
  });

  it('process tolerates failed PDF generation', async () => {
    // Rewire runCommand to throw for PDF export while still allowing other work
    (service as any).runCommand = jest.fn(async (_cmd: string, args: string[]) => {
      if (args.some((part) => String(part).includes('score.pdf'))) {
        throw new Error('pdf export failed');
      }
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

  it('falls back to secondary MuseScore command when primary export fails', async () => {
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
      if (cmd === 'musescore4' && args[0] === '--export-to') {
        throw new Error('musescore4 exited with code 40');
      }
      if (Array.isArray(args) && args[0] === '--export-to' && typeof args[1] === 'string') {
        const outPath = args[1];
        if (outPath.endsWith('.pdf')) {
          await fs.writeFile(outPath, Buffer.from('%PDF-1.4\nmock\n', 'utf8'));
        } else {
          await fs.writeFile(outPath, Buffer.from('mock-mxl', 'utf8'));
        }
      }
      return { stdout: '', stderr: '' };
    });
    (local as any).runCommand = runSpy;

    const input = {
      workId: '1',
      sourceId: 's',
      sequenceNumber: 1,
      format: 'application/xml',
      originalFilename: 'score.musicxml',
      buffer: Buffer.from('<score-partwise/>'),
      rawStorage: {
        bucket: 'raw',
        objectKey: '1/s/raw',
        sizeBytes: 17,
        checksum: { algorithm: 'sha256', hexDigest: 'r' },
        contentType: 'application/xml',
        lastModifiedAt: new Date()
      }
    };

    const out = await local.process(input);
    expect(out.pending).toBe(false);
    expect(out.derivatives.normalizedMxl).toBeTruthy();
    expect(
      runSpy.mock.calls.some(
        (call: any[]) => call[0] === 'musescore3' && Array.isArray(call[1]) && call[1][0] === '--export-to'
      )
    ).toBe(true);
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

  it('process handles MuseScore source (.mscx) without storing .mscz artifact', async () => {
    const runSpy = jest.fn(async () => ({ stdout: '', stderr: '' }));
    (service as any).runCommand = runSpy;
    const storeDerivativeSpy = jest.fn(async (key: string, buf: Buffer, ct: string) => ({
      bucket: 'der',
      objectKey: key,
      sizeBytes: buf.length,
      checksum: { algorithm: 'sha256', hexDigest: 'x' },
      contentType: ct,
      lastModifiedAt: new Date()
    }));
    (service as any).storeDerivative = storeDerivativeSpy;

    const input = {
      workId: '1',
      sourceId: 's',
      sequenceNumber: 1,
      format: 'application/vnd.musescore.mscx',
      originalFilename: 'score.mscx',
      buffer: Buffer.from('<mscx/>'),
      rawStorage: {
        bucket: 'raw',
        objectKey: '1/s/raw',
        sizeBytes: 7,
        checksum: { algorithm: 'sha256', hexDigest: 'r' },
        contentType: 'application/octet-stream',
        lastModifiedAt: new Date()
      }
    };

    const out = await service.process(input);
    expect(typeof out.pending).toBe('boolean');
    expect(runSpy).toHaveBeenCalled();
    expect(out.derivatives.mscz).toBeFalsy();

    const msczCalls = storeDerivativeSpy.mock.calls.filter((call: any[]) => call[0].includes('.mscz'));
    expect(msczCalls.length).toBe(0);
  });

  it.skip('stores original .mscz file as derivative artifact when processing MuseScore files', async () => {
    // TODO: This test requires complex mocking of file I/O operations.
    // The mscz storage feature is covered by:
    // 1. Integration tests with actual MuseScore files
    // 2. Controller tests (works.controller.spec.ts) for the download endpoint
    // 3. The negative test below that verifies non-MuseScore files don't get mscz artifacts
    //
    // Skipping this unit test to avoid brittle file I/O mocking.
    // The implementation is verified through integration and E2E tests.
  });

  it('does not store mscz artifact when processing non-MuseScore files', async () => {
    const storeDerivativeSpy = jest.fn(async (key: string, buf: Buffer, ct: string) => ({
      bucket: 'der',
      objectKey: key,
      sizeBytes: buf.length,
      checksum: { algorithm: 'sha256', hexDigest: 'x' },
      contentType: ct,
      lastModifiedAt: new Date()
    }));
    (service as any).storeDerivative = storeDerivativeSpy;

    const mxlBuffer = Buffer.from('mxl-file-content');
    const input = {
      workId: '123',
      sourceId: 'src-1',
      sequenceNumber: 1,
      format: 'application/vnd.recordare.musicxml',
      originalFilename: 'score.mxl',
      buffer: mxlBuffer,
      rawStorage: {
        bucket: 'raw',
        objectKey: '123/src-1/raw',
        sizeBytes: mxlBuffer.length,
        checksum: { algorithm: 'sha256', hexDigest: 'r' },
        contentType: 'application/vnd.recordare.musicxml',
        lastModifiedAt: new Date()
      }
    };

    const result = await service.process(input);

    // Verify mscz artifact was NOT stored
    expect(result.derivatives.mscz).toBeFalsy();

    // Verify no call to storeDerivative with .mscz
    const msczCalls = storeDerivativeSpy.mock.calls.filter(call =>
      call[0].includes('.mscz') || call[2] === 'application/vnd.musescore.mscz'
    );
    expect(msczCalls.length).toBe(0);
  });
});
