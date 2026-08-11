import { createHash } from 'node:crypto';
import { buildScannerHomrMeasureGeometry } from './scanner-homr-measure-geometry';
import { compareScannerPage } from './scanner-page-comparison';

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
          engineId: 'homr',
          detail: 'producer revision is unavailable'
        }
      ]
    });
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
