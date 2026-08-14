import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException
} from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import AdmZip = require('adm-zip');
import sharp = require('sharp');
import { ScannerService } from './scanner.service';
import { effectivePageMusicXml, scannerUserHash } from './scanner.constants';
import {
  SCANNER_ARTIFACT_BUILDERS,
  scannerEngineReviewContentSignature,
  scannerEnginePlan,
  scannerHomrRun,
  scannerMergedScoreBasis,
  withScannerArtifactInputSignature
} from './scanner-dual-engine';
import { ScannerEngineDefinition, ScannerEngineRegistry } from './scanner-engine.registry';

/** Durable training records; kept out of the job so they outlive it. */
const corrections = { create: jest.fn(async (doc: any) => doc) } as any;

/** Regeneration is a provider call; correction tests assert on what it received. */
const provider = {
  engine: 'homr',
  regenerate: jest.fn(async () => Buffer.from('<score-partwise/>'))
} as any;

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

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
    delete values.SCANNER_TRANSCODA_ENABLED;
    delete values.SCANNER_TRANSCODA_PROVIDER_BUDGET_EXHAUSTED;
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
      const service = new ScannerService(
        jobs,
        corrections,
        storage,
        provider,
        telemetry,
        alerts,
        config
      );

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
          enginePlan: expect.objectContaining({
            engineIds: ['homr'],
            primaryEngineId: 'homr'
          }),
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
      const service = new ScannerService(
        jobs,
        corrections,
        storage,
        provider,
        telemetry,
        alerts,
        config
      );

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
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );

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
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );
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
                    },
                    {
                      // Aggregate success through Transcoda must not hide the
                      // primary engine from operations.
                      status: 'succeeded',
                      engines: {
                        homr: {
                          status: 'failed',
                          errorCode: 'provider_http_503',
                          providerAttempts: 1
                        },
                        transcoda: { status: 'succeeded', providerAttempts: 1, durationMs: 3000 },
                        'audiveris-5': {
                          status: 'failed',
                          providerAttempts: 2,
                          durationMs: 4000,
                          errorCode: 'provider_bad_gateway'
                        }
                      }
                    }
                  ]
                }
              ])
          })
        })
      };
    });

    const result = await new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    ).metrics(24);

    expect(result.pagesByStatus).toEqual({ succeeded: 2, failed: 2 });
    expect(result.pageLatencyMs).toMatchObject({ samples: 2, p50: 9_000, max: 9_000 });
    expect(result.failuresByCode).toEqual({
      provider_no_staff_detected: 1,
      provider_http_503: 1
    });
    expect(result.failureRate).toBeCloseTo(1 / 2, 3);
    // One of the two successes rendered a PDF.
    expect(result.renderSuccessRate).toBeCloseTo(0.5, 3);
    expect(result.provider).toEqual({ calls: 5, approximateSeconds: 14 });
    expect(result.engines.transcoda).toMatchObject({
      pagesByStatus: { succeeded: 1, failed: 0 },
      failureRate: 0,
      provider: { calls: 1, approximateSeconds: 3 }
    });
    expect(result.engines['audiveris-5']).toMatchObject({
      pagesByStatus: { succeeded: 0, failed: 1 },
      failureRate: 1,
      failuresByCode: { provider_bad_gateway: 1 },
      provider: { calls: 2, approximateSeconds: 4 }
    });
    expect(result.queue.oldestQueuedAgeMs).toBeGreaterThanOrEqual(90_000);
    // Aggregates only: no filenames, ids, or artifact locators anywhere.
    expect(JSON.stringify(result)).not.toMatch(/musicxml|objectKey|originalFilename|userId/i);
  });

  it('rejects encrypted PDFs at intake rather than during rasterization', () => {
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );
    expect(() =>
      service.parsePdfInfo(
        'Title:          Score\nPages:          4\nEncrypted:      yes (print:yes)\n'
      )
    ).toThrow(BadRequestException);
    expect(service.parsePdfInfo('Pages:          4\nEncrypted:      no\n')).toBe(4);
  });

  it('rejects pdfinfo output with no usable page count', () => {
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );
    expect(() => service.parsePdfInfo('Encrypted:      no\n')).toThrow(BadRequestException);
    expect(() => service.parsePdfInfo('Pages:          0\n')).toThrow(BadRequestException);
  });

  it('is disabled by default unless explicitly enabled', () => {
    values.SCANNER_ENABLED = 'false';
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );
    expect(() => service.assertAvailable('user-1')).toThrow(ServiceUnavailableException);
  });

  it('requires the authenticated user to be allowlisted', () => {
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );
    expect(() => service.assertAvailable('user-2')).toThrow(ForbiddenException);
    expect(() => service.assertAvailable('user-1')).not.toThrow();
  });

  it('keeps existing results accessible when provider budget is exhausted', () => {
    values.SCANNER_PROVIDER_BUDGET_EXHAUSTED = 'true';
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );
    expect(() => service.assertAvailable('user-1')).not.toThrow();
  });

  it('accepts new work while either enabled engine still has capacity', () => {
    values.SCANNER_PROVIDER_BUDGET_EXHAUSTED = 'true';
    values.SCANNER_TRANSCODA_ENABLED = 'true';
    values.SCANNER_TRANSCODA_PROVIDER_BUDGET_EXHAUSTED = 'false';
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    ) as any;

    expect(service.providerCapacityExhausted()).toBe(false);
    values.SCANNER_TRANSCODA_PROVIDER_BUDGET_EXHAUSTED = 'true';
    expect(service.providerCapacityExhausted()).toBe(true);
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
          musicXml: { bucket: 'aux', objectKey: 'private-key' },
          engines: {
            transcoda: {
              engine: 'transcoda',
              status: 'succeeded',
              attempts: 1,
              idempotencyKey: 'transcoda-secret',
              generation: {
                hitMaxLength: true,
                sawEos: false,
                truncated: true,
                maxLength: 2048,
                numBeams: 3
              },
              artifacts: {}
            },
            'audiveris-5': {
              engine: 'audiveris-5',
              status: 'succeeded',
              attempts: 1,
              idempotencyKey: 'audiveris-secret',
              artifacts: { musicXml: { bucket: 'aux', objectKey: 'audiveris-private-key' } }
            }
          }
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
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );
    const { items } = await service.listJobs('user-1');
    const [result] = items;
    expect(result.hasMusicXml).toBe(true);
    expect(result.pages[0].effectiveEngineId).toBe('homr');
    expect(result.pages[0].engines.homr).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      hasMusicXml: true
    });
    expect(result.pages[0].engines.transcoda.generation).toMatchObject({
      truncated: true,
      maxLength: 2048
    });
    expect(result.pages[0].engines['audiveris-5']).toMatchObject({
      status: 'succeeded',
      artifactKinds: ['musicxml']
    });
    expect(result.pages[0]).not.toHaveProperty('idempotencyKey');
    expect(result.pages[0].engines.homr).not.toHaveProperty('idempotencyKey');
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(JSON.stringify(result)).not.toContain('private-source');
    expect(JSON.stringify(result)).not.toContain('private-multi-source');
    expect(JSON.stringify(result)).not.toContain('private-page.png');

    (document as any).enginePlan = scannerEnginePlan(
      ['audiveris-5', 'homr', 'transcoda'],
      'audiveris-5'
    );
    const planned = await service.listJobs('user-1');
    expect(planned.items[0].pages[0].effectiveEngineId).toBe('audiveris-5');
  });

  it('serves explicit per-engine Transcoda MusicXML and kern artifacts', async () => {
    const transcodaMusicXml = {
      bucket: 'scanner',
      objectKey: 'page-001-transcoda.musicxml',
      contentType: 'application/vnd.recordare.musicxml+xml'
    };
    const transcodaKern = {
      bucket: 'scanner',
      objectKey: 'page-001-transcoda.krn',
      contentType: 'text/plain; charset=utf-8'
    };
    const job: any = {
      jobId: 'job-1',
      userId: 'user-1',
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          status: 'succeeded',
          attempts: 1,
          idempotencyKey: 'homr-key',
          engines: {
            transcoda: {
              engine: 'transcoda',
              status: 'succeeded',
              attempts: 1,
              idempotencyKey: 'transcoda-key',
              artifacts: { musicXml: transcodaMusicXml, kern: transcodaKern }
            }
          }
        }
      ]
    };
    const bodies: Record<string, Buffer> = {
      [transcodaMusicXml.objectKey]: Buffer.from('<score-partwise/>'),
      [transcodaKern.objectKey]: Buffer.from('**kern\n4c\n*-\n')
    };
    const engineStorage = {
      getObjectStream: jest.fn(async (_bucket: string, objectKey: string) =>
        Readable.from([bodies[objectKey]])
      )
    } as any;
    const service = new ScannerService(
      { findOne: () => ({ exec: async () => job }) } as any,
      corrections,
      engineStorage,
      provider,
      telemetry,
      alerts,
      config
    );

    const musicXml = await service.getArtifact('user-1', 'job-1', 'musicxml', 1, 'transcoda');
    const kern = await service.getArtifact('user-1', 'job-1', 'kern', 1, 'transcoda');

    expect(musicXml.filename).toBe('scan-page-1-transcoda.musicxml');
    expect((await readStream(musicXml.stream)).toString()).toBe('<score-partwise/>');
    expect(kern.filename).toBe('scan-page-1-transcoda.krn');
    expect((await readStream(kern.stream)).toString()).toBe('**kern\n4c\n*-\n');
    await expect(service.getArtifact('user-1', 'job-1', 'kern', 1)).rejects.toThrow(
      BadRequestException
    );
    await expect(
      service.getArtifact('user-1', 'job-1', 'musicxml', undefined, 'transcoda')
    ).rejects.toThrow(BadRequestException);
  });

  it('serves a registry-planned third engine and its declared native artifact', async () => {
    const mei = {
      bucket: 'scanner',
      objectKey: 'page-001-audiveris.mei',
      contentType: 'application/mei+xml'
    };
    const capabilities = {
      displayName: 'Audiveris 5',
      outputArtifactKinds: ['musicxml', 'mei'],
      supportsSpotReview: false,
      supportsMeasureGeometry: true,
      unsupportedSemanticClasses: []
    };
    const definition: ScannerEngineDefinition = {
      id: 'audiveris-5',
      displayName: 'Audiveris 5',
      adapter: { engine: 'audiveris-5' } as any,
      readable: true,
      enabledForNewJobs: () => true,
      budgetExhaustedConfigKey: 'SCANNER_AUDIVERIS_BUDGET_EXHAUSTED',
      providerKindConfigKey: 'SCANNER_AUDIVERIS_PROVIDER_KIND',
      timeoutConfigKey: 'SCANNER_AUDIVERIS_TIMEOUT_MS',
      capabilities,
      artifacts: {
        musicxml: {
          contentType: 'application/vnd.recordare.musicxml+xml',
          extension: 'musicxml',
          maxBytes: 10_485_760,
          requiredProviderOutput: true
        },
        mei: {
          contentType: 'application/mei+xml',
          extension: 'mei',
          maxBytes: 10_485_760,
          requiredProviderOutput: true
        }
      }
    };
    const registry = new ScannerEngineRegistry(config, provider, { engine: 'transcoda' } as any);
    registry.register(definition);
    const job: any = {
      jobId: 'job-1',
      userId: 'user-1',
      pageCount: 1,
      enginePlan: scannerEnginePlan(['homr', 'audiveris-5'], 'homr', {
        'audiveris-5': capabilities
      }),
      pages: [
        {
          pageNumber: 1,
          status: 'succeeded',
          attempts: 1,
          idempotencyKey: 'homr-key',
          engines: {
            'audiveris-5': {
              engine: 'audiveris-5',
              status: 'succeeded',
              attempts: 1,
              idempotencyKey: 'audiveris-key',
              artifacts: { mei }
            }
          }
        }
      ]
    };
    const engineStorage = {
      getObjectStream: jest.fn(async () => Readable.from(['<mei/>']))
    } as any;
    const service = new ScannerService(
      { findOne: () => ({ exec: async () => job }) } as any,
      corrections,
      engineStorage,
      provider,
      telemetry,
      alerts,
      config,
      registry
    );

    const artifact = await service.getArtifact('user-1', 'job-1', 'mei', 1, 'audiveris-5');
    expect(artifact.filename).toBe('scan-page-1-audiveris-5.mei');
    expect((await readStream(artifact.stream)).toString()).toBe('<mei/>');
    await expect(service.getArtifact('user-1', 'job-1', 'mei', 1, 'transcoda')).rejects.toThrow(
      BadRequestException
    );
    await expect(
      service.getArtifact('user-1', 'job-1', '../mei', 1, 'audiveris-5')
    ).rejects.toThrow(BadRequestException);
  });

  it('compares the selected reviewed and raw engine artifacts through the live pipeline', async () => {
    const score = (partId: string, voice: number) =>
      Buffer.from(
        `<score-partwise><part-list><score-part id="${partId}"><part-name>Cello</part-name></score-part></part-list><part id="${partId}"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>${voice}</voice><staff>1</staff></note></measure></part></score-partwise>`
      );
    const reviewedHomr = score('P1', 1);
    const rawTranscoda = score('T9', 2);
    const checksum = (body: Buffer) => createHash('sha256').update(body).digest('hex');
    const recognitionImage = await sharp({
      create: { width: 100, height: 50, channels: 3, background: '#ffffff' }
    })
      .png()
      .toBuffer();
    const raster = {
      checksumSha256: checksum(recognitionImage),
      width: 100,
      height: 50
    };
    const locator = (objectKey: string, body: Buffer) => ({
      bucket: 'scanner',
      objectKey,
      checksumSha256: checksum(body),
      sizeBytes: body.length,
      contentType: 'application/vnd.recordare.musicxml+xml'
    });
    const reviewedLocator = locator('homr-reviewed.musicxml', reviewedHomr);
    const candidateLocator = locator('transcoda.musicxml', rawTranscoda);
    const job: any = {
      jobId: 'job-1',
      userId: 'user-1',
      statusVersion: 7,
      pageCount: 1,
      enginePlan: scannerEnginePlan(['homr', 'transcoda']),
      pages: [
        {
          pageNumber: 1,
          status: 'succeeded',
          recognitionRaster: {
            ...raster,
            storage: { bucket: 'scanner', objectKey: 'recognition.png' }
          },
          engines: {
            homr: {
              engine: 'homr',
              status: 'succeeded',
              attempts: 1,
              idempotencyKey: 'homr-key',
              recognitionRaster: raster,
              modelRevision: 'abcdef0',
              artifacts: { musicXml: locator('homr-raw.musicxml', score('P1', 3)) },
              reviewedMusicXml: reviewedLocator,
              review: {
                staves: [
                  {
                    index: 0,
                    region: [0, 0, 100, 50],
                    barLines: [0, 100],
                    tokens: [['note_4', 'C4', '_', '_', '_', 'upper']],
                    symbols: []
                  }
                ]
              }
            },
            transcoda: {
              engine: 'transcoda',
              status: 'succeeded',
              attempts: 1,
              idempotencyKey: 'transcoda-key',
              recognitionRaster: raster,
              completeness: 'complete',
              artifacts: { musicXml: candidateLocator }
            }
          }
        }
      ]
    };
    const bodies: Record<string, Buffer> = {
      [reviewedLocator.objectKey]: reviewedHomr,
      [candidateLocator.objectKey]: rawTranscoda,
      'recognition.png': recognitionImage
    };
    const comparisonStorage = {
      getObjectBuffer: jest.fn(async (_bucket: string, objectKey: string) => bodies[objectKey])
    } as any;
    const registry = new ScannerEngineRegistry(config, provider, { engine: 'transcoda' } as any);
    const service = new ScannerService(
      { findOne: () => ({ exec: async () => job }) } as any,
      corrections,
      comparisonStorage,
      provider,
      telemetry,
      alerts,
      config,
      registry
    );

    const result = await service.pageComparison('user-1', 'job-1', 1, 'homr', 'transcoda');

    expect(result).toMatchObject({
      status: 'ready',
      statusVersion: 7,
      base: { artifactChecksumSha256: reviewedLocator.checksumSha256 },
      candidate: { artifactChecksumSha256: candidateLocator.checksumSha256 },
      geometry: { status: 'ready' }
    });
    expect(comparisonStorage.getObjectBuffer.mock.calls).toEqual([
      ['scanner', 'homr-reviewed.musicxml'],
      ['scanner', 'transcoda.musicxml']
    ]);

    // The renderer needs which measures differ and nothing about how to draw
    // them. Each side carries its own part index, because a part matched across
    // engines need not sit at the same ordinal in both documents.
    const regions = await service.pageComparisonRegions(
      'user-1',
      'job-1',
      1,
      'homr',
      'transcoda'
    );
    expect(regions).toMatchObject({
      version: 'scanner-compare-regions-v1',
      statusVersion: 7,
      // Highlighting depends on the analysis, not on page-wide geometry: a page
      // is refused when any one block's location cannot be proven, and
      // withholding every highlight for that would be wrong.
      analysisStatus: 'succeeded',
      left: { engineId: 'homr' },
      right: { engineId: 'transcoda' }
    });
    expect(regions.regions.length).toBe(result.analysis.blocks.length);
    for (const region of regions.regions) {
      expect(Array.isArray(region.leftMeasureIndexes)).toBe(true);
      expect(Array.isArray(region.rightMeasureIndexes)).toBe(true);
      expect(typeof region.contentSignature).toBe('string');
      expect(typeof region.grounded).toBe('boolean');
    }
    const reading = await service.pageComparisonReading(
      'user-1',
      'job-1',
      1,
      'homr',
      result.statusVersion,
      result.base.artifactChecksumSha256
    );
    expect(reading).toEqual({
      body: reviewedHomr,
      contentType: 'application/vnd.recordare.musicxml+xml'
    });
    await expect(
      service.pageComparisonReading(
        'user-1',
        'job-1',
        1,
        'homr',
        result.statusVersion,
        job.pages[0].engines.homr.artifacts.musicXml.checksumSha256
      )
    ).rejects.toThrow('reading changed');
    comparisonStorage.getObjectBuffer.mockClear();
    const groundedBlock = result.geometry.blocks[0].block;
    const crop = await service.pageComparisonBlockCrop(
      'user-1',
      'job-1',
      1,
      groundedBlock.blockIndex,
      'homr',
      'transcoda',
      result.statusVersion,
      groundedBlock.contentSignature,
      result.geometry.geometrySignature
    );
    await expect(sharp(crop.body).metadata()).resolves.toMatchObject({
      format: 'png',
      width: 100,
      height: 50
    });
    expect(comparisonStorage.getObjectBuffer.mock.calls).toEqual([
      ['scanner', 'homr-reviewed.musicxml'],
      ['scanner', 'transcoda.musicxml'],
      ['scanner', 'recognition.png']
    ]);
    const partialComparison = jest
      .spyOn(service as any, 'pageComparisonForJob')
      .mockResolvedValue({
        ...result,
        status: 'refused',
        refusalReasons: [{ stage: 'geometry', code: 'missing-measure-reference' }],
        geometry: {
          ...result.geometry,
          status: 'refused',
          refusalReasons: [{ code: 'missing-measure-reference' }],
          blocks: [
            result.geometry.blocks[0],
            {
              status: 'refused',
              block: { ...groundedBlock, blockIndex: groundedBlock.blockIndex + 1 },
              refusalReasons: [{ code: 'missing-measure-reference' }]
            }
          ]
        }
      });
    const partialCrop = await service.pageComparisonBlockCrop(
      'user-1',
      'job-1',
      1,
      groundedBlock.blockIndex,
      'homr',
      'transcoda',
      result.statusVersion,
      groundedBlock.contentSignature,
      result.geometry.geometrySignature
    );
    await expect(sharp(partialCrop.body).metadata()).resolves.toMatchObject({
      format: 'png',
      width: 100,
      height: 50
    });
    partialComparison.mockRestore();
    const montage = await (service as any).renderComparisonBlockCrop(recognitionImage, raster, [
      { systemIndex: 0, staffIndices: [0], region: [0, 0, 100, 20] },
      { systemIndex: 1, staffIndices: [1], region: [0, 30, 100, 50] }
    ]);
    await expect(sharp(montage).metadata()).resolves.toMatchObject({
      format: 'png',
      width: 100,
      height: 72
    });
    await expect(
      (service as any).renderComparisonBlockCrop(
        recognitionImage,
        { ...raster, checksumSha256: '0'.repeat(64) },
        [{ systemIndex: 0, staffIndices: [0], region: [0, 0, 100, 20] }]
      )
    ).rejects.toThrow('recognition raster changed');
    await expect(
      service.pageComparisonBlockCrop(
        'user-1',
        'job-1',
        1,
        groundedBlock.blockIndex,
        'homr',
        'transcoda',
        result.statusVersion - 1,
        groundedBlock.contentSignature,
        result.geometry.geometrySignature
      )
    ).rejects.toThrow('refresh and try again');
    await expect(
      service.pageComparisonBlockCrop(
        'user-1',
        'job-1',
        1,
        groundedBlock.blockIndex,
        'homr',
        'transcoda',
        result.statusVersion,
        `scanner-block-content-v2:${'f'.repeat(64)}`,
        result.geometry.geometrySignature
      )
    ).rejects.toThrow('block changed');
    await expect(
      service.pageComparisonBlockCrop(
        'user-1',
        'job-1',
        1,
        groundedBlock.blockIndex,
        'homr',
        'transcoda',
        result.statusVersion,
        groundedBlock.contentSignature,
        `scanner-measure-geometry-v1:${'f'.repeat(64)}`
      )
    ).rejects.toThrow('geometry changed');
    bodies[reviewedLocator.objectKey] = Buffer.from('overwritten');
    await expect(
      service.pageComparisonReading(
        'user-1',
        'job-1',
        1,
        'homr',
        result.statusVersion,
        result.base.artifactChecksumSha256
      )
    ).rejects.toThrow('reading changed');
  });

  it('explicitly refuses comparison for a retained job without raster identities', async () => {
    const artifact = (engine: string) => ({
      bucket: 'scanner',
      objectKey: `${engine}.musicxml`,
      checksumSha256: engine === 'homr' ? 'a'.repeat(64) : 'b'.repeat(64)
    });
    const job: any = {
      jobId: 'legacy-job',
      userId: 'user-1',
      pageCount: 1,
      enginePlan: scannerEnginePlan(['homr', 'transcoda']),
      pages: [
        {
          pageNumber: 1,
          status: 'succeeded',
          engines: {
            homr: {
              engine: 'homr',
              status: 'succeeded',
              attempts: 1,
              idempotencyKey: 'homr-key',
              artifacts: { musicXml: artifact('homr') }
            },
            transcoda: {
              engine: 'transcoda',
              status: 'succeeded',
              attempts: 1,
              idempotencyKey: 'transcoda-key',
              artifacts: { musicXml: artifact('transcoda') }
            }
          }
        }
      ]
    };
    const comparisonStorage = { getObjectBuffer: jest.fn() } as any;
    const service = new ScannerService(
      { findOne: () => ({ exec: async () => job }) } as any,
      corrections,
      comparisonStorage,
      provider,
      telemetry,
      alerts,
      config
    );

    await expect(
      service.pageComparison('user-1', 'legacy-job', 1, 'homr', 'transcoda')
    ).resolves.toMatchObject({
      status: 'refused',
      refusalReasons: [{ code: 'recognition-raster-unavailable' }]
    });
    expect(comparisonStorage.getObjectBuffer).not.toHaveBeenCalled();
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
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );
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
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );
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
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );
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
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );
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
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );
    await expect(service.retryPage('user-1', 'job-1', 1)).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not offer a PDF retry for a deterministically failed HOMR rescue', () => {
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    ) as any;
    const job = {
      status: 'succeeded',
      pageCount: 1,
      sourceExpiresAt: new Date(Date.now() + 60_000)
    };
    const page = {
      pageNumber: 1,
      status: 'succeeded',
      engines: {
        homr: { status: 'failed', errorCode: 'invalid_musicxml' },
        transcoda: { status: 'succeeded' }
      }
    };

    expect(service.pageRetryEligibility(job, 1, page)).toMatchObject({ allowed: false });
    page.engines.homr.errorCode = 'provider_timeout';
    expect(service.pageRetryEligibility(job, 1, page)).toMatchObject({ allowed: true });
  });

  it('uses the persisted primary engine when deciding whether a rescued page can retry', () => {
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    ) as any;
    const job = {
      status: 'succeeded',
      pageCount: 1,
      sourceExpiresAt: new Date(Date.now() + 60_000),
      enginePlan: scannerEnginePlan(['audiveris-5', 'transcoda'], 'audiveris-5')
    };
    const page = {
      pageNumber: 1,
      status: 'succeeded',
      engines: {
        'audiveris-5': { status: 'failed', errorCode: 'invalid_musicxml' },
        transcoda: { status: 'succeeded' }
      }
    };

    expect(service.pageRetryEligibility(job, 1, page)).toMatchObject({ allowed: false });
    page.engines['audiveris-5'].errorCode = 'provider_timeout';
    expect(service.pageRetryEligibility(job, 1, page)).toMatchObject({ allowed: true });
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
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );
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
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );

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
    const service = new ScannerService(
      jobs,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );

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

describe('reviewed artifacts', () => {
  const values: Record<string, string> = {
    SCANNER_ENABLED: 'true',
    SCANNER_BETA_USER_IDS: '*'
  };
  const config = {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback)
  } as any;
  const telemetry = {
    emit: jest.fn(),
    userHash: jest.fn(() => 'user-hash'),
    trackJobCreated: jest.fn().mockResolvedValue(undefined)
  } as any;
  const alerts = { evaluate: jest.fn().mockResolvedValue([]) } as any;

  const locator = (objectKey: string, checksumSha256: string, contentType: string) => ({
    bucket: 'derivatives',
    objectKey,
    checksumSha256,
    contentType,
    sizeBytes: 1
  });

  it('builds job downloads from effective pages and withholds stale renders', async () => {
    const rawOne = locator('raw-1.musicxml', 'raw-one', 'application/xml');
    const reviewedOne = locator('reviewed-1.musicxml', 'reviewed-one', 'application/xml');
    const rawTwo = locator('raw-2.musicxml', 'raw-two', 'application/xml');
    const pdfOne = locator('raw-1.pdf', 'pdf-one', 'application/pdf');
    const pdfTwo = locator('raw-2.pdf', 'pdf-two', 'application/pdf');
    const job: any = {
      _id: 'j',
      jobId: 'job-1',
      userId: 'user-1',
      status: 'succeeded',
      statusVersion: 1,
      originalFilename: 'score.pdf',
      pageCount: 2,
      pages: [
        {
          pageNumber: 1,
          ordinal: 1,
          rotationDegrees: 0,
          included: true,
          status: 'succeeded',
          attempts: 1,
          musicXml: rawOne,
          reviewedMusicXml: reviewedOne,
          pdf: pdfOne
        },
        {
          pageNumber: 2,
          ordinal: 2,
          rotationDegrees: 0,
          included: true,
          status: 'succeeded',
          attempts: 1,
          musicXml: rawTwo,
          pdf: pdfTwo
        }
      ],
      musicXmlBundle: locator('raw-pages.zip', 'raw-bundle', 'application/zip'),
      resultsZip: locator('raw-results.zip', 'raw-results', 'application/zip'),
      combinedMusicXml: locator('raw-combined.musicxml', 'raw-combined', 'application/xml'),
      combinedPdf: locator('raw-combined.pdf', 'raw-combined-pdf', 'application/pdf'),
      previewPdf: locator('raw-preview.pdf', 'raw-preview', 'application/pdf'),
      mergeStatus: 'succeeded',
      createdAt: new Date(),
      updatedAt: new Date(),
      resultExpiresAt: new Date(Date.now() + 60_000)
    };
    const objects = new Map<string, Buffer>([
      [reviewedOne.objectKey, Buffer.from('<reviewed-one/>')],
      [rawTwo.objectKey, Buffer.from('<raw-two/>')],
      [pdfTwo.objectKey, Buffer.from('pdf-two')]
    ]);
    const storage = {
      getObjectBuffer: jest.fn(async (_bucket: string, objectKey: string) => {
        const body = objects.get(objectKey);
        if (!body) throw new Error(`Unexpected stale object read: ${objectKey}`);
        return body;
      }),
      getObjectStream: jest.fn(async (_bucket: string, objectKey: string) => {
        const body = objects.get(objectKey);
        if (!body) throw new Error(`Unexpected stale object stream: ${objectKey}`);
        return Readable.from([body]);
      })
    } as any;
    const jobsModel: any = {
      findOne: () => ({ exec: async () => job })
    };
    const service = new ScannerService(
      jobsModel,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );

    const pageArtifact = await service.getArtifact('user-1', 'job-1', 'musicxml', 1);
    expect((await readStream(pageArtifact.stream)).toString()).toBe('<reviewed-one/>');

    const bundleArtifact = await service.getArtifact('user-1', 'job-1', 'musicxml');
    const bundle = new AdmZip(await readStream(bundleArtifact.stream));
    expect(bundleArtifact.filename).toBe('scan-musicxml-pages.zip');
    expect(bundle.readAsText('page-001.musicxml')).toBe('<reviewed-one/>');
    expect(bundle.readAsText('page-002.musicxml')).toBe('<raw-two/>');

    const resultsArtifact = await service.getArtifact('user-1', 'job-1', 'zip');
    const results = new AdmZip(await readStream(resultsArtifact.stream));
    expect(results.readAsText('page-001.musicxml')).toBe('<reviewed-one/>');
    expect(results.readAsText('page-002.musicxml')).toBe('<raw-two/>');
    expect(results.getEntry('page-001.pdf')).toBeNull();
    expect(results.readAsText('page-002.pdf')).toBe('pdf-two');
    expect(results.getEntry('combined.musicxml')).toBeNull();
    const manifest = JSON.parse(results.readAsText('scanner-manifest.json'));
    expect(manifest.pages[0]).toMatchObject({
      musicXmlSha256: 'reviewed-one'
    });
    expect(manifest.inputSignature).toMatch(/^scanner-artifact-input-v1:/);
    expect(manifest.pages[0].pdfSha256).toBeUndefined();

    await expect(service.getArtifact('user-1', 'job-1', 'pdf', 1)).rejects.toThrow(
      'Artifact is not available'
    );
    await expect(service.getArtifact('user-1', 'job-1', 'pdf')).rejects.toThrow(
      'Artifact is not available'
    );

    const presented = await service.getJob('user-1', 'job-1');
    expect(presented.pages[0].hasPdf).toBe(false);
    expect(presented.hasPdf).toBe(false);
    expect(presented.hasThumbnail).toBe(false);
    expect(presented.hasCombinedMusicXml).toBe(false);
    expect(presented.hasCombinedPdf).toBe(false);
    expect(storage.getObjectStream).not.toHaveBeenCalledWith('derivatives', 'raw-pages.zip');
    expect(storage.getObjectStream).not.toHaveBeenCalledWith('derivatives', 'raw-results.zip');
  });

  it('serves a reviewed single page instead of its pre-review bundle locator', async () => {
    const raw = locator('raw.musicxml', 'raw', 'application/xml');
    const reviewed = locator('reviewed.musicxml', 'reviewed', 'application/xml');
    const job: any = {
      _id: 'j',
      jobId: 'job-1',
      userId: 'user-1',
      status: 'succeeded',
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          ordinal: 1,
          included: true,
          status: 'succeeded',
          attempts: 1,
          musicXml: raw,
          reviewedMusicXml: reviewed
        }
      ],
      musicXmlBundle: raw
    };
    const storage = {
      getObjectStream: jest.fn(async (_bucket: string, objectKey: string) => {
        if (objectKey !== reviewed.objectKey) throw new Error(`Stale object read: ${objectKey}`);
        return Readable.from([Buffer.from('<reviewed/>')]);
      })
    } as any;
    const service = new ScannerService(
      { findOne: () => ({ exec: async () => job }) } as any,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );

    const artifact = await service.getArtifact('user-1', 'job-1', 'musicxml');
    expect(artifact.filename).toBe('scan.musicxml');
    expect((await readStream(artifact.stream)).toString()).toBe('<reviewed/>');
    expect(storage.getObjectStream).toHaveBeenCalledWith('derivatives', 'reviewed.musicxml');
  });

  it('serves one contributing page as a score, however many the upload had', async () => {
    // A three-page upload with two pages excluded still has exactly one score.
    // Counting `pageCount` here rather than the pages that contribute handed
    // the editor a one-entry zip named `.musicxml`, which webmscore opened as
    // `File "" is corrupted` — from the button that says "open the finished
    // score".
    const only = locator('page-1.musicxml', 'page-1', 'application/xml');
    const job: any = {
      jobId: 'job-1',
      userId: 'user-1',
      status: 'succeeded',
      pageCount: 3,
      pages: [
        {
          pageNumber: 1,
          ordinal: 1,
          included: true,
          status: 'succeeded',
          attempts: 1,
          musicXml: only
        },
        { pageNumber: 2, ordinal: 2, included: false, status: 'skipped', attempts: 0 },
        { pageNumber: 3, ordinal: 3, included: false, status: 'skipped', attempts: 0 }
      ]
    };
    const storage = {
      getObjectStream: jest.fn(async () => Readable.from([Buffer.from('<score-partwise/>')]))
    } as any;
    const service = new ScannerService(
      { findOne: () => ({ exec: async () => job }) } as any,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );

    const artifact = await service.getArtifact('user-1', 'job-1', 'musicxml');
    expect(artifact.filename).toBe('scan.musicxml');
    expect(artifact.contentType).not.toBe('application/zip');
    expect((await readStream(artifact.stream)).toString()).toBe('<score-partwise/>');
  });

  it('rejects signed derivatives whose page-input signature no longer matches', async () => {
    const raw = locator('current.musicxml', 'current-page', 'application/xml');
    const signedAgainstOldPage = (objectKey: string, contentType: string, builder: string) =>
      withScannerArtifactInputSignature(
        locator(objectKey, `artifact-${objectKey}`, contentType),
        builder,
        [{ ordinal: 1, checksumSha256: 'old-page' }]
      );
    const job: any = {
      _id: 'j',
      jobId: 'job-1',
      userId: 'user-1',
      status: 'succeeded',
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          ordinal: 1,
          included: true,
          status: 'succeeded',
          attempts: 1,
          musicXml: raw,
          pdf: signedAgainstOldPage(
            'stale-page.pdf',
            'application/pdf',
            SCANNER_ARTIFACT_BUILDERS.pagePdf
          )
        }
      ],
      musicXmlBundle: signedAgainstOldPage(
        'stale-bundle.zip',
        'application/zip',
        SCANNER_ARTIFACT_BUILDERS.musicXmlBundle
      ),
      resultsZip: signedAgainstOldPage(
        'stale-results.zip',
        'application/zip',
        SCANNER_ARTIFACT_BUILDERS.resultsZip
      ),
      combinedMusicXml: signedAgainstOldPage(
        'stale-combined.musicxml',
        'application/xml',
        SCANNER_ARTIFACT_BUILDERS.combinedMusicXml
      ),
      combinedPdf: signedAgainstOldPage(
        'stale-combined.pdf',
        'application/pdf',
        SCANNER_ARTIFACT_BUILDERS.combinedPdf
      ),
      previewPdf: signedAgainstOldPage(
        'stale-preview.pdf',
        'application/pdf',
        SCANNER_ARTIFACT_BUILDERS.previewPdf
      ),
      previewThumbnail: signedAgainstOldPage(
        'stale-preview.png',
        'image/png',
        SCANNER_ARTIFACT_BUILDERS.previewThumbnail
      )
    };
    const storage = {
      getObjectBuffer: jest.fn(async (_bucket: string, objectKey: string) => {
        if (objectKey !== raw.objectKey) throw new Error(`Stale object read: ${objectKey}`);
        return Buffer.from('<current/>');
      }),
      getObjectStream: jest.fn(async (_bucket: string, objectKey: string) => {
        if (objectKey !== raw.objectKey) throw new Error(`Stale object stream: ${objectKey}`);
        return Readable.from([Buffer.from('<current/>')]);
      })
    } as any;
    const service = new ScannerService(
      { findOne: () => ({ exec: async () => job }) } as any,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );

    const musicXml = await service.getArtifact('user-1', 'job-1', 'musicxml');
    expect((await readStream(musicXml.stream)).toString()).toBe('<current/>');

    const results = new AdmZip(
      await readStream((await service.getArtifact('user-1', 'job-1', 'zip')).stream)
    );
    expect(results.readAsText('page-001.musicxml')).toBe('<current/>');
    expect(results.getEntry('page-001.pdf')).toBeNull();

    await expect(service.getArtifact('user-1', 'job-1', 'pdf', 1)).rejects.toThrow(
      'Artifact is not available'
    );
    await expect(service.getArtifact('user-1', 'job-1', 'pdf')).rejects.toThrow(
      'Artifact is not available'
    );
    await expect(service.getArtifact('user-1', 'job-1', 'thumbnail')).rejects.toThrow(
      'Artifact is not available'
    );

    const presented = await service.getJob('user-1', 'job-1');
    expect(presented.pages[0].hasPdf).toBe(false);
    expect(presented.hasPdf).toBe(false);
    expect(presented.hasCombinedMusicXml).toBe(false);
    expect(presented.hasCombinedPdf).toBe(false);
  });
});

describe('corrections', () => {
  // Scoped locally: the stubs above belong to the other describe block.
  const values: Record<string, string> = {
    SCANNER_ENABLED: 'true',
    SCANNER_BETA_USER_IDS: '*',
    SCANNER_TRAINING_POLICY_VERSION: '2026-08-10'
  };
  const config = {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback)
  } as any;
  const alerts = { evaluate: jest.fn().mockResolvedValue([]) } as any;
  const telemetry = {
    emit: jest.fn(),
    userHash: jest.fn(() => 'user-hash'),
    trackJobCreated: jest.fn().mockResolvedValue(undefined)
  } as any;

  function pageWith(tokens: string[][]) {
    return {
      pageNumber: 1,
      status: 'succeeded',
      sourceImage: {
        bucket: 'raw',
        objectKey: 'k',
        checksumSha256: 'abc',
        sizeBytes: 1,
        contentType: 'image/png'
      },
      musicXml: {
        bucket: 'd',
        objectKey: 'm',
        checksumSha256: 'x',
        sizeBytes: 1,
        contentType: 'application/xml'
      },
      review: {
        staves: [
          {
            index: 0,
            region: [0, 0, 10, 10],
            tokens,
            symbols: [
              {
                index: 1,
                heads: {
                  pitch: {
                    chosen: 'C4',
                    confidence: 0.45,
                    alternatives: [{ value: 'D4', confidence: 0.4 }]
                  }
                }
              }
            ]
          }
        ]
      }
    };
  }

  const reviewSignature = (page: any) => scannerEngineReviewContentSignature(scannerHomrRun(page));

  it('edits the token the reviewer decided about and rebuilds from it', async () => {
    // The XML is regenerated from symbols, not patched: a rhythm change
    // cascades through its measure and only re-generation stays consistent.
    const tokens = [
      ['clef_G2', '.', '_', '_', '_', 'upper'],
      ['note_4', 'C4', '_', '_', '_', 'upper']
    ];
    const job: any = { _id: 'j', jobId: 'job-1', pages: [pageWith(tokens)] };
    const jobsModel: any = {
      findOne: () => ({ exec: async () => job }),
      updateOne: () => ({ exec: async () => ({}) })
    };
    provider.regenerate.mockClear();
    corrections.create.mockClear();

    const service = new ScannerService(
      jobsModel,
      corrections,
      {
        putDerivativeObject: async () => ({ bucket: 'd', objectKey: 'o', checksumSha256: 'y' }),
        deleteObject: async () => undefined
      } as any,
      provider,
      telemetry,
      alerts,
      config
    );
    const result = await service.applyCorrection(
      'user-1',
      'job-1',
      1,
      0,
      'D4',
      'homr',
      reviewSignature(job.pages[0])
    );

    expect(result.outcome).toBe('corrected');
    // Field index 1 is pitch; the clef is untouched.
    expect(provider.regenerate.mock.calls[0][0][0][1][1]).toBe('D4');
    expect(provider.regenerate.mock.calls[0][0][0][0][1]).toBe('.');
  });

  it('asks for a rebuild so a correction does not strand the download', async () => {
    // Assembly runs when scanning finishes and review happens afterwards, so a
    // correction invalidates the page PDF and everything built from it. Reads
    // withhold those rather than serve them stale, which without this would
    // leave the reviewer's correction quietly removing their own download.
    const tokens = [
      ['clef_G2', '.', '_', '_', '_', 'upper'],
      ['note_4', 'C4', '_', '_', '_', 'upper']
    ];
    const page = pageWith(tokens);
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const writes: any[] = [];
    const jobsModel: any = {
      findOne: () => ({ exec: async () => job }),
      updateOne: (_filter: any, update: any) => {
        writes.push(update);
        return { exec: async () => ({ matchedCount: 1 }) };
      }
    };
    const service = new ScannerService(
      jobsModel,
      corrections,
      {
        putDerivativeObject: async () => ({ bucket: 'd', objectKey: 'o', checksumSha256: 'y' }),
        deleteObject: async () => undefined
      } as any,
      provider,
      telemetry,
      alerts,
      config
    );

    await service.applyCorrection('user-1', 'job-1', 1, 0, 'D4', 'homr', reviewSignature(page));
    expect(writes[0].$set.reassembleRequestedAt).toBeInstanceOf(Date);
  });

  it('does not ask for a rebuild while the job is still running', async () => {
    const tokens = [
      ['clef_G2', '.', '_', '_', '_', 'upper'],
      ['note_4', 'C4', '_', '_', '_', 'upper']
    ];
    const page = pageWith(tokens);
    const job: any = { _id: 'j', jobId: 'job-1', status: 'running', pages: [page] };
    const writes: any[] = [];
    const jobsModel: any = {
      findOne: () => ({ exec: async () => job }),
      updateOne: (_filter: any, update: any) => {
        writes.push(update);
        return { exec: async () => ({ matchedCount: 1 }) };
      }
    };
    const service = new ScannerService(
      jobsModel,
      corrections,
      {
        putDerivativeObject: async () => ({ bucket: 'd', objectKey: 'o', checksumSha256: 'y' }),
        deleteObject: async () => undefined
      } as any,
      provider,
      telemetry,
      alerts,
      config
    );

    await service.applyCorrection('user-1', 'job-1', 1, 0, 'D4', 'homr', reviewSignature(page));
    expect(writes[0].$set.reassembleRequestedAt).toBeUndefined();
  });

  it('reassembles physical systems into the original MusicXML part', async () => {
    const firstSystem = [
      ['clef_G2', '.', '_', '_', '_', 'upper'],
      ['note_4', 'C4', '_', '_', '_', 'upper']
    ];
    const secondSystem = [['note_4', 'E4', '_', '_', '_', 'upper']];
    const page: any = pageWith(firstSystem);
    page.review.staves[0].partIndex = 0;
    page.review.staves[0].systemIndex = 0;
    page.review.staves.push({
      index: 1,
      partIndex: 0,
      systemIndex: 1,
      region: [0, 20, 10, 30],
      tokens: secondSystem,
      symbols: []
    });
    const job: any = { _id: 'j', jobId: 'job-1', pages: [page] };
    const jobsModel: any = {
      findOne: () => ({ exec: async () => job }),
      updateOne: () => ({ exec: async () => ({}) })
    };
    provider.regenerate.mockClear();
    const service = new ScannerService(
      jobsModel,
      corrections,
      {
        putDerivativeObject: async () => ({ bucket: 'd', objectKey: 'o' }),
        deleteObject: async () => undefined
      } as any,
      provider,
      telemetry,
      alerts,
      config
    );

    await service.applyCorrection('user-1', 'job-1', 1, 0, 'D4', 'homr', reviewSignature(page));

    expect(provider.regenerate).toHaveBeenCalledWith([
      [
        firstSystem[0],
        ['note_4', 'D4', '_', '_', '_', 'upper'],
        ['newline', '.', '_', '_', '_', 'upper'],
        secondSystem[0]
      ]
    ]);
  });

  it('refuses ambiguous legacy multi-staff review instead of changing its part structure', async () => {
    const page: any = pageWith([
      ['clef_G2', '.', '_', '_', '_', 'upper'],
      ['note_4', 'C4', '_', '_', '_', 'upper']
    ]);
    page.review.staves.push({
      index: 1,
      region: [0, 20, 10, 30],
      tokens: [['note_4', 'E4', '_', '_', '_', 'upper']],
      symbols: []
    });
    const job: any = { _id: 'j', jobId: 'job-1', pages: [page] };
    const jobsModel: any = {
      findOne: () => ({ exec: async () => job }),
      updateOne: () => ({ exec: async () => ({}) })
    };
    provider.regenerate.mockClear();
    const service = new ScannerService(
      jobsModel,
      corrections,
      {} as any,
      provider,
      telemetry,
      alerts,
      config
    );

    await expect(
      service.applyCorrection('user-1', 'job-1', 1, 0, 'D4', 'homr', reviewSignature(page))
    ).rejects.toThrow(/cannot be regenerated safely/);
    expect(provider.regenerate).not.toHaveBeenCalled();
  });

  it('accumulates corrections instead of discarding the earlier one', async () => {
    // Regenerating from the original tokens each time and keeping only the
    // latest edit silently destroyed every earlier correction — and a later
    // confirmation erased one too, because it regenerates as well.
    const tokens = [
      ['note_4', 'C4', '_', '_', '_', 'upper'],
      ['note_4', 'E4', '_', '_', '_', 'upper']
    ];
    const page: any = {
      pageNumber: 1,
      status: 'succeeded',
      sourceImage: {
        bucket: 'raw',
        objectKey: 'k',
        checksumSha256: 'abc',
        sizeBytes: 1,
        contentType: 'image/png'
      },
      musicXml: {
        bucket: 'd',
        objectKey: 'm',
        checksumSha256: 'x',
        sizeBytes: 1,
        contentType: 'application/xml'
      },
      review: {
        staves: [
          {
            index: 0,
            region: [0, 0, 10, 10],
            tokens,
            symbols: [
              {
                index: 0,
                heads: {
                  pitch: {
                    chosen: 'C4',
                    confidence: 0.45,
                    alternatives: [{ value: 'D4', confidence: 0.4 }]
                  }
                }
              },
              {
                index: 1,
                heads: {
                  pitch: {
                    chosen: 'E4',
                    confidence: 0.46,
                    alternatives: [{ value: 'F4', confidence: 0.4 }]
                  }
                }
              }
            ]
          }
        ]
      }
    };
    const job: any = { _id: 'j', jobId: 'job-1', pages: [page] };
    const jobsModel: any = {
      findOne: () => ({ exec: async () => job }),
      // Apply the $set the way Mongo would, so the second call sees the first.
      updateOne: (_filter: any, update: any) => ({
        exec: async () => {
          if (update.$set?.pages) job.pages = update.$set.pages;
          return {};
        }
      })
    };
    provider.regenerate.mockClear();
    const service = new ScannerService(
      jobsModel,
      corrections,
      {
        putDerivativeObject: async () => ({ bucket: 'd', objectKey: 'o', checksumSha256: 'y' }),
        deleteObject: async () => undefined
      } as any,
      provider,
      telemetry,
      alerts,
      config
    );

    await service.applyCorrection(
      'user-1',
      'job-1',
      1,
      0,
      'D4',
      'homr',
      reviewSignature(job.pages[0])
    );
    await service.applyCorrection(
      'user-1',
      'job-1',
      1,
      1,
      'F4',
      'homr',
      reviewSignature(job.pages[0])
    );

    // The second regeneration must carry both edits, not just its own.
    const second = provider.regenerate.mock.calls[1][0][0];
    expect(second[0][1]).toBe('D4');
    expect(second[1][1]).toBe('F4');
  });

  it('records a confirmation as well as a change', async () => {
    // Agreeing with a 45% prediction says the model was right but unsure —
    // exactly the sample that improves calibration.
    const job: any = {
      _id: 'j',
      jobId: 'job-1',
      pages: [
        pageWith([
          ['clef_G2', '.', '_', '_', '_', 'upper'],
          ['note_4', 'C4', '_', '_', '_', 'upper']
        ])
      ]
    };
    const jobsModel: any = {
      findOne: () => ({ exec: async () => job }),
      updateOne: () => ({ exec: async () => ({}) })
    };
    corrections.create.mockClear();
    const service = new ScannerService(
      jobsModel,
      corrections,
      {
        putDerivativeObject: async () => ({ bucket: 'd', objectKey: 'o', checksumSha256: 'y' }),
        deleteObject: async () => undefined
      } as any,
      provider,
      telemetry,
      alerts,
      config
    );
    const result = await service.applyCorrection(
      'user-1',
      'job-1',
      1,
      0,
      'C4',
      'homr',
      reviewSignature(job.pages[0])
    );
    expect(result.outcome).toBe('confirmed');
    expect(corrections.create).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'confirmed', predicted: 'C4', chosen: 'C4' })
    );
  });

  it('marks pre-review combined artifacts stale while retaining their locators for cleanup', async () => {
    const job: any = {
      _id: 'j',
      jobId: 'job-1',
      combinedMusicXml: { bucket: 'd', objectKey: 'combined.musicxml' },
      combinedPdf: { bucket: 'd', objectKey: 'combined.pdf' },
      pages: [
        pageWith([
          ['clef_G2', '.', '_', '_', '_', 'upper'],
          ['note_4', 'C4', '_', '_', '_', 'upper']
        ])
      ]
    };
    const updates: any[] = [];
    const jobsModel: any = {
      findOne: () => ({ exec: async () => job }),
      updateOne: (_filter: any, update: any) => ({
        exec: async () => {
          updates.push(update);
          return {};
        }
      })
    };
    const service = new ScannerService(
      jobsModel,
      corrections,
      {
        putDerivativeObject: async () => ({
          bucket: 'd',
          objectKey: 'reviewed.musicxml',
          checksumSha256: 'reviewed'
        }),
        deleteObject: async () => undefined
      } as any,
      provider,
      telemetry,
      alerts,
      config
    );

    await expect(
      service.applyCorrection('user-1', 'job-1', 1, 0, 'C4', 'homr', reviewSignature(job.pages[0]))
    ).resolves.toMatchObject({ combinedStale: true });
    expect(updates[0].$set.pages[0].reviewedMusicXml).toMatchObject({
      objectKey: 'reviewed.musicxml',
      sizeBytes: Buffer.byteLength('<score-partwise/>'),
      contentType: 'application/vnd.recordare.musicxml+xml',
      checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(updates[0].$set.combinedStale).toBe(true);
    expect(updates.some((update) => update.$unset?.combinedMusicXml)).toBe(false);
    expect(updates.some((update) => update.$unset?.combinedPdf)).toBe(false);
  });

  it('refuses a value the model never offered', async () => {
    // Anything outside the model's own alternatives is a different edit and
    // belongs in the Score Editor, where it can be seen in context.
    const job: any = {
      _id: 'j',
      jobId: 'job-1',
      pages: [
        pageWith([
          ['clef_G2', '.', '_', '_', '_', 'upper'],
          ['note_4', 'C4', '_', '_', '_', 'upper']
        ])
      ]
    };
    const jobsModel: any = {
      findOne: () => ({ exec: async () => job }),
      updateOne: () => ({ exec: async () => ({}) })
    };
    const service = new ScannerService(
      jobsModel,
      corrections,
      {} as any,
      provider,
      telemetry,
      alerts,
      config
    );
    await expect(
      service.applyCorrection('user-1', 'job-1', 1, 0, 'G9', 'homr', reviewSignature(job.pages[0]))
    ).rejects.toThrow(/not one of the offered/);
  });

  it('rejects a correction taken against an older engine result', async () => {
    const job: any = {
      _id: 'j',
      jobId: 'job-1',
      pages: [
        pageWith([
          ['clef_G2', '.', '_', '_', '_', 'upper'],
          ['note_4', 'C4', '_', '_', '_', 'upper']
        ])
      ]
    };
    const jobsModel: any = {
      findOne: () => ({ exec: async () => job }),
      updateOne: jest.fn()
    };
    const storage = { putDerivativeObject: jest.fn(), deleteObject: jest.fn() } as any;
    provider.regenerate.mockClear();
    const service = new ScannerService(
      jobsModel,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config
    );

    await expect(
      service.applyCorrection(
        'user-1',
        'job-1',
        1,
        0,
        'D4',
        'homr',
        'scanner-engine-review-v1:stale'
      )
    ).rejects.toThrow(/content changed/);
    expect(provider.regenerate).not.toHaveBeenCalled();
    expect(storage.putDerivativeObject).not.toHaveBeenCalled();
    expect(jobsModel.updateOne).not.toHaveBeenCalled();
  });

  it('routes review and regeneration through a future engine capability and adapter', async () => {
    const base = pageWith([
      ['clef_G2', '.', '_', '_', '_', 'upper'],
      ['note_4', 'C4', '_', '_', '_', 'upper']
    ]);
    const futureRun: any = {
      engine: 'future-review',
      status: 'succeeded',
      attempts: 1,
      idempotencyKey: 'future-key',
      providerRevision: 'future-provider-v2',
      modelRevision: 'future-model-v3',
      review: base.review,
      artifacts: { musicXml: base.musicXml }
    };
    const plan = scannerEnginePlan(['future-review'], 'future-review', {
      'future-review': {
        displayName: 'Future Review',
        outputArtifactKinds: ['musicxml'],
        supportsSpotReview: true,
        supportsMeasureGeometry: true,
        unsupportedSemanticClasses: []
      }
    });
    const page: any = {
      ...base,
      review: undefined,
      musicXml: undefined,
      engines: { 'future-review': futureRun }
    };
    const job: any = { _id: 'j', jobId: 'job-1', enginePlan: plan, pages: [page] };
    const jobsModel: any = {
      findOne: () => ({ exec: async () => job }),
      updateOne: (_filter: any, update: any) => ({
        exec: async () => {
          job.pages = update.$set.pages;
          return { matchedCount: 1 };
        }
      })
    };
    const futureAdapter = {
      engine: 'future-review',
      regenerateReview: jest.fn(async () => Buffer.from('<future-score/>'))
    } as any;
    const registry = {
      planForJob: () => plan,
      readable: (engineId: string) =>
        engineId === 'future-review' ? { adapter: futureAdapter } : undefined
    } as any;
    const storage = {
      putDerivativeObject: jest.fn(async (_key: string) => ({
        bucket: 'd',
        objectKey: 'future-reviewed.musicxml'
      })),
      deleteObject: jest.fn(async () => undefined)
    } as any;
    provider.regenerate.mockClear();
    corrections.create.mockClear();
    const service = new ScannerService(
      jobsModel,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config,
      registry
    );
    const review = await service.pageReview('user-1', 'job-1', 1);

    const result = await service.applyCorrection(
      'user-1',
      'job-1',
      1,
      0,
      'D4',
      review.engineId,
      review.contentSignature
    );

    expect(review).toMatchObject({
      engineId: 'future-review',
      contentSignature: expect.stringMatching(/^scanner-engine-review-v1:/)
    });
    expect(result).toMatchObject({ engineId: 'future-review' });
    expect(futureAdapter.regenerateReview).toHaveBeenCalled();
    expect(provider.regenerate).not.toHaveBeenCalled();
    expect(job.pages[0].reviewedMusicXml).toBeUndefined();
    expect(job.pages[0].engines['future-review'].reviewedMusicXml).toMatchObject({
      objectKey: 'future-reviewed.musicxml'
    });
    expect(corrections.create).toHaveBeenCalledWith(
      expect.objectContaining({
        engineId: 'future-review',
        modelRevision: 'future-model-v3',
        providerRevision: 'future-provider-v2',
        contentSignature: review.contentSignature
      })
    );
  });

  it('refuses spot review after a page has been reconciled', async () => {
    const page: any = {
      ...pageWith([
        ['clef_G2', '.', '_', '_', '_', 'upper'],
        ['note_4', 'C4', '_', '_', '_', 'upper']
      ]),
      mergedMusicXml: { bucket: 'd', objectKey: 'merged.musicxml' }
    };
    const jobsModel: any = {
      findOne: () => ({ exec: async () => ({ _id: 'j', jobId: 'job-1', pages: [page] }) })
    };
    const service = new ScannerService(
      jobsModel,
      corrections,
      {} as any,
      provider,
      telemetry,
      alerts,
      config
    );

    await expect(service.pageReview('user-1', 'job-1', 1)).rejects.toThrow(
      /unavailable after engine reconciliation/
    );
  });
});

describe('ScannerService merged score', () => {
  const values: Record<string, string> = {
    SCANNER_ENABLED: 'true',
    SCANNER_BETA_USER_IDS: 'user-1',
    SCANNER_TRANSCODA_ENABLED: 'true'
  };
  const config = {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback)
  } as any;
  const corrections = { create: jest.fn(async (doc: any) => doc) } as any;
  const provider = { engine: 'homr', regenerate: jest.fn() } as any;
  const alerts = { evaluate: jest.fn().mockResolvedValue([]) } as any;
  const telemetry = {
    emit: jest.fn(),
    userHash: jest.fn(() => 'user-hash'),
    trackJobCreated: jest.fn().mockResolvedValue(undefined)
  } as any;

  const MUSICXML =
    '<score-partwise><part-list><score-part id="P1"><part-name>Cello</part-name>' +
    '</score-part></part-list><part id="P1"><measure number="1"><note><pitch><step>C</step>' +
    '<octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>';

  const locator = (checksum: string) => ({
    bucket: 'd',
    objectKey: `o-${checksum}`,
    sizeBytes: 1,
    contentType: 'application/xml',
    checksumSha256: checksum
  });

  const run = (engine: string, checksum: string) => ({
    engine,
    status: 'succeeded',
    attempts: 1,
    idempotencyKey: `k-${engine}`,
    artifacts: { musicXml: locator(checksum) }
  });

  const pageWithReadings = (extra: any = {}) => ({
    pageNumber: 1,
    ordinal: 1,
    status: 'succeeded',
    attempts: 1,
    idempotencyKey: 'k',
    engines: { homr: run('homr', 'homr-a'), transcoda: run('transcoda', 'transcoda-b') },
    ...extra
  });

  const SPLICEABLE =
    '<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1">' +
    '<part-name>Cello</part-name></score-part></part-list><part id="P1"><measure number="1">' +
    '<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time>' +
    '</attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration>' +
    '<voice>1</voice></note></measure></part></score-partwise>';

  const buildService = (
    job: any,
    options: { writes?: any[]; deleted?: string[]; mergeDecisions?: any[] } = {}
  ) => {
    const jobsModel: any = {
      findOne: () => ({ exec: async () => job }),
      updateOne: (_filter: any, update: any) => {
        options.writes?.push(update);
        return { exec: async () => ({ matchedCount: 1 }) };
      }
    };
    const storage = {
      putDerivativeObject: jest.fn(async (objectKey: string) => ({
        bucket: 'derived',
        objectKey,
        checksumSha256: 'ignored'
      })),
      deleteObject: jest.fn(async (_bucket: string, objectKey: string) => {
        options.deleted?.push(objectKey);
      }),
      getObjectBuffer: jest.fn(async () => Buffer.from(MUSICXML))
    } as any;
    const mergeDecisions = {
      create: jest.fn(async (doc: any) => {
        options.mergeDecisions?.push(doc);
        return doc;
      })
    } as any;
    const service = new ScannerService(
      jobsModel,
      corrections,
      storage,
      provider,
      telemetry,
      alerts,
      config,
      undefined,
      mergeDecisions
    );
    return { service, storage };
  };

  const currentBasis = (page: any) => scannerMergedScoreBasis(page);

  beforeEach(() => jest.clearAllMocks());

  it('makes the merged score the page and asks for a rebuild', async () => {
    // The gate for this step: once saved, the merged score *is* the page, and
    // every derivative built from the engine reading now describes something
    // that no longer exists.
    const page = pageWithReadings();
    const job: any = {
      _id: 'j',
      jobId: 'job-1',
      status: 'succeeded',
      statusVersion: 3,
      combinedMusicXml: locator('combined'),
      pages: [page]
    };
    const writes: any[] = [];
    const { service, storage } = buildService(job, { writes });

    const result = await service.saveMergedScore('user-1', 'job-1', 1, {
      musicXml: MUSICXML,
      sourceEngineId: 'transcoda',
      basisSignature: currentBasis(page),
      revision: 0
    });

    expect(result).toMatchObject({ present: true, revision: 1, sourceEngineId: 'transcoda' });
    const saved = writes[0].$set.pages[0];
    expect(effectivePageMusicXml(saved)).toMatchObject(saved.mergedMusicXml);
    expect(writes[0].$set.reassembleRequestedAt).toBeInstanceOf(Date);
    expect(writes[0].$set.combinedStale).toBe(true);
    expect(storage.putDerivativeObject).toHaveBeenCalled();
  });

  it('refuses a save made against readings that have since moved', async () => {
    const page = pageWithReadings();
    const staleSignature = currentBasis({ engines: { homr: run('homr', 'homr-before') } });
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const { service, storage } = buildService(job);

    await expect(
      service.saveMergedScore('user-1', 'job-1', 1, {
        musicXml: MUSICXML,
        sourceEngineId: 'homr',
        basisSignature: staleSignature,
        revision: 0
      })
    ).rejects.toThrow(/readings changed/);
    // Nothing is written on a refusal, so the reviewer's tab still holds the
    // only copy and can offer them the choice.
    expect(storage.putDerivativeObject).not.toHaveBeenCalled();

    const accepted = await service.saveMergedScore('user-1', 'job-1', 1, {
      musicXml: MUSICXML,
      sourceEngineId: 'homr',
      basisSignature: staleSignature,
      revision: 0,
      acceptStale: true
    });
    expect(accepted.stale).toBe(false);
  });

  it('refuses a second tab writing over the first', async () => {
    const page = pageWithReadings({
      mergedMusicXml: locator('merged'),
      mergedScore: {
        sourceEngineId: 'homr',
        basisSignature: currentBasis(pageWithReadings()),
        revision: 2,
        updatedAt: new Date()
      }
    });
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const { service } = buildService(job);

    await expect(
      service.saveMergedScore('user-1', 'job-1', 1, {
        musicXml: MUSICXML,
        sourceEngineId: 'homr',
        basisSignature: currentBasis(page),
        revision: 1
      })
    ).rejects.toThrow(/merged score changed/);
  });

  it('keeps the edited mark once hand work has landed', async () => {
    // An edited bar means both engines were wrong there. A later save that
    // happens to touch nothing must not quietly return the credit to an engine.
    const basis = currentBasis(pageWithReadings());
    const page = pageWithReadings({
      mergedMusicXml: locator('merged'),
      mergedScore: {
        sourceEngineId: 'homr',
        basisSignature: basis,
        edited: true,
        revision: 1,
        updatedAt: new Date()
      }
    });
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const writes: any[] = [];
    const { service } = buildService(job, { writes });

    const result = await service.saveMergedScore('user-1', 'job-1', 1, {
      musicXml: MUSICXML,
      sourceEngineId: 'homr',
      basisSignature: basis,
      revision: 1,
      edited: false
    });
    expect(result.edited).toBe(true);
    expect(writes[0].$set.pages[0].mergedScore.edited).toBe(true);
  });

  it('refuses a document that would fail assembly later', async () => {
    const page = pageWithReadings();
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const { service } = buildService(job);

    await expect(
      service.saveMergedScore('user-1', 'job-1', 1, {
        musicXml: '<score-partwise><part-list/></score-partwise>',
        sourceEngineId: 'homr',
        basisSignature: currentBasis(page),
        revision: 0
      })
    ).rejects.toThrow(/not usable MusicXML/);
  });

  it('reports a merge as stale rather than losing it after a re-run', async () => {
    const page = pageWithReadings({
      engines: { homr: run('homr', 'homr-rescanned'), transcoda: run('transcoda', 'transcoda-b') },
      mergedMusicXml: locator('merged'),
      mergedScore: {
        sourceEngineId: 'homr',
        basisSignature: currentBasis(pageWithReadings()),
        edited: true,
        revision: 4,
        updatedAt: new Date()
      }
    });
    // The stored object is re-verified on read, so the fixture's checksum has
    // to be the real one.
    page.mergedMusicXml.checksumSha256 = createHash('sha256').update(MUSICXML).digest('hex');
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', statusVersion: 9, pages: [page] };
    const { service } = buildService(job);

    const state = await service.pageMergedScore('user-1', 'job-1', 1);
    expect(state).toMatchObject({ present: true, stale: true, edited: true, revision: 4 });
    // Still retrievable: the reviewer has to be able to see what they would lose.
    await expect(service.pageMergedScoreMusicXml('user-1', 'job-1', 1, 4)).resolves.toMatchObject({
      contentType: 'application/xml'
    });
  });

  it('discards a merged score only on the reviewer\'s explicit act', async () => {
    const basis = currentBasis(pageWithReadings());
    const page = pageWithReadings({
      mergedMusicXml: locator('merged'),
      mergedScore: { sourceEngineId: 'homr', basisSignature: basis, revision: 2, updatedAt: new Date() }
    });
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const writes: any[] = [];
    const deleted: string[] = [];
    const { service } = buildService(job, { writes, deleted });

    await expect(service.discardMergedScore('user-1', 'job-1', 1, 1)).rejects.toThrow(
      /merged score changed/
    );
    expect(writes).toHaveLength(0);

    const result = await service.discardMergedScore('user-1', 'job-1', 1, 2);
    expect(result.present).toBe(false);
    expect(writes[0].$set.pages[0].mergedMusicXml).toBeUndefined();
    expect(writes[0].$set.reassembleRequestedAt).toBeInstanceOf(Date);
    expect(deleted).toContain('o-merged');
  });

  it('keeps serving the readings a merge is judged against', async () => {
    // The comparison is where the merge is made and revised; withholding the
    // readings once one exists would leave the merged pane nothing to compare to.
    const basis = currentBasis(pageWithReadings());
    const page = pageWithReadings({
      mergedMusicXml: locator('merged'),
      mergedScore: { sourceEngineId: 'homr', basisSignature: basis, revision: 1, updatedAt: new Date() }
    });
    const job: any = {
      _id: 'j',
      jobId: 'job-1',
      status: 'succeeded',
      statusVersion: 1,
      pages: [page]
    };
    const { service } = buildService(job);

    await expect(
      service.pageComparisonReading('user-1', 'job-1', 1, 'homr', 1, 'homr-a'.padEnd(64, '0'))
    ).rejects.toThrow(/checksum is invalid|reading changed/);
    // Spot review, by contrast, stays closed: it regenerates the engine's own
    // XML, which the merged score would silently shadow.
    await expect(service.pageReview('user-1', 'job-1', 1)).rejects.toThrow(
      /unavailable after engine reconciliation/
    );
  });

  it('refuses a decision for a block whose place on the scan is unproven', async () => {
    // §7 makes this structural: the signature a decision requires is withheld
    // from an ungrounded block, so a caller cannot present one. This is the
    // belt to that braces — the route checks groundedness itself too.
    const page = pageWithReadings();
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const { service } = buildService(job);
    jest.spyOn(service as any, 'pageComparisonForJob').mockResolvedValue({
      analysis: {
        status: 'succeeded',
        blocks: [
          {
            blockIndex: 0,
            contentSignature: 'sig-0',
            baseMeasureRefs: [{ measureIndex: 3 }],
            candidateMeasureRefs: [{ measureIndex: 3 }]
          }
        ]
      },
      geometry: { blocks: [{ status: 'refused', block: { blockIndex: 0 } }] }
    });

    await expect(
      service.takeBlockIntoMergedScore('user-1', 'job-1', 1, {
        blockIndex: 0,
        contentSignature: 'sig-0',
        engineId: 'transcoda',
        baseEngineId: 'homr',
        candidateEngineId: 'transcoda',
        revision: 0
      })
    ).rejects.toThrow(/no verified place on the scan/);
  });

  it('refuses a decision made against readings that have since changed', async () => {
    const page = pageWithReadings();
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const { service } = buildService(job);
    jest.spyOn(service as any, 'pageComparisonForJob').mockResolvedValue({
      analysis: {
        status: 'succeeded',
        blocks: [{ blockIndex: 0, contentSignature: 'sig-now', baseMeasureRefs: [], candidateMeasureRefs: [] }]
      },
      geometry: { blocks: [{ status: 'ready', block: { blockIndex: 0 } }] }
    });

    await expect(
      service.takeBlockIntoMergedScore('user-1', 'job-1', 1, {
        blockIndex: 0,
        contentSignature: 'sig-from-a-stale-tab',
        engineId: 'transcoda',
        baseEngineId: 'homr',
        candidateEngineId: 'transcoda',
        revision: 0
      })
    ).rejects.toThrow(/readings changed/);
  });

  it('refuses a second tab deciding against an older merged score', async () => {
    const page = pageWithReadings();
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const { service } = buildService(job);

    await expect(
      service.takeBlockIntoMergedScore('user-1', 'job-1', 1, {
        blockIndex: 0,
        contentSignature: 'sig-0',
        engineId: 'transcoda',
        baseEngineId: 'homr',
        candidateEngineId: 'transcoda',
        revision: 7
      })
    ).rejects.toThrow(/merged score changed/);
  });

  it('refuses taking from an engine the merged score already follows', async () => {
    // Not an error so much as a no-op with a misleading name: the passage
    // already reads that way, and recording a decision would claim otherwise.
    const page = pageWithReadings({
      mergedMusicXml: {
        bucket: 'd',
        objectKey: 'o-merged',
        sizeBytes: 1,
        contentType: 'application/xml',
        checksumSha256: 'merged'
      },
      mergedScore: {
        sourceEngineId: 'homr',
        basisSignature: 'basis',
        revision: 1,
        updatedAt: new Date()
      }
    });
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const { service } = buildService(job);
    jest.spyOn(service as any, 'pageComparisonForJob').mockResolvedValue({
      analysis: {
        status: 'succeeded',
        blocks: [
          {
            blockIndex: 0,
            contentSignature: 'sig-0',
            baseMeasureRefs: [{ measureIndex: 0 }],
            candidateMeasureRefs: [{ measureIndex: 0 }]
          }
        ]
      },
      geometry: { blocks: [{ status: 'ready', block: { blockIndex: 0 } }] }
    });

    await expect(
      service.takeBlockIntoMergedScore('user-1', 'job-1', 1, {
        blockIndex: 0,
        contentSignature: 'sig-0',
        engineId: 'homr',
        baseEngineId: 'homr',
        candidateEngineId: 'transcoda',
        revision: 1
      })
    ).rejects.toThrow(/already reads this passage/);
  });

  it('answers a take with the URL of the revision it produced', async () => {
    // The MusicXML URL is pinned to a revision. Without it in the response the
    // client kept the URL of the revision it had just superseded, reloaded, and
    // drew the bar it had replaced — so every take looked like it did nothing
    // while the server had recorded all of them.
    const page = pageWithReadings({
      sourceImage: {
        bucket: 'src',
        objectKey: 'page.png',
        sizeBytes: 1,
        contentType: 'image/png',
        checksumSha256: 'page-sha'
      }
    });
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const { service } = buildService(job);
    jest.spyOn(service as any, 'pageComparisonForJob').mockResolvedValue({
      analysis: {
        status: 'succeeded',
        blocks: [
          {
            blockIndex: 0,
            contentSignature: 'sig-0',
            baseAnchorIndex: -1,
            baseMeasureRefs: [{ measureIndex: 0 }],
            candidateMeasureRefs: [{ measureIndex: 0 }]
          }
        ]
      },
      geometry: { blocks: [{ status: 'ready', block: { blockIndex: 0 } }] }
    });
    jest
      .spyOn(service as any, 'mergedOrEngineMusicXml')
      .mockResolvedValue(Buffer.from(SPLICEABLE));
    jest.spyOn(service as any, 'engineMusicXml').mockResolvedValue(Buffer.from(SPLICEABLE));

    const state = await service.takeBlockIntoMergedScore('user-1', 'job-1', 1, {
      blockIndex: 0,
      contentSignature: 'sig-0',
      engineId: 'transcoda',
      baseEngineId: 'homr',
      candidateEngineId: 'transcoda',
      revision: 0
    });

    expect(state.revision).toBe(1);
    expect(state.musicXmlUrl).toBe('../merged/musicxml?revision=1');
    expect(state.url).toBe('../merged');
  });

  it('takes a passage back to the engine the merged score started from', async () => {
    // The reviewer took this bar from the candidate reading and wants it back.
    // The merged score still *started* from HOMR, so a guard that compared the
    // take against the document's origin refused this forever: the control was
    // offered, the bar on screen plainly read from the other engine, and
    // pressing it only ever produced "already reads this passage".
    const page = pageWithReadings({
      mergedMusicXml: {
        bucket: 'b',
        objectKey: 'o-merged',
        sizeBytes: 1,
        contentType: 'application/xml',
        checksumSha256: 'merged'
      },
      mergedScore: {
        sourceEngineId: 'homr',
        basisSignature: 'basis',
        revision: 1,
        decisions: [{ blockIndex: 0, engineId: 'transcoda', measureIndexes: [0] }],
        updatedAt: new Date()
      }
    });
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const { service } = buildService(job);
    jest.spyOn(service as any, 'pageComparisonForJob').mockResolvedValue({
      analysis: {
        status: 'succeeded',
        blocks: [
          {
            blockIndex: 0,
            contentSignature: 'sig-0',
            baseAnchorIndex: -1,
            baseMeasureRefs: [{ measureIndex: 0 }],
            candidateMeasureRefs: [{ measureIndex: 0 }]
          }
        ]
      },
      geometry: { blocks: [{ status: 'ready', block: { blockIndex: 0 } }] }
    });
    jest
      .spyOn(service as any, 'mergedOrEngineMusicXml')
      .mockResolvedValue(Buffer.from(SPLICEABLE));
    jest.spyOn(service as any, 'engineMusicXml').mockResolvedValue(Buffer.from(SPLICEABLE));

    const state = await service.takeBlockIntoMergedScore('user-1', 'job-1', 1, {
      blockIndex: 0,
      contentSignature: 'sig-0',
      engineId: 'homr',
      baseEngineId: 'homr',
      candidateEngineId: 'transcoda',
      revision: 1
    });

    // Recorded like any other take, so the block now reads from HOMR again and
    // the pair of controls swaps over.
    expect(state.decisions.at(-1)).toMatchObject({ blockIndex: 0, engineId: 'homr' });
  });

  it('still refuses a take on a passage that already reads from that engine', async () => {
    // The undecided case, which must keep refusing: offering a control whose
    // only outcome is this message is worse than offering none.
    const page = pageWithReadings({
      mergedMusicXml: {
        bucket: 'b',
        objectKey: 'o-merged',
        sizeBytes: 1,
        contentType: 'application/xml',
        checksumSha256: 'merged'
      },
      mergedScore: {
        sourceEngineId: 'homr',
        basisSignature: 'basis',
        revision: 1,
        decisions: [{ blockIndex: 0, engineId: 'transcoda', measureIndexes: [0] }],
        updatedAt: new Date()
      }
    });
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const { service } = buildService(job);
    jest.spyOn(service as any, 'pageComparisonForJob').mockResolvedValue({
      analysis: {
        status: 'succeeded',
        blocks: [
          {
            blockIndex: 0,
            contentSignature: 'sig-0',
            baseMeasureRefs: [{ measureIndex: 0 }],
            candidateMeasureRefs: [{ measureIndex: 0 }]
          }
        ]
      },
      geometry: { blocks: [{ status: 'ready', block: { blockIndex: 0 } }] }
    });

    await expect(
      service.takeBlockIntoMergedScore('user-1', 'job-1', 1, {
        blockIndex: 0,
        contentSignature: 'sig-0',
        engineId: 'transcoda',
        baseEngineId: 'homr',
        candidateEngineId: 'transcoda',
        revision: 1
      })
    ).rejects.toThrow(/already reads this passage/);
  });

  it('refuses a take on a bar an earlier decision removed', async () => {
    // The map says that engine measure is no longer anywhere in the merged
    // score. Acting on a neighbour instead is the failure it exists to prevent.
    const page = pageWithReadings({
      mergedMusicXml: {
        bucket: 'd',
        objectKey: 'o-merged',
        sizeBytes: 1,
        contentType: 'application/xml',
        checksumSha256: 'merged'
      },
      mergedScore: {
        sourceEngineId: 'homr',
        basisSignature: 'basis',
        revision: 2,
        // Engine bar 1 was deleted by an earlier take.
        measureMap: [0, 2, 3],
        updatedAt: new Date()
      }
    });
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const { service } = buildService(job);
    jest.spyOn(service as any, 'pageComparisonForJob').mockResolvedValue({
      analysis: {
        status: 'succeeded',
        blocks: [
          {
            blockIndex: 0,
            contentSignature: 'sig-0',
            baseAnchorIndex: 0,
            baseMeasureRefs: [{ measureIndex: 1 }],
            candidateMeasureRefs: [{ measureIndex: 1 }]
          }
        ]
      },
      geometry: { blocks: [{ status: 'ready', block: { blockIndex: 0 } }] }
    });

    await expect(
      service.takeBlockIntoMergedScore('user-1', 'job-1', 1, {
        blockIndex: 0,
        contentSignature: 'sig-0',
        engineId: 'transcoda',
        baseEngineId: 'homr',
        candidateEngineId: 'transcoda',
        revision: 2
      })
    ).rejects.toThrow(/an earlier decision removed it/);
  });

  it('says why a passage could not be taken, not just that it could not', () => {
    // The structured refusals travel too, but the error filter keeps `message`
    // and drops the rest — so a reviewer saw "this passage cannot be taken" and
    // no reason at all. The reason is the whole value of a refusal: "the two
    // readings of this bar are different lengths" says something about the
    // page; "cannot" says the button is broken.
    const service = new ScannerService(
      {} as any,
      corrections,
      {} as any,
      provider,
      telemetry,
      alerts,
      config
    );

    expect(
      (service as any).refusalMessage('This passage cannot be taken', [
        { code: 'duration-differs', detail: 'The two readings are different lengths.' }
      ])
    ).toBe('This passage cannot be taken: The two readings are different lengths.');

    // Nothing to add when there is nothing to say.
    expect((service as any).refusalMessage('This passage cannot be taken', [])).toBe(
      'This passage cannot be taken'
    );
  });

  it('records a take as a preference between two readings', async () => {
    // The signal a comparison produces and spot review cannot: not "the model
    // was unsure and here is the answer" but "two independent readings
    // disagreed and here is which one a human believed".
    const created: any[] = [];
    const page = pageWithReadings({
      sourceImage: {
        bucket: 'src',
        objectKey: 'page.png',
        sizeBytes: 1,
        contentType: 'image/png',
        checksumSha256: 'page-sha'
      }
    });
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const { service } = buildService(job, { mergeDecisions: created });
    jest.spyOn(service as any, 'pageComparisonForJob').mockResolvedValue({
      analysis: {
        status: 'succeeded',
        blocks: [
          {
            blockIndex: 0,
            contentSignature: 'sig-0',
            baseAnchorIndex: -1,
            differenceClasses: ['notation'],
            baseMeasureRefs: [{ measureIndex: 0 }],
            candidateMeasureRefs: [{ measureIndex: 0 }]
          }
        ]
      },
      geometry: { blocks: [{ status: 'ready', block: { blockIndex: 0 } }] }
    });
    jest
      .spyOn(service as any, 'mergedOrEngineMusicXml')
      .mockResolvedValue(Buffer.from(SPLICEABLE));
    jest.spyOn(service as any, 'engineMusicXml').mockResolvedValue(Buffer.from(SPLICEABLE));

    await service.takeBlockIntoMergedScore('user-1', 'job-1', 1, {
      blockIndex: 0,
      contentSignature: 'sig-0',
      engineId: 'transcoda',
      baseEngineId: 'homr',
      candidateEngineId: 'transcoda',
      revision: 0
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      pageSha256: 'page-sha',
      outcome: 'took-notes',
      engineId: 'transcoda',
      baseEngineId: 'homr',
      candidateEngineId: 'transcoda',
      // The most directly useful column: which engine wins when they disagree
      // about *what*.
      differenceClasses: ['notation']
    });
  });

  it('never credits an engine for a bar a human had to fix', async () => {
    // The invariant §3.1 is most insistent about. An edited bar is evidence
    // that *both* engines were wrong there; filing it as either one being right
    // poisons the corpus this feature exists to build.
    const created: any[] = [];
    const page = pageWithReadings({
      sourceImage: {
        bucket: 'src',
        objectKey: 'page.png',
        sizeBytes: 1,
        contentType: 'image/png',
        checksumSha256: 'page-sha'
      },
      mergedMusicXml: {
        bucket: 'd',
        objectKey: 'o-merged',
        sizeBytes: 1,
        contentType: 'application/xml',
        checksumSha256: 'merged'
      },
      mergedScore: {
        sourceEngineId: 'homr',
        basisSignature: scannerMergedScoreBasis(pageWithReadings()),
        revision: 1,
        decisions: [{ blockIndex: 0 }, { blockIndex: 1 }],
        updatedAt: new Date()
      }
    });
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const { service } = buildService(job, { mergeDecisions: created });

    await service.saveMergedScore('user-1', 'job-1', 1, {
      musicXml: MUSICXML,
      sourceEngineId: 'homr',
      basisSignature: scannerMergedScoreBasis(page),
      revision: 1,
      edited: true
    });

    expect(created).toHaveLength(1);
    expect(created[0].outcome).toBe('edited');
    expect(created[0].engineId).toBeUndefined();
    // An edit is page-level, so a consumer weighting the per-bar takes on this
    // page has to know there were some.
    expect(created[0].priorDecisions).toBe(2);
  });

  it('refuses an engine that is not one of the two being compared', async () => {
    const page = pageWithReadings();
    const job: any = { _id: 'j', jobId: 'job-1', status: 'succeeded', pages: [page] };
    const { service } = buildService(job);

    await expect(
      service.takeBlockIntoMergedScore('user-1', 'job-1', 1, {
        blockIndex: 0,
        contentSignature: 'sig-0',
        engineId: 'audiveris',
        baseEngineId: 'homr',
        candidateEngineId: 'transcoda',
        revision: 0
      })
    ).rejects.toThrow(/not one of the two/);
  });

});

describe('scanner comparison relative URLs', () => {
    // Every URL in the regions document resolves against the document's own
    // URL, because the browser reaches this process through the host's proxy
    // and neither the embed nor this service knows the prefix. The regions
    // document sits at `…/pages/N/comparison/regions`, which makes the correct
    // prefix depend on whether the target lives under `comparison/`.
    const regionsUrl =
      'https://host/api/proxy/scanner/jobs/job-1/pages/1/comparison/regions?baseEngine=homr';
    const resolve = (relative: string) => new URL(relative, regionsUrl).pathname;

    it('resolves a system crop, which lives under comparison', () => {
      expect(resolve('systems/3/crop?statusVersion=7')).toBe(
        '/api/proxy/scanner/jobs/job-1/pages/1/comparison/systems/3/crop'
      );
    });

    it('resolves the merged score, which does not', () => {
      expect(resolve('../merged')).toBe('/api/proxy/scanner/jobs/job-1/pages/1/merged');
      expect(resolve('../merged/musicxml?revision=1')).toBe(
        '/api/proxy/scanner/jobs/job-1/pages/1/merged/musicxml'
      );
      // The shape that shipped broken: it lands on a route that does not exist,
      // and the only symptom is a 404 inside the embed.
      expect(resolve('merged')).not.toBe('/api/proxy/scanner/jobs/job-1/pages/1/merged');
    });
});