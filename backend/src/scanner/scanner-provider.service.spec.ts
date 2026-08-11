import { ScannerProviderService } from './scanner-provider.service';
import { isRetryableScannerErrorCode, ScannerProviderError } from './scanner.errors';
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
          musicXmlBase64: musicXml.toString('base64'),
          review: {
            staves: [
              {
                index: 0,
                partIndex: 0,
                systemIndex: 1,
                region: [0, 0, 100, 50],
                tokens: [],
                symbols: []
              },
              {
                index: 1,
                partIndex: '0',
                systemIndex: null,
                region: [0, 50, 100, 100],
                tokens: [],
                symbols: []
              }
            ]
          }
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
        musicXml,
        review: {
          staves: [
            expect.objectContaining({ index: 0, partIndex: 0, systemIndex: 1 }),
            expect.not.objectContaining({ partIndex: expect.anything() })
          ]
        }
      })
    );
    fetchSpy.mockRestore();
    values.SCANNER_PROVIDER_KIND = 'fake';
    delete values.SCANNER_PROVIDER_URL;
    delete values.SCANNER_EXPECTED_PROVIDER_REVISION;
    delete values.SCANNER_EXPECTED_EXECUTION_PROVIDER;
  });

  it('does not send Modal credentials to a local provider', async () => {
    // Modal credentials commonly sit in the same environment used to run the
    // local CPU provider. Applying them regardless of kind overwrote the local
    // bearer token, and the provider answered 401 while the local token was
    // set correctly — a confusing failure to diagnose from the caller's side.
    values.SCANNER_PROVIDER_KIND = 'local';
    values.SCANNER_PROVIDER_URL = 'http://homr_cpu:8000';
    values.SCANNER_PROVIDER_TOKEN = 'ots-local-development';
    values.SCANNER_MODAL_TOKEN_ID = 'ak-modal';
    values.SCANNER_MODAL_TOKEN_SECRET = 'as-modal';
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const service = new ScannerProviderService(config);
    await service
      .scanPage({
        image: Buffer.from('image'),
        filename: 'page.png',
        contentType: 'image/png',
        detectTitle: false,
        idempotencyKey: 'b'.repeat(64)
      })
      .catch(() => undefined);

    const headers = fetchSpy.mock.calls[0][1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer ots-local-development');
    expect(headers.get('Modal-Key')).toBeNull();
    fetchSpy.mockRestore();
    values.SCANNER_PROVIDER_KIND = 'fake';
    delete values.SCANNER_PROVIDER_URL;
    delete values.SCANNER_PROVIDER_TOKEN;
    delete values.SCANNER_MODAL_TOKEN_ID;
    delete values.SCANNER_MODAL_TOKEN_SECRET;
  });

  it('still sends Modal credentials to a Modal provider', async () => {
    values.SCANNER_PROVIDER_KIND = 'modal';
    values.SCANNER_PROVIDER_URL = 'https://scanner.example';
    values.SCANNER_MODAL_TOKEN_ID = 'ak-modal';
    values.SCANNER_MODAL_TOKEN_SECRET = 'as-modal';
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const service = new ScannerProviderService(config);
    await service
      .scanPage({
        image: Buffer.from('image'),
        filename: 'page.png',
        contentType: 'image/png',
        detectTitle: false,
        idempotencyKey: 'c'.repeat(64)
      })
      .catch(() => undefined);

    const headers = fetchSpy.mock.calls[0][1]?.headers as Headers;
    expect(headers.get('Modal-Key')).toBe('ak-modal');
    fetchSpy.mockRestore();
    values.SCANNER_PROVIDER_KIND = 'fake';
    delete values.SCANNER_PROVIDER_URL;
    delete values.SCANNER_MODAL_TOKEN_ID;
    delete values.SCANNER_MODAL_TOKEN_SECRET;
  });

  it('refuses to follow a redirect, so credentials cannot be forwarded', async () => {
    // `Modal-Key` and `Modal-Secret` are custom headers: the Fetch standard
    // strips `Authorization` on a cross-origin redirect but not these, so a
    // followed redirect would hand them to the target.
    values.SCANNER_PROVIDER_KIND = 'modal';
    values.SCANNER_PROVIDER_URL = 'https://scanner.example';
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const service = new ScannerProviderService(config);
    await service
      .scanPage({
        image: Buffer.from('image'),
        filename: 'page.png',
        contentType: 'image/png',
        detectTitle: false,
        idempotencyKey: 'd'.repeat(64)
      })
      .catch(() => undefined);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    fetchSpy.mockRestore();
    values.SCANNER_PROVIDER_KIND = 'fake';
    delete values.SCANNER_PROVIDER_URL;
  });

  it('rejects an oversized provider response before buffering it', async () => {
    values.SCANNER_PROVIDER_KIND = 'modal';
    values.SCANNER_PROVIDER_URL = 'https://scanner.example';
    values.SCANNER_MAX_PROVIDER_RESPONSE_BYTES = '1024';
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '99999999' }
      })
    );
    const service = new ScannerProviderService(config);
    await expect(
      service.scanPage({
        image: Buffer.from('image'),
        filename: 'page.png',
        contentType: 'image/png',
        detectTitle: false,
        idempotencyKey: 'e'.repeat(64)
      })
    ).rejects.toMatchObject({ code: 'provider_response_too_large' });
    fetchSpy.mockRestore();
    values.SCANNER_PROVIDER_KIND = 'fake';
    delete values.SCANNER_PROVIDER_URL;
    delete values.SCANNER_MAX_PROVIDER_RESPONSE_BYTES;
  });

  it('caps a chunked response that declares no length', async () => {
    // The declared-length check cannot help here; the read itself must stop.
    values.SCANNER_PROVIDER_KIND = 'modal';
    values.SCANNER_PROVIDER_URL = 'https://scanner.example';
    values.SCANNER_MAX_PROVIDER_RESPONSE_BYTES = '2048';
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(4096));
      }
    });
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(stream, { status: 200 }));
    const service = new ScannerProviderService(config);
    await expect(
      service.scanPage({
        image: Buffer.from('image'),
        filename: 'page.png',
        contentType: 'image/png',
        detectTitle: false,
        idempotencyKey: 'f'.repeat(64)
      })
    ).rejects.toMatchObject({ code: 'provider_response_too_large' });
    fetchSpy.mockRestore();
    values.SCANNER_PROVIDER_KIND = 'fake';
    delete values.SCANNER_PROVIDER_URL;
    delete values.SCANNER_MAX_PROVIDER_RESPONSE_BYTES;
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

  describe('provider error taxonomy', () => {
    beforeEach(() => {
      values.SCANNER_PROVIDER_KIND = 'modal';
      values.SCANNER_PROVIDER_URL = 'https://scanner.example';
    });
    afterEach(() => {
      jest.restoreAllMocks();
      values.SCANNER_PROVIDER_KIND = 'fake';
      delete values.SCANNER_PROVIDER_URL;
    });

    const failWith = (status: number, body: unknown) =>
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' }
        })
      );

    const scan = () =>
      new ScannerProviderService(config).scanPage({
        image: Buffer.from('image'),
        filename: 'page.png',
        contentType: 'image/png',
        detectTitle: false,
        idempotencyKey: '9'.repeat(64)
      });

    it('prefers the stable provider code over the HTTP status', async () => {
      // A blank page really returns this on the pinned HOMR commit.
      failWith(422, { error: { code: 'no_staff_detected', message: 'ignored' } });
      await expect(scan()).rejects.toMatchObject({
        code: 'provider_no_staff_detected',
        retryable: false,
        message: 'No staff lines were detected on this page'
      });
    });

    it('never retries a page whose score generation hit an invariant', async () => {
      // Recognition succeeds and MusicXML generation then trips an assert. The
      // same page fails identically every time, so a retry spends a second GPU
      // call for nothing — the failure mode `classify_homr_error` warns about.
      values.SCANNER_PROVIDER_KIND = 'modal';
      values.SCANNER_PROVIDER_URL = 'https://scanner.example';
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { code: 'generation_failed' } }), { status: 500 })
        );
      const service = new ScannerProviderService(config);
      await expect(
        service.scanPage({
          image: Buffer.from('image'),
          filename: 'page.png',
          contentType: 'image/png',
          detectTitle: false,
          idempotencyKey: 'a'.repeat(64)
        })
      ).rejects.toMatchObject({ code: 'provider_generation_failed', retryable: false });
      fetchSpy.mockRestore();
      values.SCANNER_PROVIDER_KIND = 'fake';
      delete values.SCANNER_PROVIDER_URL;
    });

    it('keeps an infrastructure failure retryable even though HOMR ran', async () => {
      failWith(500, { error: { code: 'inference_failed', message: 'ignored' } });
      await expect(scan()).rejects.toMatchObject({
        code: 'provider_inference_failed',
        retryable: true
      });
    });

    it('never surfaces provider-supplied error text to the caller', async () => {
      failWith(422, {
        error: { code: 'invalid_image', message: '<script>alert(1)</script> /tmp/secret' }
      });
      await expect(scan()).rejects.toMatchObject({
        message: 'This page image could not be read'
      });
    });

    it('recognises a Modal workspace disabled by its budget cap', async () => {
      // Verified live: Modal answers a budget-exhausted workspace with a
      // plain-text 404, not a structured error. Left to status classification
      // that is a non-retryable provider_http_404, which would also block the
      // manual retry the operator needs after raising the budget.
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response('modal-http: workspace ac-TPVb2sfO1mlTGNEzLL7vH3 is disabled', {
          status: 404
        })
      );
      await expect(scan()).rejects.toMatchObject({
        code: 'provider_budget_exhausted',
        // No automatic retry: capacity is gone until an operator acts...
        retryable: false,
        message: 'Scanner monthly capacity has been reached'
      });
      // ...but the page must still be retryable by hand afterwards.
      expect(isRetryableScannerErrorCode('provider_budget_exhausted')).toBe(true);
    });

    it('falls back to status classification for an unknown code', async () => {
      failWith(503, { error: { code: 'something_new' } });
      await expect(scan()).rejects.toMatchObject({
        code: 'provider_http_503',
        retryable: true
      });
    });
  });

  describe('provider response contract', () => {
    const image = Buffer.from('envelope-image');
    const validMusicXml =
      '<score-partwise version="4.0"><part-list><score-part id="P1"/></part-list>' +
      '<part id="P1"><measure number="1"/></part></score-partwise>';

    const respond = (body: Record<string, unknown>) =>
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );

    const scan = () =>
      new ScannerProviderService(config).scanPage({
        image,
        filename: 'page.png',
        contentType: 'image/png',
        detectTitle: false,
        idempotencyKey: 'f'.repeat(64)
      });

    const envelope = (overrides: Record<string, unknown> = {}) => ({
      schemaVersion: 'ots-homr-provider.v1',
      requestId: 'req-1',
      engine: {
        name: 'homr',
        homrCommit: 'homr-revision',
        serviceRevision: 'ots-homr-modal-v1',
        segmentationModel: 'segnet_308-abc',
        segmentationModelSha256: '1'.repeat(64),
        transformerModel: 'encoder_426-def.onnx',
        encoderModelSha256: '2'.repeat(64),
        decoderModelSha256: '3'.repeat(64),
        executionProvider: 'CUDAExecutionProvider'
      },
      result: {
        mediaType: 'application/vnd.recordare.musicxml+xml',
        musicXmlBase64: Buffer.from(validMusicXml).toString('base64'),
        sha256: createHash('sha256').update(Buffer.from(validMusicXml)).digest('hex')
      },
      inputSha256: createHash('sha256').update(image).digest('hex'),
      ...overrides
    });

    beforeEach(() => {
      values.SCANNER_PROVIDER_KIND = 'modal';
      values.SCANNER_PROVIDER_URL = 'https://scanner.example';
      values.SCANNER_EXPECTED_PROVIDER_REVISION = 'ots-homr-modal-v1';
      values.SCANNER_EXPECTED_EXECUTION_PROVIDER = 'CUDAExecutionProvider';
    });

    afterEach(() => {
      jest.restoreAllMocks();
      values.SCANNER_PROVIDER_KIND = 'fake';
      delete values.SCANNER_PROVIDER_URL;
      delete values.SCANNER_EXPECTED_PROVIDER_REVISION;
      delete values.SCANNER_EXPECTED_EXECUTION_PROVIDER;
    });

    it('separates provider recognition time from the caller wall clock', async () => {
      // Section 11.3. On a cold container the caller's wall clock is dominated
      // by the readiness wait — measured at 11,502 ms against 821 ms of actual
      // recognition — so the provider's own figure has to be carried through.
      respond(envelope({ timing: { totalMs: 11_502, inferenceMs: 821 } }));
      await expect(scan()).resolves.toMatchObject({ inferenceMs: 821 });
    });

    it('tolerates a provider that reports no timing block', async () => {
      respond(envelope());
      await expect(scan()).resolves.toMatchObject({ inferenceMs: undefined });
    });

    it('records the segmentation and transformer identities from the v1 envelope', async () => {
      respond(envelope());
      await expect(scan()).resolves.toMatchObject({
        providerRevision: 'ots-homr-modal-v1',
        modelRevision: 'homr-revision',
        requestId: 'req-1',
        provenance: {
          segmentationModel: 'segnet_308-abc',
          segmentationModelSha256: '1'.repeat(64),
          transformerModel: 'encoder_426-def.onnx',
          encoderModelSha256: '2'.repeat(64),
          decoderModelSha256: '3'.repeat(64),
          executionProvider: 'CUDAExecutionProvider'
        }
      });
    });

    it('fails closed when the declared output digest does not match', async () => {
      respond(envelope({ result: { ...envelope().result, sha256: '0'.repeat(64) } }));
      await expect(scan()).rejects.toMatchObject({
        code: 'provider_output_digest_mismatch',
        retryable: false
      });
    });

    it('rejects a DOCTYPE or entity declaration outright', async () => {
      const hostile =
        '<!DOCTYPE score [<!ENTITY a "aaaa">]>' +
        '<score-partwise><part-list><score-part id="P1"/></part-list>' +
        '<part id="P1"><measure number="1">&a;</measure></part></score-partwise>';
      respond(
        envelope({
          result: {
            musicXmlBase64: Buffer.from(hostile).toString('base64'),
            sha256: createHash('sha256').update(Buffer.from(hostile)).digest('hex')
          }
        })
      );
      await expect(scan()).rejects.toMatchObject({ code: 'invalid_musicxml' });
    });

    it('rejects XML that is not well formed rather than pattern matching it', async () => {
      // Contains every substring the old check looked for, but never closes
      // the measure element.
      const malformed =
        '<score-partwise><part-list><score-part id="P1"/></part-list>' +
        '<part id="P1"><measure number="1"></part></score-partwise>';
      respond(
        envelope({
          result: {
            musicXmlBase64: Buffer.from(malformed).toString('base64'),
            sha256: createHash('sha256').update(Buffer.from(malformed)).digest('hex')
          }
        })
      );
      await expect(scan()).rejects.toMatchObject({ code: 'invalid_musicxml' });
    });

    it('rejects a document nested past the configured depth limit', async () => {
      values.SCANNER_MAX_MUSICXML_DEPTH = '5';
      const deep =
        '<score-partwise><part-list><score-part id="P1"/></part-list><part id="P1">' +
        '<measure number="1">' +
        '<a>'.repeat(40) +
        '<b/>' +
        '</a>'.repeat(40) +
        '</measure></part></score-partwise>';
      respond(
        envelope({
          result: {
            musicXmlBase64: Buffer.from(deep).toString('base64'),
            sha256: createHash('sha256').update(Buffer.from(deep)).digest('hex')
          }
        })
      );
      await expect(scan()).rejects.toMatchObject({ code: 'invalid_musicxml' });
      delete values.SCANNER_MAX_MUSICXML_DEPTH;
    });

    it('rejects a well formed document with the wrong root element', async () => {
      const wrongRoot = '<html><body><measure/></body></html>';
      respond(
        envelope({
          result: {
            musicXmlBase64: Buffer.from(wrongRoot).toString('base64'),
            sha256: createHash('sha256').update(Buffer.from(wrongRoot)).digest('hex')
          }
        })
      );
      await expect(scan()).rejects.toMatchObject({ code: 'invalid_musicxml' });
    });
  });
});
