import { ScannerProviderError } from './scanner.errors';
import { ScannerWorkerService } from './scanner-worker.service';

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
});
