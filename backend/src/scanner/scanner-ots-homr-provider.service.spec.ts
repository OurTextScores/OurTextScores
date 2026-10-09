import { createHash } from 'node:crypto';
import { ScannerOtsHomrProviderService } from './scanner-ots-homr-provider.service';
import { isMergedGrandStaffDeviation } from './scanner-profile-findings';

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
    SCANNER_EXPECTED_OTS_HOMR_PROVIDER_REVISION: 'ots-homr-provider-v2',
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
  const options = { textDetector: 'lyrics' as const };

  const structured = {
    beamLevels: ['none'],
    stem: 'up',
    tie: 'none',
    slurs: [],
    dynamic: 'f',
    advance: 'normal'
  };
  const review = {
    title: 'Example',
    regeneration: [
      {
        tokens: [['note_8', 'D4', '_', '_', '_', 'upper']],
        structured: [{ ...structured, stem: 'down' }]
      }
    ],
    staves: [
      {
        index: 0,
        partIndex: 0,
        systemIndex: 0,
        region: [0, 0, 100, 20],
        tokens: [['note_4', 'C4', '_', '_', '_', 'upper']],
        structured: [structured],
        symbols: []
      }
    ]
  };

  const envelope = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 'ots-ots-homr-provider.v2',
    requestId: 'ots-homr-request',
    inputSha256: sha256(image),
    engine: {
      name: 'ots-homr',
      serviceRevision: 'ots-homr-provider-v2',
      core: {
        repository: 'jhlusko/OTS-homr',
        revision: 'core-revision',
        sha256: 'a'.repeat(64)
      },
      textDetector: { id: 'lyrics', revision: 'lyrics-revision', sha256: 'b'.repeat(64) },
      structuredHeads: {
        mode: 'both',
        revision: 'heads-revision',
        sha256: 'c'.repeat(64),
        manifestSha256: 'd'.repeat(64),
        compatibleCoreRevision: 'core-revision',
        emittedHeadFamilies: ['beam.level', 'advance.delta', 'stem.direction', 'tie', 'slur']
      },
      executionProvider: 'CUDAExecutionProvider'
    },
    result: {
      selectedCandidate: 'core',
      candidates: {
        core: {
          musicXmlBase64: musicXml.toString('base64'),
          musicXmlSha256: sha256(musicXml),
          review
        },
        'additional-heads': {
          musicXmlBase64: musicXml.toString('base64'),
          musicXmlSha256: sha256(musicXml),
          review
        }
      }
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

  it('accepts both output candidates with pinned provenance and retains proposals', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://ots-homr.example/v1/scan-page');
      expect(new Headers(init?.headers).get('Modal-Key')).toBe('modal-id');
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify(envelope()), { status: 200 });
    });

    const result = await scan();
    expect(result).toMatchObject({
      engine: 'ots-homr',
      musicXml,
      providerRevision: 'ots-homr-provider-v2',
      modelRevision: 'core-revision',
      provenance: {
        modelArtifact: 'jhlusko/OTS-homr',
        modelArtifactSha256: 'a'.repeat(64),
        executionProvider: 'CUDAExecutionProvider'
      },
      review: { staves: [expect.objectContaining({ index: 0 })] },
      availableStructuredHeadFamilies: ['beam', 'advance', 'stem', 'tie', 'slur'],
      outputCandidates: {
        core: { artifactKind: 'musicxml' },
        'all-structured': { artifactKind: 'additional-heads-musicxml' }
      },
      nativeArtifacts: {
        'additional-heads-musicxml': musicXml,
        'structured-heads': expect.any(Buffer)
      }
    });
    expect(JSON.parse(result.nativeArtifacts!['structured-heads'].toString('utf8'))).toMatchObject({
      staves: [[['note_8', 'D4', '_', '_', '_', 'upper']]],
      structured: [[expect.objectContaining({ stem: 'down' })]]
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

  it('uses the chosen detector in idempotency identity', () => {
    const service = new ScannerOtsHomrProviderService(config);
    const base = { inputSha256: 'f'.repeat(64), pageNumber: 1, detectTitle: false, generation: 1 };
    expect(service.createIdempotencyKey({ ...base, engineOptions: options })).not.toBe(
      service.createIdempotencyKey({
        ...base,
        engineOptions: { textDetector: 'none' }
      })
    );
  });

  it('fails a fusion request closed until the server flag and pins are configured', async () => {
    const service = new ScannerOtsHomrProviderService(config);
    const base = { inputSha256: 'f'.repeat(64), pageNumber: 1, detectTitle: false, generation: 1 };
    expect(
      service.createIdempotencyKey({
        ...base,
        engineOptions: { textPolicy: { mode: 'fusion-v1' } }
      })
    ).not.toBe(service.createIdempotencyKey({ ...base, engineOptions: options }));
    await expect(
      service.scanPage({
        image,
        filename: 'page.png',
        contentType: 'image/png',
        detectTitle: false,
        idempotencyKey: 'e'.repeat(64),
        engineOptions: { textPolicy: { mode: 'fusion-v1' } }
      })
    ).rejects.toMatchObject({ code: 'provider_invalid_response' });
  });

  it('verifies all three logical fusion pins and retains bounded review evidence', async () => {
    Object.assign(values, {
      SCANNER_OTS_HOMR_FUSION_ENABLED: '1',
      SCANNER_EXPECTED_OTS_HOMR_NON_LYRIC_TEXT_REVISION: 'non-lyric-revision',
      SCANNER_EXPECTED_OTS_HOMR_NON_LYRIC_TEXT_SHA256: 'e'.repeat(64),
      SCANNER_EXPECTED_OTS_HOMR_DYNAMICS_REVISION: 'non-lyric-revision',
      SCANNER_EXPECTED_OTS_HOMR_DYNAMICS_SHA256: 'e'.repeat(64),
      SCANNER_EXPECTED_OTS_HOMR_FUSION_CALIBRATION_REVISION: 'fusion-calibration'
    });
    try {
      const base = envelope();
      const fused = envelope({
        engine: {
          ...base.engine,
          textDetector: undefined,
          textPolicy: {
            mode: 'fusion-v1',
            fusionRevision: 'fusion-v1',
            calibrationRevision: 'fusion-calibration',
            detectors: [
              { id: 'lyrics', revision: 'lyrics-revision', sha256: 'b'.repeat(64) },
              { id: 'non-lyric-text', revision: 'non-lyric-revision', sha256: 'e'.repeat(64) },
              { id: 'dynamics', revision: 'non-lyric-revision', sha256: 'e'.repeat(64) }
            ]
          }
        },
        result: {
          ...base.result,
          fusionSummary: {
            accepted: 0,
            review: 0,
            reviewOmitted: 0,
            rejected: 0,
            rejectedByReason: {},
            rejectedByClass: {},
            byClass: {}
          },
          fusedRegions: []
        }
      });
      jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
        expect((init?.body as FormData).get('textPolicy')).toBe('{"mode":"fusion-v1"}');
        expect((init?.body as FormData).get('textDetector')).toBeNull();
        return new Response(JSON.stringify(fused), { status: 200 });
      });
      const result = await new ScannerOtsHomrProviderService(config).scanPage({
        image,
        filename: 'page.png',
        contentType: 'image/png',
        detectTitle: false,
        idempotencyKey: 'e'.repeat(64),
        engineOptions: { textPolicy: { mode: 'fusion-v1' } }
      });
      expect(
        JSON.parse(result.nativeArtifacts!['text-fusion-review'].toString('utf8'))
      ).toMatchObject({ fusionSummary: { accepted: 0, review: 0, rejected: 0 } });
      // OCR rows are optional; a well-formed set is carried, a malformed row fails the contract.
      const row = {
        box: [1, 2, 30, 40],
        text: 'kind,',
        ocrConfidence: 0.99,
        regionCoverage: 0.8,
        semantic: 'Lyrics',
        semanticScore: 0.84,
        proposedLyric: true
      };
      (fused.result as any).lyricText = { status: 'ok', rows: [row], rowsOmitted: 0 };
      const withText = await new ScannerOtsHomrProviderService(config).scanPage({
        image,
        filename: 'page.png',
        contentType: 'image/png',
        detectTitle: false,
        idempotencyKey: '9'.repeat(64),
        engineOptions: { textPolicy: { mode: 'fusion-v1' } }
      });
      expect(
        JSON.parse(withText.nativeArtifacts!['text-fusion-review'].toString('utf8')).lyricText
          .rows[0].text
      ).toBe('kind,');
      (fused.result as any).lyricText = {
        status: 'ok',
        rows: [{ ...row, box: [1, 2, 3] }],
        rowsOmitted: 0
      };
      await expect(
        new ScannerOtsHomrProviderService(config).scanPage({
          image,
          filename: 'page.png',
          contentType: 'image/png',
          detectTitle: false,
          idempotencyKey: '8'.repeat(64),
          engineOptions: { textPolicy: { mode: 'fusion-v1' } }
        })
      ).rejects.toMatchObject({ code: 'provider_invalid_response' });
      delete (fused.result as any).lyricText;
      // Hundreds of rejected boxes are carried as a tally, not as regions.
      (fused.result as any).fusionSummary = {
        accepted: 0,
        review: 0,
        reviewOmitted: 0,
        rejected: 600,
        rejectedByReason: { 'unsupported-class': 600 },
        rejectedByClass: { Fingering: 400, MeasureNumber: 200 },
        byClass: {}
      };
      const tallied = await new ScannerOtsHomrProviderService(config).scanPage({
        image,
        filename: 'page.png',
        contentType: 'image/png',
        detectTitle: false,
        idempotencyKey: 'd'.repeat(64),
        engineOptions: { textPolicy: { mode: 'fusion-v1' } }
      });
      expect(
        JSON.parse(tallied.nativeArtifacts!['text-fusion-review'].toString('utf8')).fusionSummary
          .rejected
      ).toBe(600);
      // Omitted review regions are counted: 300 review, 200 listed.
      (fused.result as any).fusionSummary = {
        accepted: 0,
        review: 300,
        reviewOmitted: 300,
        rejected: 0,
        rejectedByReason: {},
        rejectedByClass: {},
        byClass: {}
      };
      await expect(
        new ScannerOtsHomrProviderService(config).scanPage({
          image,
          filename: 'page.png',
          contentType: 'image/png',
          detectTitle: false,
          idempotencyKey: 'a'.repeat(64),
          engineOptions: { textPolicy: { mode: 'fusion-v1' } }
        })
      ).resolves.toBeDefined();
      (fused.result as any).fusionSummary = {
        accepted: 0,
        review: 0,
        reviewOmitted: 0,
        rejected: 600,
        rejectedByReason: { 'unsupported-class': 600 },
        rejectedByClass: { Fingering: 400, MeasureNumber: 200 },
        byClass: {}
      };
      // A tally that does not add up, or a listed rejected region, breaks the contract.
      (fused.result as any).fusionSummary.rejectedByClass = { Fingering: 1 };
      await expect(
        new ScannerOtsHomrProviderService(config).scanPage({
          image,
          filename: 'page.png',
          contentType: 'image/png',
          detectTitle: false,
          idempotencyKey: 'c'.repeat(64),
          engineOptions: { textPolicy: { mode: 'fusion-v1' } }
        })
      ).rejects.toMatchObject({ code: 'provider_invalid_response' });
      (fused.result as any).fusionSummary.rejectedByClass = { Fingering: 600 };
      (fused.result as any).fusionSummary.review = 1;
      (fused.result as any).fusedRegions = [{ status: 'rejected', candidates: [] }];
      await expect(
        new ScannerOtsHomrProviderService(config).scanPage({
          image,
          filename: 'page.png',
          contentType: 'image/png',
          detectTitle: false,
          idempotencyKey: 'b'.repeat(64),
          engineOptions: { textPolicy: { mode: 'fusion-v1' } }
        })
      ).rejects.toMatchObject({ code: 'provider_invalid_response' });
      (fused.result as any).fusionSummary = {
        accepted: 0,
        review: 0,
        reviewOmitted: 0,
        rejected: 0,
        rejectedByReason: {},
        rejectedByClass: {},
        byClass: {}
      };
      (fused.result as any).fusedRegions = [];
      (fused.engine as any).textPolicy.detectors[2].sha256 = 'f'.repeat(64);
      await expect(
        new ScannerOtsHomrProviderService(config).scanPage({
          image,
          filename: 'page.png',
          contentType: 'image/png',
          detectTitle: false,
          idempotencyKey: 'f'.repeat(64),
          engineOptions: { textPolicy: { mode: 'fusion-v1' } }
        })
      ).rejects.toMatchObject({ code: 'provider_model_artifact_mismatch' });
      (fused.engine as any).textPolicy.detectors.pop();
      await expect(
        new ScannerOtsHomrProviderService(config).scanPage({
          image,
          filename: 'page.png',
          contentType: 'image/png',
          detectTitle: false,
          idempotencyKey: 'f'.repeat(64),
          engineOptions: { textPolicy: { mode: 'fusion-v1' } }
        })
      ).rejects.toMatchObject({ code: 'provider_invalid_response' });
    } finally {
      delete values.SCANNER_OTS_HOMR_FUSION_ENABLED;
      delete values.SCANNER_EXPECTED_OTS_HOMR_NON_LYRIC_TEXT_REVISION;
      delete values.SCANNER_EXPECTED_OTS_HOMR_NON_LYRIC_TEXT_SHA256;
      delete values.SCANNER_EXPECTED_OTS_HOMR_DYNAMICS_REVISION;
      delete values.SCANNER_EXPECTED_OTS_HOMR_DYNAMICS_SHA256;
      delete values.SCANNER_EXPECTED_OTS_HOMR_FUSION_CALIBRATION_REVISION;
    }
  });

  it('regenerates reviewed OTS-HOMR tokens through its own provider', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
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

  it('materializes an independently selected family subset from stored proposals', async () => {
    const response = {
      schemaVersion: 'ots-ots-homr-provider.v2',
      result: {
        musicXmlBase64: musicXml.toString('base64'),
        musicXmlSha256: sha256(musicXml),
        families: ['beam', 'tie']
      }
    };
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    const proposals = Buffer.from(
      JSON.stringify({
        schemaVersion: 'ots-structured-proposals.v1',
        title: 'Example',
        staves: [[['note_4', 'C4', '_', '_', '_', 'upper']]],
        structured: [[structured]]
      })
    );

    await expect(
      new ScannerOtsHomrProviderService(config).materializeStructured(proposals, ['beam', 'tie'])
    ).resolves.toEqual(musicXml);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://ots-homr.example/v1/materialize-structured'
    );
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toMatchObject({
      title: 'Example',
      families: ['beam', 'tie']
    });
  });

  it('refuses dynamics as an output family before calling the provider', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(
      new ScannerOtsHomrProviderService(config).materializeStructured(Buffer.from('{}'), [
        'dynamic'
      ])
    ).rejects.toMatchObject({ code: 'provider_invalid_option', retryable: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('isMergedGrandStaffDeviation', () => {
  const voicePiano = { parts: [{}, { expectedStaffCount: 2 }] };
  const deviation = (expects: number, implies: number) => ({
    kind: 'profile_layout_deviation',
    message: `profile expects ${expects} staff(s) per system, detected geometry implies ${implies}`
  });

  it('drops the false alarm for a voice+piano profile read as two units per system', () => {
    expect(isMergedGrandStaffDeviation(deviation(3, 2), voicePiano)).toBe(true);
  });

  it('keeps a real deviation, other finding kinds and findings without a profile', () => {
    expect(isMergedGrandStaffDeviation(deviation(3, 4), voicePiano)).toBe(false);
    expect(isMergedGrandStaffDeviation(deviation(3, 1), voicePiano)).toBe(false);
    expect(
      isMergedGrandStaffDeviation(
        { kind: 'part_order', message: deviation(3, 2).message },
        voicePiano
      )
    ).toBe(false);
    expect(isMergedGrandStaffDeviation(deviation(3, 2), undefined)).toBe(false);
    // A quartet has no grand staff to merge: 4 expected, 3 found stays a deviation.
    expect(isMergedGrandStaffDeviation(deviation(4, 3), { parts: [{}, {}, {}, {}] })).toBe(false);
  });
});
