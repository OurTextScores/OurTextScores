import { ScannerProviderError } from './scanner.errors';
import { ScannerWorkerService } from './scanner-worker.service';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp = require('sharp');

describe('ScannerWorkerService retry policy', () => {
  const values: Record<string, string> = {
    SCANNER_PROVIDER_BUDGET_EXHAUSTED: 'false'
  };
  const config = {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback)
  } as any;
  const provider = {
    scanPage: jest.fn()
  } as any;

  function service() {
    return new ScannerWorkerService({} as any, {} as any, provider, {} as any, {} as any, config);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    values.SCANNER_PROVIDER_BUDGET_EXHAUSTED = 'false';
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
      {} as any,
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
