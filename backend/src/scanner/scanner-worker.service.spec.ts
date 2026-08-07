import { ScannerProviderError } from './scanner.errors';
import { ScannerWorkerService } from './scanner-worker.service';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp = require('sharp');

describe('ScannerWorkerService', () => {
  const values: Record<string, string> = {
    SCANNER_ENABLED: 'true',
    SCANNER_PROVIDER_BUDGET_EXHAUSTED: 'false'
  };
  const config = {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback)
  } as any;
  const provider = {
    scanPage: jest.fn()
  } as any;
  const merger = { enabled: false, merge: jest.fn() } as any;
  const telemetry = {
    emit: jest.fn(),
    userHash: jest.fn(() => 'user-hash'),
    trackJobFinished: jest.fn().mockResolvedValue(undefined)
  } as any;

  function service() {
    return new ScannerWorkerService(
      {} as any,
      {} as any,
      provider,
      {} as any,
      merger,
      {} as any,
      telemetry,
      config
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    values.SCANNER_PROVIDER_BUDGET_EXHAUSTED = 'false';
    delete values.SCANNER_PROVIDER_KIND;
    delete values.SCANNER_TEST_WORKER_LEASE_MS;
  });

  it('retries one transient failure with exactly the same idempotency key', async () => {
    provider.scanPage
      .mockRejectedValueOnce(new ScannerProviderError('busy', 'provider_http_503', true))
      .mockResolvedValueOnce({
        musicXml: Buffer.from('<score-partwise/>'),
        providerRevision: 'service',
        modelRevision: 'model'
      });
    const result = await (service() as any).scanWithRetry({
      image: Buffer.from('image'),
      pageNumber: 1,
      detectTitle: false,
      idempotencyKey: 'stable-key'
    });
    expect(result.attempts).toBe(2);
    expect(provider.scanPage).toHaveBeenCalledTimes(2);
    expect(provider.scanPage.mock.calls[0][0].idempotencyKey).toBe('stable-key');
    expect(provider.scanPage.mock.calls[1][0].idempotencyKey).toBe('stable-key');
  });

  it('does not retry deterministic input/model errors', async () => {
    provider.scanPage.mockRejectedValue(
      new ScannerProviderError('invalid', 'invalid_musicxml', false)
    );
    await expect(
      (service() as any).scanWithRetry({
        image: Buffer.from('image'),
        pageNumber: 1,
        detectTitle: false,
        idempotencyKey: 'stable-key'
      })
    ).rejects.toMatchObject({ code: 'invalid_musicxml', retryable: false });
    expect(provider.scanPage).toHaveBeenCalledTimes(1);
  });

  it('does not call the provider after the budget switch is set', async () => {
    values.SCANNER_PROVIDER_BUDGET_EXHAUSTED = 'true';
    await expect(
      (service() as any).scanWithRetry({
        image: Buffer.from('image'),
        pageNumber: 1,
        detectTitle: false,
        idempotencyKey: 'stable-key'
      })
    ).rejects.toMatchObject({ code: 'provider_budget_exhausted', retryable: false });
    expect(provider.scanPage).not.toHaveBeenCalled();
  });

  it('does not grant extra attempts on lease recovery or retry deterministic pages', () => {
    const scannerWorker = service() as any;
    const transient = {
      pageNumber: 1,
      status: 'failed',
      attempts: 2,
      idempotencyKey: 'generation-1',
      errorCode: 'provider_timeout'
    };
    const deterministic = {
      ...transient,
      errorCode: 'invalid_musicxml'
    };

    expect(scannerWorker.shouldPreservePriorFailure(transient, 'generation-1')).toBe(true);
    expect(scannerWorker.shouldPreservePriorFailure(transient, 'generation-2')).toBe(false);
    expect(scannerWorker.shouldPreservePriorFailure(deterministic, 'generation-2')).toBe(true);
  });

  it('claims expired processing jobs and replaces the prior worker lease', async () => {
    const recovered = { jobId: 'job-1', status: 'running' };
    const findOneAndUpdate = jest.fn().mockReturnValue({
      exec: () => Promise.resolve(recovered)
    });
    const scannerWorker = new ScannerWorkerService(
      { findOneAndUpdate } as any,
      {} as any,
      provider,
      {} as any,
      merger,
      {} as any,
      telemetry,
      config
    ) as any;

    await expect(scannerWorker.claim()).resolves.toBe(recovered);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: expect.arrayContaining([
          expect.objectContaining({
            status: { $in: ['running', 'rendering'] },
            leaseExpiresAt: expect.objectContaining({ $lt: expect.any(Date) })
          })
        ])
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          leaseOwner: expect.any(String),
          leaseExpiresAt: expect.any(Date)
        })
      }),
      { new: true, sort: { createdAt: 1 } }
    );
  });

  it('scopes progress and terminal writes to the lease it still holds', async () => {
    // A worker that stalls past its lease must not overwrite the work of
    // whichever worker reclaimed the job.
    const updateOne = jest.fn().mockReturnValue({ exec: () => Promise.resolve({}) });
    const findOneAndUpdate = jest.fn().mockReturnValue({ exec: () => Promise.resolve(null) });
    const scannerWorker = new ScannerWorkerService(
      { updateOne, findOneAndUpdate } as any,
      {} as any,
      provider,
      {} as any,
      merger,
      {} as any,
      telemetry,
      config
    ) as any;
    const workerId = scannerWorker.workerId;
    const job = { jobId: 'job-1', pageCount: 1, pages: [] };

    await scannerWorker.persistPageProgress(job, [], new Map(), undefined, 'service', 'model');
    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', leaseOwner: workerId }),
      expect.anything()
    );

    await scannerWorker.finish(job, 'failed', [], {});
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', leaseOwner: workerId }),
      expect.anything(),
      { new: true }
    );
  });

  describe('page assembly gating', () => {
    const worker = () =>
      new ScannerWorkerService(
        {} as any,
        {} as any,
        provider,
        {} as any,
        merger,
        {} as any,
        telemetry,
        config
      ) as any;
    const job = { jobId: 'job-1', userId: 'user-1' } as any;
    const succeeded = (count: number) =>
      Array.from({ length: count }, (_value, index) => ({
        pageNumber: index + 1,
        ordinal: index + 1,
        status: 'succeeded',
        musicXml: { bucket: 'aux', objectKey: `page-${index + 1}.musicxml` }
      }));

    beforeEach(() => {
      merger.enabled = false;
      merger.merge.mockReset();
    });

    it('does not attempt assembly while the flag is off', async () => {
      await expect(worker().combinePages(job, succeeded(3), 3)).resolves.toEqual({
        status: 'not-requested'
      });
      expect(merger.merge).not.toHaveBeenCalled();
    });

    it('refuses a partial job so a gap cannot be silently closed up', async () => {
      merger.enabled = true;
      // Two of three pages succeeded: combining them would produce a score that
      // looks complete but is missing a page of music.
      await expect(worker().combinePages(job, succeeded(2), 3)).resolves.toMatchObject({
        status: 'incompatible'
      });
      expect(merger.merge).not.toHaveBeenCalled();
    });

    it('does not assemble a single page', async () => {
      merger.enabled = true;
      await expect(worker().combinePages(job, succeeded(1), 1)).resolves.toEqual({
        status: 'not-requested'
      });
      expect(merger.merge).not.toHaveBeenCalled();
    });
  });

  it('allows a short lease only for fake-provider recovery tests', () => {
    values.SCANNER_PROVIDER_KIND = 'fake';
    values.SCANNER_TEST_WORKER_LEASE_MS = '1000';
    expect((service() as any).leaseMs()).toBe(5_000);

    values.SCANNER_PROVIDER_KIND = 'modal';
    expect((service() as any).leaseMs()).toBe(1_200_000);
  });

  it('prepares every retained image in its persisted page order', async () => {
    const first = await sharp({
      create: { width: 12, height: 8, channels: 3, background: '#ffffff' }
    })
      .png()
      .toBuffer();
    const second = await sharp({
      create: { width: 7, height: 15, channels: 3, background: '#000000' }
    })
      .png()
      .toBuffer();
    const workspace = await fs.mkdtemp(join(tmpdir(), 'scanner-worker-test-'));
    try {
      const pages = await (service() as any).preparePages(
        { pageCount: 2 },
        [
          {
            source: {
              originalFilename: 'page-2.png',
              storage: { contentType: 'image/png' }
            },
            buffer: first
          },
          {
            source: {
              originalFilename: 'page-10.png',
              storage: { contentType: 'image/png' }
            },
            buffer: second
          }
        ],
        workspace
      );

      expect(pages.map((page: any) => page.pageNumber)).toEqual([1, 2]);
      await expect(sharp(pages[0].path).metadata()).resolves.toMatchObject({
        width: 12,
        height: 8
      });
      await expect(sharp(pages[1].path).metadata()).resolves.toMatchObject({
        width: 7,
        height: 15
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it('materializes only included pages in saved order with saved rotation', async () => {
    const image = await sharp({
      create: { width: 10, height: 20, channels: 3, background: '#ffffff' }
    })
      .png()
      .toBuffer();
    const storage = { getObjectBuffer: jest.fn().mockResolvedValue(image) } as any;
    const scannerWorker = new ScannerWorkerService(
      {} as any,
      storage,
      provider,
      {} as any,
      merger,
      {} as any,
      telemetry,
      config
    ) as any;
    const workspace = await fs.mkdtemp(join(tmpdir(), 'scanner-worker-test-'));
    try {
      const pages = await scannerWorker.materializeConfiguredPages(
        {
          pages: [
            {
              pageNumber: 1,
              ordinal: 2,
              rotationDegrees: 0,
              included: true,
              sourceImage: { bucket: 'aux', objectKey: 'one.png' }
            },
            {
              pageNumber: 2,
              ordinal: 1,
              rotationDegrees: 90,
              included: true,
              sourceImage: { bucket: 'aux', objectKey: 'two.png' }
            },
            {
              pageNumber: 3,
              ordinal: 3,
              rotationDegrees: 0,
              included: false,
              sourceImage: { bucket: 'aux', objectKey: 'three.png' }
            }
          ]
        },
        workspace
      );

      expect(pages.map((page: any) => page.pageNumber)).toEqual([2, 1]);
      expect(storage.getObjectBuffer).toHaveBeenCalledTimes(2);
      await expect(sharp(pages[0].path).metadata()).resolves.toMatchObject({
        width: 20,
        height: 10
      });
      await expect(sharp(pages[1].path).metadata()).resolves.toMatchObject({
        width: 10,
        height: 20
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
