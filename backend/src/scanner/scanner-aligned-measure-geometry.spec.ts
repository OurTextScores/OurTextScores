import { buildScannerAlignedMeasureGeometry } from './scanner-aligned-measure-geometry';
import { buildScannerComparisonAnalysis } from './scanner-comparison-blocks';
import {
  joinScannerComparisonGeometry,
  SCANNER_MEASURE_GEOMETRY_VERSION,
  type ScannerMeasureGeometryManifest
} from './scanner-comparison-geometry';
import { describeScannerMusicXmlMeasures } from './scanner-measure-analysis';
import { SCANNER_PART_MATCH_VERSION, type ScannerPartMatchResult } from './scanner-part-matching';

const HOMR_SHA = 'a'.repeat(64);
const TRANSCODA_SHA = 'b'.repeat(64);
const STABLE_PART_KEY = 'scanner-part-v1:stable';
const RECOGNITION_RASTER = { checksumSha256: 'c'.repeat(64), width: 1200, height: 400 };

const pitch = (step: string) =>
  `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>`;
const measure = (steps: string[], number: string) =>
  `<measure number="${number}">${steps.map(pitch).join('')}</measure>`;
const score = (partId: string, measures: string[]) =>
  Buffer.from(
    `<score-partwise><part-list><score-part id="${partId}"><part-name>Cello</part-name></score-part></part-list><part id="${partId}">${measures.join('')}</part></score-partwise>`
  );

function matchedParts(): ScannerPartMatchResult {
  return {
    version: SCANNER_PART_MATCH_VERSION,
    pair: { baseEngineId: 'homr', candidateEngineId: 'transcoda' },
    comparisonAllowed: true,
    refusalReasons: [],
    matches: [
      {
        outcome: 'matched',
        stablePartKey: STABLE_PART_KEY,
        base: {
          engineId: 'homr',
          artifactChecksumSha256: HOMR_SHA,
          documentPartId: 'H1'
        },
        candidate: {
          engineId: 'transcoda',
          artifactChecksumSha256: TRANSCODA_SHA,
          documentPartId: 'T9'
        },
        evidence: { normalizedNameEqual: true, staffCountEqual: true, structureAgreement: 1 }
      }
    ]
  };
}

function referenceGeometry(measureCount: number): ScannerMeasureGeometryManifest {
  return {
    version: SCANNER_MEASURE_GEOMETRY_VERSION,
    producerId: 'scanner-homr-measure-geometry',
    producerRevision: 'abcdef0',
    sourceImage: RECOGNITION_RASTER,
    measureRefs: Array.from({ length: measureCount }, (_value, measureIndex) => ({
      engine: 'homr',
      artifactChecksumSha256: HOMR_SHA,
      stablePartKey: STABLE_PART_KEY,
      documentPartId: 'H1',
      measureIndex,
      measureNumber: String(measureIndex + 1),
      cropRegions: [
        {
          systemIndex: 0,
          staffIndices: [0],
          region: [measureIndex * 200, 10, (measureIndex + 1) * 200, 150]
        }
      ]
    }))
  };
}

describe('scanner aligned measure geometry', () => {
  it('grounds an accepted fuzzy candidate measure and passes the strict geometry join', () => {
    const baseParts = describeScannerMusicXmlMeasures(
      score('H1', [
        measure(['C', 'D', 'E'], '1'),
        measure(['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C'], '2'),
        measure(['G', 'F', 'E'], '3')
      ])
    );
    const candidateParts = describeScannerMusicXmlMeasures(
      score('T9', [
        measure(['C', 'D', 'E'], '1'),
        measure(['C', 'D', 'E', 'F', 'G', 'A', 'A', 'C'], '2'),
        measure(['G', 'F', 'E'], '3')
      ])
    );
    const partMatchResult = matchedParts();
    const result = buildScannerAlignedMeasureGeometry({
      referenceEngineId: 'homr',
      referenceGeometry: referenceGeometry(3),
      baseRecognitionRaster: RECOGNITION_RASTER,
      candidateRecognitionRaster: RECOGNITION_RASTER,
      partMatchResult,
      baseParts,
      candidateParts
    });

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('Expected aligned geometry');
    expect(
      result.geometry.measureRefs
        .filter((ref) => ref.engine === 'transcoda')
        .map((ref) => ({ measureIndex: ref.measureIndex, region: ref.cropRegions[0].region }))
    ).toEqual([
      { measureIndex: 0, region: [0, 10, 200, 150] },
      { measureIndex: 1, region: [200, 10, 400, 150] },
      { measureIndex: 2, region: [400, 10, 600, 150] }
    ]);

    const analysis = buildScannerComparisonAnalysis({
      partMatchResult,
      base: {
        engineId: 'homr',
        artifactChecksumSha256: HOMR_SHA,
        parts: baseParts
      },
      candidate: {
        engineId: 'transcoda',
        artifactChecksumSha256: TRANSCODA_SHA,
        parts: candidateParts
      }
    });
    expect(analysis.status).toBe('succeeded');
    expect(
      joinScannerComparisonGeometry({
        analysis,
        geometry: result.geometry,
        sourceImage: result.geometry.sourceImage
      }).status
    ).toBe('ready');
  });

  it('does not invent a crop for a candidate-only measure', () => {
    const baseParts = describeScannerMusicXmlMeasures(
      score('H1', [measure(['C'], '1'), measure(['D'], '2')])
    );
    const candidateParts = describeScannerMusicXmlMeasures(
      score('T9', [measure(['C'], '1'), measure(['F', 'A'], 'x'), measure(['D'], '2')])
    );
    const result = buildScannerAlignedMeasureGeometry({
      referenceEngineId: 'homr',
      referenceGeometry: referenceGeometry(2),
      baseRecognitionRaster: RECOGNITION_RASTER,
      candidateRecognitionRaster: RECOGNITION_RASTER,
      partMatchResult: matchedParts(),
      baseParts,
      candidateParts
    });

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('Expected aligned geometry');
    expect(
      result.geometry.measureRefs
        .filter((ref) => ref.engine === 'transcoda')
        .map((ref) => ref.measureIndex)
    ).toEqual([0, 2]);
  });

  it('refuses a reference manifest that omits an analyzed measure', () => {
    const baseParts = describeScannerMusicXmlMeasures(
      score('H1', [measure(['C'], '1'), measure(['D'], '2')])
    );
    const candidateParts = describeScannerMusicXmlMeasures(
      score('T9', [measure(['C'], '1'), measure(['D'], '2')])
    );
    const result = buildScannerAlignedMeasureGeometry({
      referenceEngineId: 'homr',
      referenceGeometry: referenceGeometry(1),
      baseRecognitionRaster: RECOGNITION_RASTER,
      candidateRecognitionRaster: RECOGNITION_RASTER,
      partMatchResult: matchedParts(),
      baseParts,
      candidateParts
    });

    expect(result).toMatchObject({
      status: 'refused',
      refusalReasons: [{ code: 'reference-geometry-invalid', measureIndex: 1 }]
    });
  });

  it('refuses to transfer crops between runs that saw different pixels', () => {
    const baseParts = describeScannerMusicXmlMeasures(score('H1', [measure(['C'], '1')]));
    const candidateParts = describeScannerMusicXmlMeasures(score('T9', [measure(['C'], '1')]));
    const result = buildScannerAlignedMeasureGeometry({
      referenceEngineId: 'homr',
      referenceGeometry: referenceGeometry(1),
      baseRecognitionRaster: RECOGNITION_RASTER,
      candidateRecognitionRaster: { ...RECOGNITION_RASTER, checksumSha256: 'd'.repeat(64) },
      partMatchResult: matchedParts(),
      baseParts,
      candidateParts
    });

    expect(result).toMatchObject({
      status: 'refused',
      refusalReasons: [{ code: 'recognition-raster-mismatch' }]
    });
  });

  it('supports either member of a generic engine pair as the geometry reference', () => {
    const baseParts = describeScannerMusicXmlMeasures(score('H1', [measure(['C'], '1')]));
    const candidateParts = describeScannerMusicXmlMeasures(score('T9', [measure(['C'], '1')]));
    const transcodaGeometry = referenceGeometry(1);
    transcodaGeometry.measureRefs = transcodaGeometry.measureRefs.map((ref) => ({
      ...ref,
      engine: 'transcoda',
      artifactChecksumSha256: TRANSCODA_SHA,
      documentPartId: 'T9'
    }));
    const result = buildScannerAlignedMeasureGeometry({
      referenceEngineId: 'transcoda',
      referenceGeometry: transcodaGeometry,
      baseRecognitionRaster: RECOGNITION_RASTER,
      candidateRecognitionRaster: RECOGNITION_RASTER,
      partMatchResult: matchedParts(),
      baseParts,
      candidateParts
    });

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('Expected aligned geometry');
    expect(result.geometry.measureRefs.map((ref) => ref.engine).sort()).toEqual([
      'homr',
      'transcoda'
    ]);
  });
});
