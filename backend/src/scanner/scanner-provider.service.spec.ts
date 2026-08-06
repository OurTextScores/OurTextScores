import { ScannerProviderService } from './scanner-provider.service';
import { ScannerProviderError } from './scanner.errors';
import { createHash } from 'node:crypto';

describe('ScannerProviderService', () => {
  const values: Record<string, string> = {
    SCANNER_PROVIDER_KIND: 'fake',
    SCANNER_EXPECTED_HOMR_COMMIT: 'homr-revision'
  };
  const config = {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback)
  } as any;

  beforeEach(() => jest.clearAllMocks());

  it('builds stable idempotency keys from page identity and options', () => {
    const service = new ScannerProviderService(config);
    const first = service.createIdempotencyKey({
      inputSha256: 'abc',
      pageNumber: 1,
      detectTitle: false,
      generation: 1
    });
    const same = service.createIdempotencyKey({
      inputSha256: 'abc',
      pageNumber: 1,
      detectTitle: false,
      generation: 1
    });
    const nextPage = service.createIdempotencyKey({
      inputSha256: 'abc',
      pageNumber: 2,
      detectTitle: false,
      generation: 1
    });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(same).toBe(first);
    expect(nextPage).not.toBe(first);
  });

  it('returns deterministic valid MusicXML from the CI fake', async () => {
    const service = new ScannerProviderService(config);
    const result = await service.scanPage({
      image: Buffer.from('image'),
      filename: 'page.png',
      contentType: 'image/png',
      detectTitle: false,
      idempotencyKey: 'a'.repeat(64)
    });
    expect(result.musicXml.toString('utf8')).toContain('<score-partwise');
    expect(result.modelRevision).toBe('homr-revision');
  });

  it('can deterministically model a transient first-generation page failure', async () => {
    values.SCANNER_FAKE_TRANSIENT_FAILURE_PAGE = '2';
    const service = new ScannerProviderService(config);
    const input = {
      image: Buffer.from('image'),
      contentType: 'image/png',
      detectTitle: false,
      idempotencyKey: 'd'.repeat(64)
    };
    await expect(
      service.scanPage({ ...input, filename: 'page-2-generation-1.png' })
    ).rejects.toMatchObject({ code: 'provider_http_503', retryable: true });
    await expect(
      service.scanPage({ ...input, filename: 'page-2-generation-2.png' })
    ).resolves.toMatchObject({ modelRevision: 'homr-revision' });
    delete values.SCANNER_FAKE_TRANSIENT_FAILURE_PAGE;
  });

  it('classifies provider capacity errors as retryable', async () => {
    values.SCANNER_PROVIDER_KIND = 'modal';
    values.SCANNER_PROVIDER_URL = 'https://scanner.example';
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('busy', { status: 503 }));
    const service = new ScannerProviderService(config);
    await expect(
      service.scanPage({
        image: Buffer.from('image'),
        filename: 'page.png',
        contentType: 'image/png',
        detectTitle: false,
        idempotencyKey: 'b'.repeat(64)
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ScannerProviderError>>({
        code: 'provider_http_503',
        retryable: true
      })
    );
    fetchSpy.mockRestore();
    values.SCANNER_PROVIDER_KIND = 'fake';
    delete values.SCANNER_PROVIDER_URL;
  });

  it('accepts only matching input, service, model, and execution provenance', async () => {
    values.SCANNER_PROVIDER_KIND = 'modal';
    values.SCANNER_PROVIDER_URL = 'https://scanner.example';
    values.SCANNER_EXPECTED_PROVIDER_REVISION = 'ots-homr-modal-v1';
    values.SCANNER_EXPECTED_EXECUTION_PROVIDER = 'CUDAExecutionProvider';
    const image = Buffer.from('image');
    const musicXml = Buffer.from(
      '<score-partwise><part-list><score-part id="P1"/></part-list><part id="P1"><measure number="1"/></part></score-partwise>'
    );
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          serviceRevision: 'ots-homr-modal-v1',
          modelRevision: 'homr-revision',
          executionProvider: 'CUDAExecutionProvider',
          inputSha256: createHash('sha256').update(image).digest('hex'),
          musicXmlBase64: musicXml.toString('base64')
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const service = new ScannerProviderService(config);
    await expect(
      service.scanPage({
        image,
        filename: 'page.png',
        contentType: 'image/png',
        detectTitle: false,
        idempotencyKey: 'c'.repeat(64)
      })
    ).resolves.toEqual(
      expect.objectContaining({
        providerRevision: 'ots-homr-modal-v1',
        modelRevision: 'homr-revision',
        musicXml
      })
    );
    fetchSpy.mockRestore();
    values.SCANNER_PROVIDER_KIND = 'fake';
    delete values.SCANNER_PROVIDER_URL;
    delete values.SCANNER_EXPECTED_PROVIDER_REVISION;
    delete values.SCANNER_EXPECTED_EXECUTION_PROVIDER;
  });

  it('authenticates a CPU provider and accepts its explicit provenance', async () => {
    values.SCANNER_PROVIDER_KIND = 'local';
    values.SCANNER_PROVIDER_URL = 'http://homr_cpu:8000';
    values.SCANNER_PROVIDER_TOKEN = 'local-token';
    values.SCANNER_EXPECTED_PROVIDER_REVISION = 'ots-homr-cpu-v1';
    values.SCANNER_EXPECTED_EXECUTION_PROVIDER = 'CPUExecutionProvider';
    const image = Buffer.from('cpu-image');
    const musicXml = Buffer.from(
      '<score-partwise><part-list><score-part id="P1"/></part-list><part id="P1"><measure number="1"/></part></score-partwise>'
    );
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer local-token');
      return new Response(
        JSON.stringify({
          serviceRevision: 'ots-homr-cpu-v1',
          modelRevision: 'homr-revision',
          executionProvider: 'CPUExecutionProvider',
          inputSha256: createHash('sha256').update(image).digest('hex'),
          musicXmlBase64: musicXml.toString('base64')
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const service = new ScannerProviderService(config);

    await expect(
      service.scanPage({
        image,
        filename: 'page.png',
        contentType: 'image/png',
        detectTitle: false,
        idempotencyKey: 'e'.repeat(64)
      })
    ).resolves.toMatchObject({
      providerRevision: 'ots-homr-cpu-v1',
      modelRevision: 'homr-revision',
      musicXml
    });

    fetchSpy.mockRestore();
    values.SCANNER_PROVIDER_KIND = 'fake';
    delete values.SCANNER_PROVIDER_URL;
    delete values.SCANNER_PROVIDER_TOKEN;
    delete values.SCANNER_EXPECTED_PROVIDER_REVISION;
    delete values.SCANNER_EXPECTED_EXECUTION_PROVIDER;
  });
});
