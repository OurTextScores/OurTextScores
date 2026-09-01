import { createHash } from 'node:crypto';
import { ScannerOtsHomrProviderService } from './scanner-ots-homr-provider.service';

describe('ScannerOtsHomrProviderService', () => {
  const image = Buffer.from('page-image');
  const musicXml = Buffer.from(
    '<score-partwise version="4.0"><part-list><score-part id="P1"/></part-list>' +
      '<part id="P1"><measure number="1"/></part></score-partwise>'
  );
  const values: Record<string, string> = {
    SCANNER_OTS_HOMR_PROVIDER_KIND: 'modal',
    SCANNER_OTS_HOMR_PROVIDER_URL: 'https://ots-homr.example',
    SCANNER_OTS_HOMR_MODAL_TOKEN_ID: 'modal-id',
    SCANNER_OTS_HOMR_MODAL_TOKEN_SECRET: 'modal-secret',
    SCANNER_EXPECTED_OTS_HOMR_PROVIDER_REVISION: 'ots-homr-provider-v1',
    SCANNER_EXPECTED_OTS_HOMR_CORE_REPOSITORY: 'jhlusko/OTS-homr',
    SCANNER_EXPECTED_OTS_HOMR_CORE_REVISION: 'core-revision',
    SCANNER_EXPECTED_OTS_HOMR_CORE_SHA256: 'a'.repeat(64),
    SCANNER_EXPECTED_OTS_HOMR_EXECUTION_PROVIDER: 'CUDAExecutionProvider',
    SCANNER_EXPECTED_OTS_HOMR_LYRICS_REVISION: 'lyrics-revision',
    SCANNER_EXPECTED_OTS_HOMR_LYRICS_SHA256: 'b'.repeat(64),
    SCANNER_EXPECTED_OTS_HOMR_HEADS_REVISION: 'heads-revision',
    SCANNER_EXPECTED_OTS_HOMR_HEADS_SHA256: 'c'.repeat(64),
    SCANNER_EXPECTED_OTS_HOMR_HEADS_MANIFEST_SHA256: 'd'.repeat(64)
  };
  const config = {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback)
  } as any;
  const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const options = {
    textDetector: 'lyrics' as const,
    structuredHeads: { mode: 'review-only' as const }
  };

  const envelope = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 'ots-ots-homr-provider.v1',
    requestId: 'ots-homr-request',
    inputSha256: sha256(image),
    engine: {
      name: 'ots-homr',
      serviceRevision: 'ots-homr-provider-v1',
      core: {
        repository: 'jhlusko/OTS-homr',
        revision: 'core-revision',
        sha256: 'a'.repeat(64)
      },
      textDetector: { id: 'lyrics', revision: 'lyrics-revision', sha256: 'b'.repeat(64) },
      structuredHeads: {
        mode: 'review-only',
        revision: 'heads-revision',
        sha256: 'c'.repeat(64),
        manifestSha256: 'd'.repeat(64),
        compatibleCoreRevision: 'core-revision',
        emittedHeadFamilies: ['beam.group', 'advance.warning']
      },
      executionProvider: 'CUDAExecutionProvider'
    },
    result: { musicXmlBase64: musicXml.toString('base64'), musicXmlSha256: sha256(musicXml) },
    review: {
      staves: [
        {
          index: 0,
          partIndex: 0,
          systemIndex: 0,
          region: [0, 0, 100, 20],
          tokens: [['note_4', 'C4', '_', '_', '_', 'upper']],
          symbols: []
        }
      ]
    },
    timing: { inferenceMs: 42 },
    ...overrides
  });

  const scan = () =>
    new ScannerOtsHomrProviderService(config).scanPage({
      image,
      filename: 'page.png',
      contentType: 'image/png',
      detectTitle: false,
      idempotencyKey: 'e'.repeat(64),
      engineOptions: options
    });

  afterEach(() => jest.restoreAllMocks());

  it('accepts the selected detector and review-only heads only with pinned provenance', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://ots-homr.example/v1/scan-page');
      expect(new Headers(init?.headers).get('Modal-Key')).toBe('modal-id');
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify(envelope()), { status: 200 });
    });

    await expect(scan()).resolves.toMatchObject({
      engine: 'ots-homr',
      musicXml,
      providerRevision: 'ots-homr-provider-v1',
      modelRevision: 'core-revision',
      provenance: {
        modelArtifact: 'jhlusko/OTS-homr',
        modelArtifactSha256: 'a'.repeat(64),
        executionProvider: 'CUDAExecutionProvider'
      },
      review: { staves: [expect.objectContaining({ index: 0 })] }
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects an additional-head response that claims a dynamic output', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify(
          envelope({
            engine: {
              ...envelope().engine,
              structuredHeads: {
                ...envelope().engine.structuredHeads,
                emittedHeadFamilies: ['dynamic.mark']
              }
            }
          })
        ),
        { status: 200 }
      )
    );

    await expect(scan()).rejects.toMatchObject({
      code: 'provider_invalid_response',
      retryable: false
    });
  });

  it('uses the chosen detector and head policy in idempotency identity', () => {
    const service = new ScannerOtsHomrProviderService(config);
    const base = { inputSha256: 'f'.repeat(64), pageNumber: 1, detectTitle: false, generation: 1 };
    expect(service.createIdempotencyKey({ ...base, engineOptions: options })).not.toBe(
      service.createIdempotencyKey({
        ...base,
        engineOptions: { textDetector: 'none', structuredHeads: { mode: 'off' } }
      })
    );
  });

  it('regenerates reviewed OTS-HOMR tokens through its own provider', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ result: { musicXmlBase64: musicXml.toString('base64') } }), {
          status: 200
        })
      );
    const staffs = [[['note_4', 'C4', '_', '_', '_', 'upper']]];

    await expect(
      new ScannerOtsHomrProviderService(config).regenerateReview(staffs)
    ).resolves.toEqual(musicXml);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://ots-homr.example/v1/regenerate');
    expect(fetchSpy.mock.calls[0][1]?.body).toBe(JSON.stringify({ staffs }));
  });
});
