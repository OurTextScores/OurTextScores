import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException
} from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp = require('sharp');
import { ScannerService } from './scanner.service';
import { scannerUserHash } from './scanner.constants';

/** Regeneration is a provider call; correction tests assert on what it received. */
const provider = {
  regenerate: jest.fn(async () => Buffer.from('<score-partwise/>'))
} as any;

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
    countDocuments: jest.fn(),
    aggregate: jest.fn(),
    create: jest.fn()
  } as any;
  const storage = {
    putRawObject: jest.fn(),
    deleteObject: jest.fn()
  } as any;
  const alerts = { evaluate: jest.fn().mockResolvedValue([]) } as any;
  const telemetry = {
    emit: jest.fn(),
    userHash: jest.fn(() => 'user-hash'),
    trackJobCreated: jest.fn().mockResolvedValue(undefined)
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    values.SCANNER_ENABLED = 'true';
    values.SCANNER_BETA_USER_IDS = 'user-1';
    values.SCANNER_PROVIDER_BUDGET_EXHAUSTED = 'false';
    jobs.countDocuments.mockReturnValue({ exec: () => Promise.resolve(0) });
    jobs.aggregate.mockReturnValue({ exec: () => Promise.resolve([]) });
    jobs.create.mockImplementation((value: any) =>
      Promise.resolve({
        ...value,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    );
    storage.putRawObject.mockImplementation((objectKey: string) =>
      Promise.resolve({ bucket: 'raw', objectKey })
    );
    storage.deleteObject.mockResolvedValue(undefined);
  });

  it('natural-sorts multiple image inputs and persists their private source locators', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'scanner-service-test-'));
    try {
      const pageTwoPath = join(directory, 'upload-a');
      const pageTenPath = join(directory, 'upload-b');
      const image = await sharp({
        create: { width: 10, height: 20, channels: 3, background: '#ffffff' }
      })
        .png()
        .toBuffer();
      await Promise.all([fs.writeFile(pageTwoPath, image), fs.writeFile(pageTenPath, image)]);
      const multerFile = (path: string, originalname: string): Express.Multer.File =>
        ({ path, originalname, size: image.length }) as Express.Multer.File;
      const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);

      const result = await service.createJob({
        userId: 'user-1',
        files: [multerFile(pageTenPath, 'page-10.png'), multerFile(pageTwoPath, 'page-2.png')]
      });

      expect(result).toMatchObject({
        originalFilename: 'page-2.png + 1 more',
        pageCount: 2
      });
      expect(jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          inputContentType: 'multipart/mixed',
          pageCount: 2,
          inputs: [
            expect.objectContaining({
              originalFilename: 'page-2.png',
              storage: expect.objectContaining({
                objectKey: expect.stringMatching(/source-001\.png$/)
              })
            }),
            expect.objectContaining({
              originalFilename: 'page-10.png',
              storage: expect.objectContaining({
                objectKey: expect.stringMatching(/source-002\.png$/)
              })
            })
          ]
        })
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a PDF mixed with image inputs before storing either source', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'scanner-service-test-'));
    try {
      const pdfPath = join(directory, 'upload-pdf');
      const imagePath = join(directory, 'upload-image');
      const image = await sharp({
        create: { width: 10, height: 20, channels: 3, background: '#ffffff' }
      })
        .png()
        .toBuffer();
      await Promise.all([fs.writeFile(pdfPath, '%PDF-1.4\n'), fs.writeFile(imagePath, image)]);
      const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);

      await expect(
        service.createJob({
          userId: 'user-1',
          files: [
            { path: pdfPath, originalname: 'score.pdf', size: 9 } as Express.Multer.File,
            {
              path: imagePath,
              originalname: 'page.png',
              size: image.length
            } as Express.Multer.File
          ]
        })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.putRawObject).not.toHaveBeenCalled();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('never puts the user id in an object key and honours the salt', () => {
    const plain = scannerUserHash('507f1f77bcf86cd799439011');
    const salted = scannerUserHash('507f1f77bcf86cd799439011', 'deployment-salt');
    expect(plain).toMatch(/^[a-f0-9]{32}$/);
    expect(plain).not.toContain('507f1f77bcf86cd799439011');
    expect(salted).not.toBe(plain);
    // Deterministic, or previously written keys would become unreachable.
    expect(scannerUserHash('507f1f77bcf86cd799439011')).toBe(plain);
  });

  it('pages the job list with a cursor that survives same-millisecond ties', async () => {
    const createdAt = new Date('2026-08-07T10:00:00.000Z');
    const rows = ['job-c', 'job-b', 'job-a'].map((jobId) => ({
      jobId,
      userId: 'user-1',
      status: 'succeeded',
      statusVersion: 3,
      originalFilename: 'score.pdf',
      pageCount: 1,
      pages: [],
      createdAt,
      updatedAt: createdAt,
      resultExpiresAt: new Date()
    }));
    let captured: any;
    jobs.find.mockImplementation((filter: any) => {
      captured = filter;
      return { sort: () => ({ limit: () => ({ exec: () => Promise.resolve(rows) }) }) };
    });
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);

    const first = await service.listJobs('user-1', { limit: 2 });
    expect(first.items.map((job: any) => job.jobId)).toEqual(['job-c', 'job-b']);
    // A third row existed, so a cursor is offered.
    expect(first.nextCursor).toBeTruthy();

    await service.listJobs('user-1', { limit: 2, cursor: first.nextCursor! });
    // Ties on createdAt fall back to jobId so nothing is skipped or repeated.
    expect(captured.$or).toEqual([
      { createdAt: { $lt: createdAt } },
      { createdAt, jobId: { $lt: 'job-b' } }
    ]);
  });

  it('omits the cursor on the last page and rejects a malformed one', async () => {
    jobs.find.mockReturnValue({
      sort: () => ({ limit: () => ({ exec: () => Promise.resolve([]) }) })
    });
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);
    await expect(service.listJobs('user-1', { limit: 5 })).resolves.toMatchObject({
      items: [],
      nextCursor: null
    });
    await expect(
      service.listJobs('user-1', { cursor: Buffer.from('nonsense').toString('base64url') })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('aggregates operational metrics without exposing any score content', async () => {
    const queuedAt = new Date(Date.now() - 90_000);
    jobs.aggregate.mockReturnValue({
      exec: () =>
        Promise.resolve([
          { _id: 'succeeded', jobs: 2, pages: 3 },
          { _id: 'queued', jobs: 1, pages: 1 }
        ])
    });
    jobs.find.mockImplementation((filter: any) => {
      if (filter?.status === 'queued') {
        return {
          sort: () => ({ limit: () => ({ exec: () => Promise.resolve([{ queuedAt }]) }) })
        };
      }
      return {
        select: () => ({
          lean: () => ({
            exec: () =>
              Promise.resolve([
                {
                  timings: { providerMs: 12_000 },
                  pages: [
                    { status: 'succeeded', durationMs: 5_000, providerAttempts: 1, pdf: {} },
                    { status: 'succeeded', durationMs: 9_000, providerAttempts: 2 },
                    {
                      status: 'failed',
                      errorCode: 'provider_no_staff_detected',
                      providerAttempts: 1
                    }
                  ]
                }
              ])
          })
        })
      };
    });

    const result = await new ScannerService(jobs, storage, provider, telemetry, alerts, config).metrics(24);

    expect(result.pagesByStatus).toEqual({ succeeded: 2, failed: 1 });
    expect(result.pageLatencyMs).toMatchObject({ samples: 2, p50: 9_000, max: 9_000 });
    expect(result.failuresByCode).toEqual({ provider_no_staff_detected: 1 });
    expect(result.failureRate).toBeCloseTo(1 / 3, 3);
    // One of the two successes rendered a PDF.
    expect(result.renderSuccessRate).toBeCloseTo(0.5, 3);
    expect(result.provider).toEqual({ calls: 4, approximateSeconds: 12 });
    expect(result.queue.oldestQueuedAgeMs).toBeGreaterThanOrEqual(90_000);
    // Aggregates only: no filenames, ids, or artifact locators anywhere.
    expect(JSON.stringify(result)).not.toMatch(/musicxml|objectKey|originalFilename|userId/i);
  });

  it('rejects encrypted PDFs at intake rather than during rasterization', () => {
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);
    expect(() =>
      service.parsePdfInfo(
        'Title:          Score\nPages:          4\nEncrypted:      yes (print:yes)\n'
      )
    ).toThrow(BadRequestException);
    expect(service.parsePdfInfo('Pages:          4\nEncrypted:      no\n')).toBe(4);
  });

  it('rejects pdfinfo output with no usable page count', () => {
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);
    expect(() => service.parsePdfInfo('Encrypted:      no\n')).toThrow(BadRequestException);
    expect(() => service.parsePdfInfo('Pages:          0\n')).toThrow(BadRequestException);
  });

  it('is disabled by default unless explicitly enabled', () => {
    values.SCANNER_ENABLED = 'false';
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);
    expect(() => service.assertAvailable('user-1')).toThrow(ServiceUnavailableException);
  });

  it('requires the authenticated user to be allowlisted', () => {
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);
    expect(() => service.assertAvailable('user-2')).toThrow(ForbiddenException);
    expect(() => service.assertAvailable('user-1')).not.toThrow();
  });

  it('keeps existing results accessible when provider budget is exhausted', () => {
    values.SCANNER_PROVIDER_BUDGET_EXHAUSTED = 'true';
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);
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
      inputs: [
        {
          originalFilename: 'private-page.png',
          storage: { bucket: 'raw', objectKey: 'private-multi-source' }
        }
      ],
      resultExpiresAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    };
    jobs.find.mockReturnValue({
      sort: () => ({ limit: () => ({ exec: () => Promise.resolve([document]) }) })
    });
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);
    const { items } = await service.listJobs('user-1');
    const [result] = items;
    expect(result.hasMusicXml).toBe(true);
    expect(result.pages[0]).not.toHaveProperty('idempotencyKey');
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(JSON.stringify(result)).not.toContain('private-source');
    expect(JSON.stringify(result)).not.toContain('private-multi-source');
    expect(JSON.stringify(result)).not.toContain('private-page.png');
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
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);
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
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);
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
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);
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
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);
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
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);
    await expect(service.retryPage('user-1', 'job-1', 1)).rejects.toBeInstanceOf(ConflictException);
  });

  it('persists a complete page order, rotation, and inclusion setup while ready', async () => {
    const existing = {
      _id: 'mongo-id',
      jobId: 'job-1',
      userId: 'user-1',
      status: 'ready',
      originalFilename: 'score.pdf',
      pageCount: 2,
      pages: [
        {
          pageNumber: 1,
          ordinal: 1,
          rotationDegrees: 0,
          included: true,
          status: 'pending',
          attempts: 0
        },
        {
          pageNumber: 2,
          ordinal: 2,
          rotationDegrees: 0,
          included: true,
          status: 'pending',
          attempts: 0
        }
      ],
      sourceExpiresAt: new Date(Date.now() + 60_000),
      resultExpiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date()
    };
    jobs.findOne.mockReturnValue({ exec: () => Promise.resolve(existing) });
    jobs.findOneAndUpdate.mockImplementation((_query: any, update: any) => ({
      exec: () => Promise.resolve({ ...existing, pages: update.$set.pages })
    }));
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);
    const result = await service.configurePages('user-1', 'job-1', [
      { pageNumber: 2, ordinal: 1, rotationDegrees: 90, included: true },
      { pageNumber: 1, ordinal: 2, rotationDegrees: 180, included: false }
    ]);

    expect(result.pages).toEqual([
      expect.objectContaining({
        pageNumber: 2,
        ordinal: 1,
        rotationDegrees: 90,
        included: true,
        status: 'pending'
      }),
      expect.objectContaining({
        pageNumber: 1,
        ordinal: 2,
        rotationDegrees: 180,
        included: false,
        status: 'skipped'
      })
    ]);
  });

  it('rejects an invalid page setup and requires an included page', async () => {
    const existing = {
      _id: 'mongo-id',
      jobId: 'job-1',
      userId: 'user-1',
      status: 'ready',
      pageCount: 1,
      pages: [{ pageNumber: 1, ordinal: 1, included: true, status: 'pending' }]
    };
    jobs.findOne.mockReturnValue({ exec: () => Promise.resolve(existing) });
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);

    await expect(
      service.configurePages('user-1', 'job-1', [
        { pageNumber: 1, ordinal: 1, rotationDegrees: 45, included: true }
      ])
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.configurePages('user-1', 'job-1', [
        { pageNumber: 1, ordinal: 1, rotationDegrees: 0, included: false }
      ])
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('queues a ready job only after explicit start', async () => {
    const existing = {
      _id: 'mongo-id',
      jobId: 'job-1',
      userId: 'user-1',
      status: 'ready',
      originalFilename: 'score.png',
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          ordinal: 1,
          rotationDegrees: 0,
          included: true,
          status: 'pending',
          attempts: 0
        }
      ],
      sourceExpiresAt: new Date(Date.now() + 60_000),
      resultExpiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date()
    };
    jobs.findOne.mockReturnValue({ exec: () => Promise.resolve(existing) });
    jobs.findOneAndUpdate.mockReturnValue({
      exec: () => Promise.resolve({ ...existing, status: 'queued' })
    });
    const service = new ScannerService(jobs, storage, provider, telemetry, alerts, config);

    await expect(service.startJob('user-1', 'job-1')).resolves.toMatchObject({
      status: 'queued'
    });
    expect(jobs.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ready' }),
      expect.objectContaining({
        // queuedAt starts the queue-wait clock measured in 13.4.
        $set: { status: 'queued', queuedAt: expect.any(Date) }
      }),
      { new: true }
    );
  });
});
