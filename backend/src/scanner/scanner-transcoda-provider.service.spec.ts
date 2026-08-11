import { createHash } from 'node:crypto';
import { ScannerTranscodaProviderService } from './scanner-transcoda-provider.service';

describe('ScannerTranscodaProviderService', () => {
  const values: Record<string, string> = {
    SCANNER_TRANSCODA_PROVIDER_KIND: 'modal',
    SCANNER_TRANSCODA_PROVIDER_URL: 'https://transcoda.example',
    SCANNER_MODAL_TOKEN_ID: 'modal-id',
    SCANNER_MODAL_TOKEN_SECRET: 'modal-secret',
    SCANNER_EXPECTED_TRANSCODA_PROVIDER_REVISION: 'ots-transcoda-modal-v1',
    SCANNER_EXPECTED_TRANSCODA_MODEL_ARTIFACT: 'btrkeks/transcoda-59M-zeroshot-v1',
    SCANNER_EXPECTED_TRANSCODA_MODEL_REVISION: 'model-revision',
    SCANNER_EXPECTED_TRANSCODA_MODEL_SHA256: 'a'.repeat(64),
    SCANNER_EXPECTED_TRANSCODA_CONTAINER_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
    SCANNER_EXPECTED_TRANSCODA_CONVERTER: 'music21',
    SCANNER_EXPECTED_TRANSCODA_CONVERTER_VERSION: '9.9.1',
    SCANNER_EXPECTED_TRANSCODA_EXECUTION_PROVIDER: 'torch.cuda'
  };
  const config = {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback)
  } as any;
  const image = Buffer.from('page-image');
  const kern = Buffer.from('**kern\n*clefG2\n4c\n*-\n');
  const musicXml = Buffer.from(
    '<score-partwise version="4.0"><part-list><score-part id="P1"/></part-list>' +
      '<part id="P1"><measure number="1"/></part></score-partwise>'
  );

  const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');

  const envelope = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 'ots-transcoda-provider.v1',
    requestId: 'transcoda-request',
    inputSha256: sha256(image),
    engine: {
      name: 'transcoda',
      serviceRevision: 'ots-transcoda-modal-v1',
      modelRevision: 'model-revision',
      modelArtifact: 'btrkeks/transcoda-59M-zeroshot-v1',
      modelArtifactSha256: 'a'.repeat(64),
      containerImageDigest: `sha256:${'c'.repeat(64)}`,
      converter: 'music21',
      converterVersion: '9.9.1',
      executionProvider: 'torch.cuda'
    },
    result: {
      kernBase64: kern.toString('base64'),
      kernSha256: sha256(kern),
      musicXmlBase64: musicXml.toString('base64'),
      musicXmlSha256: sha256(musicXml),
      generation: {
        hitMaxLength: false,
        sawEos: true,
        truncated: false,
        maxLength: 2048,
        numBeams: 3
      }
    },
    timing: { inferenceMs: 123 },
    ...overrides
  });

  const scan = () =>
    new ScannerTranscodaProviderService(config).scanPage({
      image,
      filename: 'page.png',
      contentType: 'image/png',
      detectTitle: false,
      idempotencyKey: 'f'.repeat(64)
    });

  afterEach(() => jest.restoreAllMocks());

  it('accepts pinned kern and converted MusicXML through the shared transport', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://transcoda.example/v1/scan-page');
      const headers = new Headers(init?.headers);
      expect(headers.get('Modal-Key')).toBe('modal-id');
      expect(headers.get('Modal-Secret')).toBe('modal-secret');
      expect(init?.redirect).toBe('error');
      return new Response(JSON.stringify(envelope()), { status: 200 });
    });

    await expect(scan()).resolves.toMatchObject({
      engine: 'transcoda',
      kern,
      musicXml,
      musicXmlSha256: sha256(musicXml),
      providerRevision: 'ots-transcoda-modal-v1',
      modelRevision: 'model-revision',
      requestId: 'transcoda-request',
      inferenceMs: 123,
      completeness: 'complete',
      generation: {
        hitMaxLength: false,
        sawEos: true,
        truncated: false,
        maxLength: 2048,
        numBeams: 3
      },
      provenance: {
        modelArtifact: 'btrkeks/transcoda-59M-zeroshot-v1',
        modelArtifactSha256: 'a'.repeat(64),
        containerImageDigest: `sha256:${'c'.repeat(64)}`,
        converter: 'music21',
        converterVersion: '9.9.1',
        executionProvider: 'torch.cuda'
      }
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('requires and preserves decoder termination diagnostics', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify(
          envelope({
            result: {
              ...envelope().result,
              generation: {
                hitMaxLength: true,
                sawEos: false,
                truncated: true,
                maxLength: 2048,
                numBeams: 3
              }
            }
          })
        ),
        { status: 200 }
      )
    );
    await expect(scan()).resolves.toMatchObject({
      completeness: 'incomplete',
      generation: { hitMaxLength: true, sawEos: false, truncated: true, maxLength: 2048 }
    });

    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify(
            envelope({ result: { ...envelope().result, generation: { truncated: false } } })
          ),
          { status: 200 }
        )
      );
    await expect(scan()).rejects.toMatchObject({
      code: 'provider_invalid_response',
      retryable: false
    });
  });

  it('fails closed when the model artifact is not the configured one', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify(
          envelope({
            engine: { ...envelope().engine, modelArtifactSha256: 'b'.repeat(64) }
          })
        ),
        { status: 200 }
      )
    );

    await expect(scan()).rejects.toMatchObject({
      code: 'provider_model_artifact_mismatch',
      retryable: false
    });
  });

  it('rejects malformed kern even when its declared digest is correct', async () => {
    const malformed = Buffer.from('**kern\n4c\n');
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify(
          envelope({
            result: {
              ...envelope().result,
              kernBase64: malformed.toString('base64'),
              kernSha256: sha256(malformed)
            }
          })
        ),
        { status: 200 }
      )
    );

    await expect(scan()).rejects.toMatchObject({
      code: 'provider_invalid_kern',
      retryable: false
    });
  });

  it('rejects music21 output until the provider strips its DOCTYPE', async () => {
    const withDoctype = Buffer.from(
      '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">' +
        musicXml.toString('utf8')
    );
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify(
          envelope({
            result: {
              ...envelope().result,
              musicXmlBase64: withDoctype.toString('base64'),
              musicXmlSha256: sha256(withDoctype)
            }
          })
        ),
        { status: 200 }
      )
    );

    await expect(scan()).rejects.toMatchObject({ code: 'invalid_musicxml' });
  });

  it('uses Transcoda identity in stable idempotency keys', () => {
    const service = new ScannerTranscodaProviderService(config);
    const input = {
      inputSha256: 'page',
      pageNumber: 1,
      detectTitle: false,
      generation: 1
    };
    const key = service.createIdempotencyKey(input);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).toBe(service.createIdempotencyKey(input));
    const converterVersion = values.SCANNER_EXPECTED_TRANSCODA_CONVERTER_VERSION;
    values.SCANNER_EXPECTED_TRANSCODA_CONVERTER_VERSION = 'next-converter';
    expect(service.createIdempotencyKey(input)).not.toBe(key);
    values.SCANNER_EXPECTED_TRANSCODA_CONVERTER_VERSION = converterVersion;
  });

  it('refuses to spend a provider call without immutable provenance pins', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const revision = values.SCANNER_EXPECTED_TRANSCODA_MODEL_REVISION;
    delete values.SCANNER_EXPECTED_TRANSCODA_MODEL_REVISION;
    await expect(scan()).rejects.toMatchObject({
      code: 'provider_not_configured',
      retryable: false
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    values.SCANNER_EXPECTED_TRANSCODA_MODEL_REVISION = revision;
  });

  it('refuses malformed provenance pins before contacting the provider', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const modelSha256 = values.SCANNER_EXPECTED_TRANSCODA_MODEL_SHA256;
    values.SCANNER_EXPECTED_TRANSCODA_MODEL_SHA256 = 'not-a-sha256';
    await expect(scan()).rejects.toMatchObject({ code: 'provider_not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
    values.SCANNER_EXPECTED_TRANSCODA_MODEL_SHA256 = modelSha256;
  });
});
