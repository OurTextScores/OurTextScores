import { disablesProvider } from './scanner-worker.service';
import { ScannerProviderError } from './scanner.errors';
import { ScannerWorkerService } from './scanner-worker.service';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp = require('sharp');
import AdmZip = require('adm-zip');
import { scannerDefaultEnginePlan, scannerEnginePlan } from './scanner-dual-engine';
import { ScannerEngineDefinition, ScannerEngineRegistry } from './scanner-engine.registry';

describe('ScannerWorkerService', () => {
  const values: Record<string, string> = {
    SCANNER_ENABLED: 'true',
    SCANNER_PROVIDER_BUDGET_EXHAUSTED: 'false'
  };
  const config = {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback)
  } as any;
  const provider = {
    engine: 'homr',
    createIdempotencyKey: jest.fn(() => 'homr-key'),
    scanPage: jest.fn()
  } as any;
  const transcodaProvider = {
    engine: 'transcoda',
    createIdempotencyKey: jest.fn(() => 'transcoda-key'),
    scanPage: jest.fn()
  } as any;
  const merger = { enabled: false, merge: jest.fn() } as any;
  const alerts = {
    check: jest.fn().mockResolvedValue([]),
    evaluate: jest.fn().mockResolvedValue([])
  } as any;
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
      transcodaProvider,
      {} as any,
      merger,
      alerts,
      {} as any,
      telemetry,
      config
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    values.SCANNER_PROVIDER_BUDGET_EXHAUSTED = 'false';
    delete values.SCANNER_PROVIDER_KIND;
    delete values.SCANNER_TRANSCODA_ENABLED;
    delete values.SCANNER_TEST_WORKER_LEASE_MS;
  });

  it('uses the persisted engine plan after the new-job flag changes', () => {
    const scannerWorker = service() as any;
    const page = { included: true, status: 'pending', attempts: 0, idempotencyKey: '' };

    values.SCANNER_TRANSCODA_ENABLED = 'false';
    expect(
      scannerWorker.withInitialPlannedEngineRuns(
        { enginePlan: scannerDefaultEnginePlan(true), pages: [] },
        page
      ).engines.transcoda.status
    ).toBe('pending');

    values.SCANNER_TRANSCODA_ENABLED = 'true';
    expect(
      scannerWorker.withInitialPlannedEngineRuns(
        { enginePlan: scannerDefaultEnginePlan(false), pages: [] },
        page
      ).engines?.transcoda
    ).toBeUndefined();
  });

  it('fails a planned run explicitly when its registry definition is unavailable', () => {
    const scannerWorker = service() as any;
    const result = scannerWorker.withInitialPlannedEngineRuns(
      { enginePlan: scannerEnginePlan(['homr', 'retired-engine']), pages: [] },
      { included: true, status: 'pending', attempts: 0, idempotencyKey: '' }
    );

    expect(result.engines['retired-engine']).toMatchObject({
      status: 'failed',
      attempts: 0,
      errorCode: 'engine_not_registered'
    });
  });

  it('reports circuit-disabled engines independently to alerting', () => {
    const scannerWorker = service() as any;
    scannerWorker.engineDisabledReasons.set('homr', 'HOMR revision mismatch');
    scannerWorker.engineDisabledReasons.set('audiveris-5', 'Audiveris image mismatch');

    expect(scannerWorker.disabledEngineReasons()).toEqual({
      homr: 'HOMR revision mismatch',
      'audiveris-5': 'Audiveris image mismatch'
    });
  });

  it('uses the effective page when rebuilding a bundle after review', async () => {
    const raw = { bucket: 'd', objectKey: 'raw.musicxml', checksumSha256: 'raw' };
    const reviewed = {
      bucket: 'd',
      objectKey: 'reviewed.musicxml',
      checksumSha256: 'reviewed'
    };
    const result = await (service() as any).createBundle({ pageCount: 1 }, [
      { pageNumber: 1, ordinal: 1, musicXml: raw, reviewedMusicXml: reviewed }
    ]);
    expect(result).toMatchObject(reviewed);
    expect(result.inputSignature).toMatch(/^scanner-artifact-input-v1:/);
  });

  it('stores the results dependency signature on both locator and manifest', async () => {
    let storedBody: Buffer | undefined;
    const storage = {
      getObjectBuffer: jest.fn().mockResolvedValue(Buffer.from('<score-partwise/>')),
      putAuxiliaryObject: jest.fn(async (objectKey: string, body: Buffer) => {
        storedBody = body;
        return { bucket: 'scanner', objectKey };
      })
    } as any;
    const scannerWorker = new ScannerWorkerService(
      {} as any,
      storage,
      provider,
      transcodaProvider,
      {} as any,
      merger,
      alerts,
      {} as any,
      telemetry,
      config
    ) as any;
    const locator = await scannerWorker.createResultsZip(
      { jobId: 'job-1', userId: 'user-1' },
      [
        {
          pageNumber: 1,
          ordinal: 1,
          included: true,
          status: 'succeeded',
          attempts: 1,
          musicXml: {
            bucket: 'scanner',
            objectKey: 'page.musicxml',
            checksumSha256: 'page-checksum'
          },
          engines: {
            transcoda: {
              engine: 'transcoda',
              status: 'succeeded',
              attempts: 1,
              idempotencyKey: 'transcoda-key',
              providerRequestId: 'transcoda-request',
              providerRevision: 'transcoda-service',
              modelRevision: 'transcoda-model',
              generation: {
                hitMaxLength: true,
                sawEos: false,
                truncated: true,
                maxLength: 2048
              },
              provenance: { executionProvider: 'torch.cuda' },
              artifacts: {
                kern: { checksumSha256: 'kern-checksum' },
                musicXml: { checksumSha256: 'transcoda-checksum' }
              }
            }
          }
        }
      ],
      { status: 'succeeded' }
    );

    expect(locator.inputSignature).toMatch(/^scanner-artifact-input-v1:/);
    const manifest = JSON.parse(new AdmZip(storedBody).readAsText('scanner-manifest.json'));
    expect(manifest.inputSignature).toBe(locator.inputSignature);
    expect(manifest.pages[0].engines.transcoda).toMatchObject({
      status: 'succeeded',
      providerRequestId: 'transcoda-request',
      provenance: { executionProvider: 'torch.cuda' },
      artifacts: {
        musicXmlSha256: 'transcoda-checksum',
        kernSha256: 'kern-checksum'
      }
    });
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

  it('waits with jittered exponential backoff before retrying a transient failure', async () => {
    // Section 13.1. Retrying instantly means the second attempt hits whatever
    // transient condition failed the first while it is still true — which is
    // exactly how a cold provider container used to lose a page.
    const delays: number[] = [];
    const sleepSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      callback: () => void,
      ms?: number
    ) => {
      delays.push(Number(ms));
      callback();
      return 0 as any;
    }) as any);
    provider.scanPage
      .mockRejectedValueOnce(new ScannerProviderError('cold', 'provider_model_not_ready', true))
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
    expect(delays).toHaveLength(1);
    // Equal jitter around a 2s base: never zero, never more than the base.
    expect(delays[0]).toBeGreaterThanOrEqual(1_000);
    expect(delays[0]).toBeLessThanOrEqual(2_000);
    sleepSpy.mockRestore();
  });

  it('does not sleep when the failure is not retryable', async () => {
    const sleepSpy = jest.spyOn(global, 'setTimeout');
    provider.scanPage.mockRejectedValue(
      new ScannerProviderError('no staff', 'provider_no_staff_detected', false)
    );
    await expect(
      (service() as any).scanWithRetry({
        image: Buffer.from('image'),
        pageNumber: 1,
        detectTitle: false,
        idempotencyKey: 'stable-key'
      })
    ).rejects.toMatchObject({ code: 'provider_no_staff_detected' });
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(provider.scanPage).toHaveBeenCalledTimes(1);
    sleepSpy.mockRestore();
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

  it('stores independent Transcoda artifacts and survives a HOMR failure', async () => {
    values.SCANNER_TRANSCODA_ENABLED = 'true';
    const jobsModel = {
      updateOne: jest.fn(() => ({ exec: async () => ({}) })),
      findOne: jest.fn(() => ({
        select: () => ({ lean: () => ({ exec: async () => ({ status: 'running' }) }) })
      }))
    } as any;
    const stored = new Map<string, Buffer>();
    const engineStorage = {
      putAuxiliaryObject: jest.fn(async (objectKey: string, body: Buffer) => {
        stored.set(objectKey, body);
        return { bucket: 'scanner', objectKey };
      }),
      deleteObject: jest.fn().mockResolvedValue(undefined)
    } as any;
    transcodaProvider.scanPage.mockResolvedValue({
      engine: 'transcoda',
      musicXml: Buffer.from('<score-partwise/>'),
      kern: Buffer.from('**kern\n4c\n*-\n'),
      providerRevision: 'transcoda-service',
      modelRevision: 'transcoda-model',
      provenance: { executionProvider: 'torch.cuda' },
      requestId: 'transcoda-request',
      inferenceMs: 25,
      generation: {
        hitMaxLength: true,
        sawEos: false,
        truncated: true,
        maxLength: 2048,
        numBeams: 3
      }
    });
    const scannerWorker = new ScannerWorkerService(
      jobsModel,
      engineStorage,
      provider,
      transcodaProvider,
      {} as any,
      merger,
      alerts,
      {} as any,
      telemetry,
      config
    ) as any;

    const result = await scannerWorker.scanEnginePage({
      job: { jobId: 'job-1', userId: 'user-1', generation: 1 },
      page: {
        pageNumber: 1,
        ordinal: 1,
        included: true,
        status: 'failed',
        attempts: 1,
        idempotencyKey: 'homr-key',
        errorCode: 'provider_no_staff_detected',
        errorMessage: 'No notation was detected',
        engines: {
          homr: {
            engine: 'homr',
            status: 'failed',
            attempts: 1,
            idempotencyKey: 'homr-key',
            errorCode: 'provider_no_staff_detected',
            artifacts: {}
          },
          transcoda: {
            engine: 'transcoda',
            status: 'pending',
            attempts: 0,
            idempotencyKey: '',
            artifacts: {}
          }
        }
      },
      image: Buffer.from('image'),
      contentType: 'image/png',
      pageNumber: 1,
      detectTitle: false,
      userHash: 'user-hash',
      definition: scannerWorker.engineRegistry().get('transcoda')
    });

    expect(result.page).toMatchObject({
      status: 'succeeded',
      errorCode: 'provider_no_staff_detected',
      errorMessage: 'No notation was detected',
      engines: {
        homr: { status: 'failed' },
        transcoda: {
          status: 'succeeded',
          providerRequestId: 'transcoda-request',
          generation: { hitMaxLength: true, sawEos: false, truncated: true },
          artifacts: {
            musicXml: { objectKey: expect.stringMatching(/-transcoda\.musicxml$/) },
            kern: { objectKey: expect.stringMatching(/-transcoda\.krn$/) }
          }
        }
      }
    });
    expect([...stored.keys()]).toEqual([
      expect.stringMatching(/page-001-transcoda\.musicxml$/),
      expect.stringMatching(/page-001-transcoda\.krn$/)
    ]);
  });

  it('runs HOMR through the generic engine loop and dual-writes legacy review fields', async () => {
    const jobsModel = {
      updateOne: jest.fn(() => ({ exec: async () => ({}) })),
      findOne: jest.fn(() => ({
        select: () => ({ lean: () => ({ exec: async () => ({ status: 'running' }) }) })
      }))
    } as any;
    const stored = new Map<string, Buffer>();
    const engineStorage = {
      putAuxiliaryObject: jest.fn(async (objectKey: string, body: Buffer) => {
        stored.set(objectKey, body);
        return {
          bucket: 'scanner',
          objectKey,
          sizeBytes: body.length,
          contentType: 'application/vnd.recordare.musicxml+xml',
          checksumSha256: 'homr-checksum'
        };
      }),
      deleteObject: jest.fn().mockResolvedValue(undefined)
    } as any;
    const review = { staves: [] };
    provider.scanPage.mockResolvedValue({
      engine: 'homr',
      musicXml: Buffer.from('<score-partwise/>'),
      providerRevision: 'homr-service',
      modelRevision: 'homr-model',
      provenance: { executionProvider: 'cuda' },
      requestId: 'homr-request',
      review
    });
    const scannerWorker = new ScannerWorkerService(
      jobsModel,
      engineStorage,
      provider,
      transcodaProvider,
      {} as any,
      merger,
      alerts,
      {} as any,
      telemetry,
      config
    ) as any;
    const job = {
      jobId: 'job-1',
      userId: 'user-1',
      generation: 1,
      enginePlan: scannerDefaultEnginePlan(false),
      pages: []
    };
    const page = scannerWorker.withInitialPlannedEngineRuns(job, {
      pageNumber: 1,
      ordinal: 1,
      included: true,
      status: 'pending',
      attempts: 0,
      idempotencyKey: ''
    });

    const result = await scannerWorker.scanPlannedEngines({
      job,
      page,
      image: Buffer.from('image'),
      contentType: 'image/png',
      pageNumber: 1,
      detectTitle: false,
      userHash: 'user-hash'
    });

    expect(result.page).toMatchObject({
      status: 'succeeded',
      providerRequestId: 'homr-request',
      review,
      musicXml: { objectKey: expect.stringMatching(/page-001-homr\.musicxml$/) },
      engines: {
        homr: {
          status: 'succeeded',
          review,
          artifacts: { musicXml: { objectKey: expect.stringMatching(/page-001-homr\.musicxml$/) } }
        }
      }
    });
    expect([...stored.keys()]).toEqual([expect.stringMatching(/page-001-homr\.musicxml$/)]);
    expect(telemetry.emit).toHaveBeenCalledWith('page_engine_succeeded', expect.any(Object));
    expect(telemetry.emit).toHaveBeenCalledWith('page_succeeded', expect.any(Object));
  });

  it('runs a third planned adapter through the generic engine loop', async () => {
    const audiverisProvider = {
      engine: 'audiveris-5',
      createIdempotencyKey: jest.fn(() => 'audiveris-key'),
      scanPage: jest.fn().mockResolvedValue({
        engine: 'audiveris-5',
        musicXml: Buffer.from('<score-partwise/>'),
        nativeArtifacts: { mei: Buffer.from('<mei/>') },
        providerRevision: 'audiveris-service',
        modelRevision: 'audiveris-model',
        provenance: { executionProvider: 'cpu' },
        requestId: 'audiveris-request',
        completeness: 'complete'
      })
    } as any;
    const definition: ScannerEngineDefinition = {
      id: 'audiveris-5',
      displayName: 'Audiveris 5',
      adapter: audiverisProvider,
      readable: true,
      enabledForNewJobs: () => true,
      budgetExhaustedConfigKey: 'SCANNER_AUDIVERIS_BUDGET_EXHAUSTED',
      providerKindConfigKey: 'SCANNER_AUDIVERIS_PROVIDER_KIND',
      timeoutConfigKey: 'SCANNER_AUDIVERIS_TIMEOUT_MS',
      capabilities: {
        displayName: 'Audiveris 5',
        outputArtifactKinds: ['musicxml', 'mei'],
        supportsSpotReview: false,
        supportsMeasureGeometry: true,
        unsupportedSemanticClasses: []
      },
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
    const registry = new ScannerEngineRegistry(config, provider, transcodaProvider);
    registry.register(definition);
    const jobsModel = {
      updateOne: jest.fn(() => ({ exec: async () => ({}) })),
      findOne: jest.fn(() => ({
        select: () => ({ lean: () => ({ exec: async () => ({ status: 'running' }) }) })
      }))
    } as any;
    const stored = new Map<string, Buffer>();
    const engineStorage = {
      putAuxiliaryObject: jest.fn(async (objectKey: string, body: Buffer) => {
        stored.set(objectKey, body);
        return { bucket: 'scanner', objectKey };
      }),
      deleteObject: jest.fn().mockResolvedValue(undefined)
    } as any;
    const scannerWorker = new ScannerWorkerService(
      jobsModel,
      engineStorage,
      provider,
      transcodaProvider,
      {} as any,
      merger,
      alerts,
      {} as any,
      telemetry,
      config,
      registry
    ) as any;
    const job = {
      jobId: 'job-1',
      userId: 'user-1',
      generation: 1,
      enginePlan: scannerEnginePlan(['audiveris-5'], 'audiveris-5', {
        'audiveris-5': definition.capabilities
      }),
      pages: []
    };
    const page = scannerWorker.withInitialPlannedEngineRuns(job, {
      pageNumber: 1,
      ordinal: 1,
      included: true,
      status: 'failed',
      attempts: 1,
      idempotencyKey: 'homr-key',
      engines: {}
    });
    expect(page.engines?.homr).toBeUndefined();

    const result = await scannerWorker.scanPlannedEngines({
      job,
      page,
      image: Buffer.from('image'),
      contentType: 'image/png',
      pageNumber: 1,
      detectTitle: false,
      userHash: 'user-hash'
    });

    expect(audiverisProvider.scanPage).toHaveBeenCalledTimes(1);
    expect(result.page).toMatchObject({
      status: 'succeeded',
      engines: {
        'audiveris-5': {
          status: 'succeeded',
          providerRequestId: 'audiveris-request',
          completeness: 'complete',
          artifacts: {
            musicXml: { objectKey: expect.stringMatching(/audiveris-5\.musicxml$/) },
            mei: { objectKey: expect.stringMatching(/audiveris-5\.mei$/) }
          }
        }
      }
    });
    expect([...stored.keys()]).toEqual([
      expect.stringMatching(/page-001-audiveris-5\.musicxml$/),
      expect.stringMatching(/page-001-audiveris-5\.mei$/)
    ]);
  });

  it('renders a page from the plan-selected fallback without HOMR-specific routing', async () => {
    const jobsModel = {
      updateOne: jest.fn(() => ({ exec: async () => ({}) }))
    } as any;
    const transcodaMusicXml = {
      bucket: 'scanner',
      objectKey: 'transcoda.musicxml',
      sizeBytes: 10,
      contentType: 'application/vnd.recordare.musicxml+xml',
      checksumSha256: 'transcoda-checksum'
    };
    const storage = {
      getObjectBuffer: jest.fn().mockResolvedValue(Buffer.from('<score-partwise/>')),
      putAuxiliaryObject: jest.fn(async (objectKey: string) => ({
        bucket: 'scanner',
        objectKey
      }))
    } as any;
    const renderer = {
      renderMusicXmlPdf: jest.fn().mockResolvedValue({
        pdf: Buffer.from('%PDF'),
        thumbnail: Buffer.from('thumbnail')
      })
    } as any;
    const scannerWorker = new ScannerWorkerService(
      jobsModel,
      storage,
      provider,
      transcodaProvider,
      renderer,
      merger,
      alerts,
      {} as any,
      telemetry,
      config
    ) as any;
    const job = {
      jobId: 'job-1',
      userId: 'user-1',
      enginePlan: scannerDefaultEnginePlan(true),
      pages: []
    };
    const page = {
      pageNumber: 1,
      ordinal: 1,
      included: true,
      status: 'succeeded',
      attempts: 1,
      idempotencyKey: 'homr-key',
      engines: {
        homr: {
          engine: 'homr',
          status: 'failed',
          attempts: 1,
          idempotencyKey: 'homr-key',
          artifacts: {}
        },
        transcoda: {
          engine: 'transcoda',
          status: 'succeeded',
          attempts: 1,
          idempotencyKey: 'transcoda-key',
          artifacts: { musicXml: transcodaMusicXml }
        }
      }
    };

    const result = await scannerWorker.renderEffectivePage(job, page, 'user-hash');

    expect(storage.getObjectBuffer).toHaveBeenCalledWith('scanner', 'transcoda.musicxml');
    expect(renderer.renderMusicXmlPdf).toHaveBeenCalledWith(Buffer.from('<score-partwise/>'));
    expect(result.page.pdf).toMatchObject({
      objectKey: expect.stringMatching(/page-001\.pdf$/),
      inputSignature: expect.stringMatching(/^scanner-artifact-input-v1:/)
    });
    expect(result.thumbnail).toEqual(Buffer.from('thumbnail'));
  });

  it('keeps a successful HOMR page usable when Transcoda fails', async () => {
    values.SCANNER_TRANSCODA_ENABLED = 'true';
    transcodaProvider.scanPage.mockRejectedValue(
      new ScannerProviderError('no staff', 'provider_no_staff_detected', false)
    );
    const scannerWorker = new ScannerWorkerService(
      {} as any,
      {} as any,
      provider,
      transcodaProvider,
      {} as any,
      merger,
      alerts,
      {} as any,
      telemetry,
      config
    ) as any;
    const homrMusicXml = { bucket: 'scanner', objectKey: 'homr.musicxml' };

    const result = await scannerWorker.scanEnginePage({
      job: { jobId: 'job-1', userId: 'user-1', generation: 1 },
      page: {
        pageNumber: 1,
        ordinal: 1,
        included: true,
        status: 'succeeded',
        attempts: 1,
        idempotencyKey: 'homr-key',
        musicXml: homrMusicXml,
        engines: {
          homr: {
            engine: 'homr',
            status: 'succeeded',
            attempts: 1,
            idempotencyKey: 'homr-key',
            artifacts: { musicXml: homrMusicXml }
          }
        }
      },
      image: Buffer.from('image'),
      contentType: 'image/png',
      pageNumber: 1,
      detectTitle: false,
      userHash: 'user-hash',
      definition: scannerWorker.engineRegistry().get('transcoda')
    });

    expect(result.page).toMatchObject({
      status: 'succeeded',
      musicXml: homrMusicXml,
      engines: {
        homr: { status: 'succeeded' },
        transcoda: {
          status: 'failed',
          errorCode: 'provider_no_staff_detected'
        }
      }
    });
  });

  describe('disablesProvider', () => {
    it('stops the worker when the provider is not the one we pinned', () => {
      // Continuing would produce output we cannot vouch for.
      for (const code of [
        'provider_service_revision_mismatch',
        'provider_model_revision_mismatch',
        'provider_model_artifact_mismatch',
        'provider_container_image_mismatch',
        'provider_converter_mismatch',
        'provider_execution_provider_mismatch',
        'provider_engine_mismatch',
        'provider_missing_artifact',
        'provider_input_digest_mismatch'
      ]) {
        expect(disablesProvider(code)).toBe(true);
      }
    });

    it('stops the worker when capacity is gone', () => {
      // The next page cannot succeed either, and this is what makes it alert:
      // otherwise the only symptom is a queue that reports as `queue_stalled`
      // and names the wrong cause — or, with nothing queued, silence.
      expect(disablesProvider('provider_budget_exhausted')).toBe(true);
    });

    it('lets an ordinary page failure fail only that page', () => {
      for (const code of [
        'provider_timeout',
        'provider_unavailable',
        'no_staff_detected',
        'invalid_musicxml',
        'generation_failed'
      ]) {
        expect(disablesProvider(code)).toBe(false);
      }
    });
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
      transcodaProvider,
      {} as any,
      merger,
      alerts,
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
      transcodaProvider,
      {} as any,
      merger,
      alerts,
      {} as any,
      telemetry,
      config
    ) as any;
    const workerId = scannerWorker.workerId;
    const job = { jobId: 'job-1', pageCount: 1, pages: [] };

    await scannerWorker.persistPageProgress(job, [], new Map(), undefined, 'service', 'model');
    expect(updateOne.mock.calls[0][1].$set.pages[0].engines.homr).toMatchObject({
      engine: 'homr',
      status: 'pending',
      providerRevision: 'service',
      modelRevision: 'model'
    });
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
        transcodaProvider,
        {} as any,
        merger,
        alerts,
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
      transcodaProvider,
      {} as any,
      merger,
      alerts,
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
