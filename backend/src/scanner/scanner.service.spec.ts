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
      const service = new ScannerService(jobs, storage, config);

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
      const service = new ScannerService(jobs, storage, config);

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
    const service = new ScannerService(jobs, storage, config);
    const [result] = await service.listJobs('user-1');
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
    const service = new ScannerService(jobs, storage, config);
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
    const service = new ScannerService(jobs, storage, config);

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
    const service = new ScannerService(jobs, storage, config);

    await expect(service.startJob('user-1', 'job-1')).resolves.toMatchObject({
      status: 'queued'
    });
    expect(jobs.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ready' }),
      expect.objectContaining({ $set: { status: 'queued' } }),
      { new: true }
    );
  });
});
