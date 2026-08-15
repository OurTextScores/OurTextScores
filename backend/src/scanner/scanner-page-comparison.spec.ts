import { createHash } from 'node:crypto';
import { buildScannerHomrMeasureGeometry } from './scanner-homr-measure-geometry';
import { compareScannerPage, scannerComparisonSystems } from './scanner-page-comparison';

const sha = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
const raster = { checksumSha256: sha('recognition-raster'), width: 100, height: 50 };

function score(partId: string, voice: number): Buffer {
  return Buffer.from(
    `<score-partwise><part-list><score-part id="${partId}"><part-name>Cello</part-name></score-part></part-list><part id="${partId}"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>${voice}</voice><staff>1</staff></note></measure></part></score-partwise>`
  );
}

const review = {
  staves: [
    {
      index: 0,
      region: [0, 0, 100, 50],
      barLines: [0, 100],
      tokens: [['note_4', 'C4', '_', '_', '_', 'upper']],
      symbols: []
    }
  ]
};

function input() {
  const baseMusicXml = score('P1', 1);
  const candidateMusicXml = score('T9', 2);
  return {
    sourceImage: raster,
    base: {
      engineId: 'homr',
      displayName: 'HOMR',
      artifactChecksumSha256: sha(baseMusicXml),
      musicXml: baseMusicXml,
      recognitionRaster: raster,
      modelRevision: 'abcdef0',
      unsupportedSemanticClasses: [],
      review,
      artifacts: {},
      loadArtifact: async () => undefined,
      loadRecognitionRaster: async () => Buffer.from('recognition-raster'),
      measureGeometryProducer: (producerInput: any) =>
        buildScannerHomrMeasureGeometry({
          engineId: 'homr',
          artifactChecksumSha256: producerInput.artifactChecksumSha256,
          sourceImage: producerInput.sourceImage,
          producerRevision: producerInput.producerRevision,
          partMatchResult: producerInput.partMatchResult,
          parts: producerInput.parts,
          staves: producerInput.review?.staves || []
        })
    },
    candidate: {
      engineId: 'transcoda',
      displayName: 'Transcoda',
      artifactChecksumSha256: sha(candidateMusicXml),
      musicXml: candidateMusicXml,
      recognitionRaster: raster,
      completeness: 'complete' as const,
      unsupportedSemanticClasses: ['lyrics', 'dynamics'],
      artifacts: {},
      loadArtifact: async () => undefined,
      loadRecognitionRaster: async () => Buffer.from('recognition-raster')
    }
  };
}

describe('scanner page comparison pipeline', () => {
  it('keeps part-local staff rows inside each scan system', () => {
    const systems = scannerComparisonSystems(
      {
        measureRefs: [
          {
            engine: 'homr',
            stablePartKey: 'violin',
            measureIndex: 0,
            cropRegions: [{ systemIndex: 0, staffIndices: [0], region: [0, 0, 100, 20] }]
          },
          {
            engine: 'transcoda',
            stablePartKey: 'violin',
            measureIndex: 0,
            cropRegions: [{ systemIndex: 0, staffIndices: [0], region: [0, 0, 100, 20] }]
          },
          {
            engine: 'homr',
            stablePartKey: 'cello',
            measureIndex: 0,
            cropRegions: [{ systemIndex: 0, staffIndices: [1], region: [0, 22, 100, 50] }]
          }
        ]
      },
      { baseEngineId: 'homr', candidateEngineId: 'transcoda' }
    );

    expect(systems[0].region).toEqual([0, 0, 100, 50]);
    expect(systems[0].staffRows).toEqual([
      expect.objectContaining({
        stablePartKey: 'violin',
        staffIndices: [0],
        baseMeasureIndexes: [0],
        candidateMeasureIndexes: [0]
      }),
      expect.objectContaining({
        stablePartKey: 'cello',
        staffIndices: [1],
        baseMeasureIndexes: [0],
        candidateMeasureIndexes: []
      })
    ]);
  });

  it('runs the complete stored-artifact pipeline and returns grounded blocks', async () => {
    const result = await compareScannerPage(input());

    expect(result).toMatchObject({
      version: 'scanner-page-comparison-v1',
      status: 'ready',
      pair: { baseEngineId: 'homr', candidateEngineId: 'transcoda' },
      base: { displayName: 'HOMR' },
      candidate: { displayName: 'Transcoda', completeness: 'complete' },
      refusalReasons: [],
      geometry: {
        status: 'ready',
        blocks: [
          {
            status: 'ready',
            block: {
              differenceClasses: ['voice'],
              cropRegions: [{ region: [0, 0, 100, 50] }]
            }
          }
        ]
      }
    });
  });

  it('compares a keyboard page the two engines wrote with different part counts', async () => {
    // The Joplin case. HOMR writes a piano as one part on two braced staves and
    // Transcoda writes it as two parts of one staff each; both are right, and
    // part matching pairs a part with a part, so this refused outright with
    // "Part 1 has no compatible candidate part". The candidate is folded onto
    // the base's staves before anything looks at the notes.
    const value = input();
    const note = (step: string, octave: number, voice: number, staff: number) =>
      `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch>` +
      `<duration>1</duration><voice>${voice}</voice><staff>${staff}</staff></note>`;
    value.base.musicXml = Buffer.from(
      '<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>' +
        '</score-part></part-list><part id="P1"><measure number="1">' +
        '<attributes><divisions>1</divisions><staves>2</staves></attributes>' +
        note('C', 5, 1, 1) +
        '<backup><duration>1</duration></backup>' +
        note('C', 3, 5, 2) +
        '</measure></part></score-partwise>'
    );
    value.base.artifactChecksumSha256 = sha(value.base.musicXml);
    const single = (id: string, step: string, octave: number) =>
      `<part id="${id}"><measure number="1"><attributes><divisions>1</divisions></attributes>` +
      `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch>` +
      '<duration>1</duration></note></measure></part>';
    value.candidate.musicXml = Buffer.from(
      '<score-partwise><part-list><score-part id="Ta"><part-name/></score-part>' +
        '<score-part id="Tb"><part-name/></score-part></part-list>' +
        single('Ta', 'C', 5) +
        single('Tb', 'C', 3) +
        '</score-partwise>'
    );
    value.candidate.artifactChecksumSha256 = sha(value.candidate.musicXml);

    const result = await compareScannerPage(value);

    expect(result.analysis?.status).toBe('succeeded');
    expect(result.layoutReconciliation).toMatchObject({
      engineId: 'transcoda',
      note: expect.stringContaining('2 staves')
    });
    // The stored artifact is still what the reading is identified by; the
    // folded bytes are named separately so a decision stays traceable to a file.
    expect(result.candidate.artifactChecksumSha256).toBe(sha(value.candidate.musicXml));
    expect(result.layoutReconciliation!.contentChecksumSha256).not.toBe(
      sha(value.candidate.musicXml)
    );
  });

  it('preserves structural analysis while refusing an ungrounded comparison', async () => {
    const value = input();
    delete (value.base as any).measureGeometryProducer;
    const result = await compareScannerPage(value);

    expect(result).toMatchObject({
      status: 'refused',
      analysis: { status: 'succeeded', blocks: [{ differenceClasses: ['voice'] }] },
      geometry: { status: 'refused' },
      refusalReasons: [{ stage: 'geometry', code: 'geometry-producer-unavailable' }]
    });
  });

  it('needs no geometry producer when the documents have no difference blocks', async () => {
    const value = input();
    value.candidate.musicXml = score('T9', 1);
    value.candidate.artifactChecksumSha256 = sha(value.candidate.musicXml);
    delete (value.base as any).measureGeometryProducer;
    const result = await compareScannerPage(value);

    expect(result).toMatchObject({
      status: 'ready',
      analysis: { status: 'succeeded', blocks: [] },
      geometry: { status: 'ready', blocks: [] },
      refusalReasons: []
    });
  });

  it('refuses before analysis when run and page raster identities differ', async () => {
    const value = input();
    const producer = jest.fn(value.base.measureGeometryProducer);
    value.base.measureGeometryProducer = producer;
    value.candidate.recognitionRaster = { ...raster, checksumSha256: sha('different-raster') };
    const result = await compareScannerPage(value);

    expect(result).toMatchObject({
      status: 'refused',
      refusalReasons: [{ stage: 'prerequisites', code: 'recognition-raster-mismatch' }]
    });
    expect(producer).not.toHaveBeenCalled();
  });

  it('turns stale artifact checksums into an explicit analysis refusal', async () => {
    const value = input();
    value.candidate.artifactChecksumSha256 = 'f'.repeat(64);
    const result = await compareScannerPage(value);

    expect(result).toMatchObject({
      status: 'refused',
      refusalReasons: [{ stage: 'analysis', code: 'comparison-analysis-failed' }]
    });
  });

  it('contains a geometry producer exception as a refusal', async () => {
    const value = input();
    value.base.measureGeometryProducer = () => {
      throw new Error('producer revision is unavailable');
    };
    const result = await compareScannerPage(value);

    expect(result).toMatchObject({
      status: 'refused',
      refusalReasons: [
        {
          stage: 'geometry',
          code: 'geometry-producer-failed',
          engineId: 'homr'
        }
      ]
    });
  });

  it('reports an unexpected failure without returning its internals', async () => {
    // The refusal detail is serialized to the client, so a dependency's own
    // message must reach the log instead of the response.
    const reportInternalError = jest.fn();
    const value = { ...input(), reportInternalError };
    value.base.measureGeometryProducer = () => {
      throw new Error('sharp: /var/lib/scanner/raster.png is not a PNG');
    };
    const result = await compareScannerPage(value);

    const details = JSON.stringify(result);
    expect(details).not.toContain('sharp');
    expect(details).not.toContain('/var/lib/scanner');
    expect(result).toMatchObject({
      status: 'refused',
      refusalReasons: [
        {
          stage: 'geometry',
          code: 'geometry-producer-failed',
          detail: 'The comparison could not be completed for this page'
        }
      ]
    });
    expect(reportInternalError).toHaveBeenCalledWith(
      'geometry:geometry-producer-failed',
      expect.any(Error)
    );
  });

  it('reports an unexpected analysis failure without returning its internals', async () => {
    const reportInternalError = jest.fn();
    const value = { ...input(), reportInternalError };
    value.candidate.artifactChecksumSha256 = 'f'.repeat(64);
    const result = await compareScannerPage(value);

    expect(result).toMatchObject({
      status: 'refused',
      refusalReasons: [
        {
          stage: 'analysis',
          code: 'comparison-analysis-failed',
          detail: 'The comparison could not be completed for this page'
        }
      ]
    });
    expect(reportInternalError).toHaveBeenCalledWith(
      'analysis:comparison-analysis-failed',
      expect.any(Error)
    );
  });

  it('lets a future async producer load its native evidence and exact raster', async () => {
    const value = input();
    const original = value.base.measureGeometryProducer;
    const loadArtifact = jest.fn(async () => Buffer.from('native-layout'));
    const loadRecognitionRaster = jest.fn(async () => Buffer.from('recognition-raster'));
    value.base.loadArtifact = loadArtifact;
    value.base.loadRecognitionRaster = loadRecognitionRaster;
    (value.base as any).measureGeometryProducer = async (producerInput: any) => {
      await producerInput.loadArtifact('layout');
      await producerInput.loadRecognitionRaster();
      return original(producerInput);
    };

    await expect(compareScannerPage(value)).resolves.toMatchObject({ status: 'ready' });
    expect(loadArtifact).toHaveBeenCalledWith('layout');
    expect(loadRecognitionRaster).toHaveBeenCalledTimes(1);
  });
});
