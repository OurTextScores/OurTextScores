import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ScannerService } from './scanner.service';

describe('ScannerService', () => {
  const values: Record<string, string> = {
    SCANNER_ENABLED: 'true',
    SCANNER_BETA_USER_IDS: 'user-1'
  };
  const config = {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback)
  } as any;
  const jobs = {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    countDocuments: jest.fn()
  } as any;
  const storage = {} as any;

  beforeEach(() => {
    jest.clearAllMocks();
    values.SCANNER_ENABLED = 'true';
    values.SCANNER_BETA_USER_IDS = 'user-1';
    values.SCANNER_PROVIDER_BUDGET_EXHAUSTED = 'false';
  });

  it('is disabled by default unless explicitly enabled', () => {
    values.SCANNER_ENABLED = 'false';
    const service = new ScannerService(jobs, storage, config);
    expect(() => service.assertAvailable('user-1')).toThrow(ServiceUnavailableException);
  });

  it('requires the authenticated user to be allowlisted', () => {
    const service = new ScannerService(jobs, storage, config);
    expect(() => service.assertAvailable('user-2')).toThrow(ForbiddenException);
    expect(() => service.assertAvailable('user-1')).not.toThrow();
  });

  it('keeps existing results accessible when provider budget is exhausted', () => {
    values.SCANNER_PROVIDER_BUDGET_EXHAUSTED = 'true';
    const service = new ScannerService(jobs, storage, config);
    expect(() => service.assertAvailable('user-1')).not.toThrow();
  });

  it('returns owned job summaries without storage locators or idempotency keys', async () => {
    const document = {
      jobId: 'job-1',
      status: 'succeeded',
      originalFilename: 'score.png',
      pageCount: 1,
      options: { detectTitle: false },
      pages: [
        {
          pageNumber: 1,
          status: 'succeeded',
          attempts: 1,
          idempotencyKey: 'secret-key',
          musicXml: { bucket: 'aux', objectKey: 'private-key' }
        }
      ],
      input: { bucket: 'raw', objectKey: 'private-source' },
      resultExpiresAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    };
    jobs.find.mockReturnValue({
      sort: () => ({ limit: () => ({ exec: () => Promise.resolve([document]) }) })
    });
    const service = new ScannerService(jobs, storage, config);
    const [result] = await service.listJobs('user-1');
    expect(result.hasMusicXml).toBe(true);
    expect(result.pages[0]).not.toHaveProperty('idempotencyKey');
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(JSON.stringify(result)).not.toContain('private-source');
  });

  it('queues one manual generation for a transiently failed page', async () => {
    const existing = {
      _id: 'mongo-id',
      jobId: 'job-1',
      userId: 'user-1',
      status: 'failed',
      generation: 1,
      originalFilename: 'score.png',
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          status: 'failed',
          attempts: 2,
          idempotencyKey: 'old',
          errorCode: 'provider_timeout'
        }
      ],
      sourceExpiresAt: new Date(Date.now() + 60_000),
      resultExpiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const queued = { ...existing, status: 'queued', generation: 2 };
    jobs.findOne.mockReturnValue({ exec: () => Promise.resolve(existing) });
    jobs.countDocuments.mockReturnValue({ exec: () => Promise.resolve(0) });
    jobs.findOneAndUpdate.mockReturnValue({ exec: () => Promise.resolve(queued) });
    const service = new ScannerService(jobs, storage, config);
    const result = await service.retryJob('user-1', 'job-1');
    expect(result.status).toBe('queued');
    expect(jobs.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 1 }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'queued',
          generation: 2,
          retryPageNumbers: [1],
          pages: [expect.objectContaining({ pageNumber: 1, manualRetries: 1 })]
        }),
        $unset: expect.objectContaining({ terminalNotifiedAt: 1 })
      }),
      { new: true }
    );
  });

  it('rejects manual retries for deterministic failures', async () => {
    const existing = {
      _id: 'mongo-id',
      jobId: 'job-1',
      userId: 'user-1',
      status: 'failed',
      generation: 1,
      pages: [
        {
          pageNumber: 1,
          status: 'failed',
          attempts: 1,
          idempotencyKey: 'old',
          errorCode: 'invalid_musicxml'
        }
      ],
      sourceExpiresAt: new Date(Date.now() + 60_000)
    };
    jobs.findOne.mockReturnValue({ exec: () => Promise.resolve(existing) });
    const service = new ScannerService(jobs, storage, config);
    await expect(service.retryJob('user-1', 'job-1')).rejects.toBeInstanceOf(ConflictException);
    expect(jobs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('allows one manual retry after the provider budget switch is cleared', async () => {
    const existing = {
      _id: 'mongo-id',
      jobId: 'job-1',
      userId: 'user-1',
      status: 'failed',
      generation: 1,
      originalFilename: 'score.png',
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          status: 'failed',
          attempts: 1,
          idempotencyKey: 'old',
          errorCode: 'provider_budget_exhausted'
        }
      ],
      sourceExpiresAt: new Date(Date.now() + 60_000),
      resultExpiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date()
    };
    jobs.findOne.mockReturnValue({ exec: () => Promise.resolve(existing) });
    jobs.countDocuments.mockReturnValue({ exec: () => Promise.resolve(0) });
    jobs.findOneAndUpdate.mockReturnValue({
      exec: () => Promise.resolve({ ...existing, status: 'queued', generation: 2 })
    });
    const service = new ScannerService(jobs, storage, config);
    await expect(service.retryJob('user-1', 'job-1')).resolves.toMatchObject({
      status: 'queued'
    });
  });

  it('queues only the selected transiently failed page', async () => {
    const existing = {
      _id: 'mongo-id',
      jobId: 'job-1',
      userId: 'user-1',
      status: 'partial',
      generation: 1,
      originalFilename: 'score.pdf',
      pageCount: 2,
      pages: [
        {
          pageNumber: 1,
          status: 'succeeded',
          attempts: 1,
          manualRetries: 0,
          idempotencyKey: 'page-1',
          musicXml: { bucket: 'aux', objectKey: 'one.musicxml' },
          pdf: { bucket: 'aux', objectKey: 'one.pdf' }
        },
        {
          pageNumber: 2,
          status: 'failed',
          attempts: 2,
          manualRetries: 0,
          idempotencyKey: 'page-2',
          errorCode: 'provider_http_503'
        }
      ],
      sourceExpiresAt: new Date(Date.now() + 60_000),
      resultExpiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date()
    };
    jobs.findOne.mockReturnValue({ exec: () => Promise.resolve(existing) });
    jobs.countDocuments.mockReturnValue({ exec: () => Promise.resolve(0) });
    jobs.findOneAndUpdate.mockReturnValue({
      exec: () => Promise.resolve({ ...existing, status: 'queued', generation: 2 })
    });
    const service = new ScannerService(jobs, storage, config);
    await service.retryPage('user-1', 'job-1', 2);
    expect(jobs.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({
          retryPageNumbers: [2],
          pages: [
            expect.objectContaining({ pageNumber: 1, manualRetries: 0 }),
            expect.objectContaining({ pageNumber: 2, manualRetries: 1 })
          ]
        })
      }),
      { new: true }
    );
  });

  it('rejects a second manual retry for the same page', async () => {
    const existing = {
      jobId: 'job-1',
      userId: 'user-1',
      status: 'failed',
      generation: 2,
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          status: 'failed',
          attempts: 2,
          manualRetries: 1,
          idempotencyKey: 'page-1',
          errorCode: 'provider_timeout'
        }
      ],
      sourceExpiresAt: new Date(Date.now() + 60_000)
    };
    jobs.findOne.mockReturnValue({ exec: () => Promise.resolve(existing) });
    const service = new ScannerService(jobs, storage, config);
    await expect(service.retryPage('user-1', 'job-1', 1)).rejects.toBeInstanceOf(ConflictException);
  });
});
