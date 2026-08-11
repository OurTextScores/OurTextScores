import { createHash } from 'node:crypto';
import {
  joinScannerComparisonGeometry,
  SCANNER_COMPARISON_GEOMETRY_JOIN_VERSION,
  SCANNER_MEASURE_GEOMETRY_VERSION,
  type ScannerMeasureGeometryManifest,
  type ScannerSourceImageIdentity
} from './scanner-comparison-geometry';
import {
  SCANNER_COMPARISON_ANALYSIS_VERSION,
  SCANNER_COMPARISON_BLOCK_VERSION,
  type ScannerComparisonAnalysis,
  type ScannerComparisonBlock,
  type ScannerComparisonMeasureIdentity
} from './scanner-comparison-blocks';
import type { ScannerMeasureRef } from './scanner-dual-engine';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const baseChecksum = sha('base-musicxml');
const candidateChecksum = sha('candidate-musicxml');
const sourceImage: ScannerSourceImageIdentity = {
  checksumSha256: sha('source-image'),
  width: 1600,
  height: 2200
};

function identity(
  engine: string,
  artifactChecksumSha256: string,
  documentPartId: string,
  measureIndex: number,
  stablePartKey = 'scanner-part-v1:part-one'
): ScannerComparisonMeasureIdentity {
  return {
    engine,
    artifactChecksumSha256,
    stablePartKey,
    documentPartId,
    measureIndex,
    measureNumber: String(measureIndex + 1)
  };
}

function block(blockIndex = 0): ScannerComparisonBlock {
  return {
    version: SCANNER_COMPARISON_BLOCK_VERSION,
    blockIndex,
    pair: { baseEngineId: 'engine-a', candidateEngineId: 'engine-b' },
    stablePartKey: 'scanner-part-v1:part-one',
    baseMeasureRefs: [identity('engine-a', baseChecksum, 'P1', blockIndex)],
    candidateMeasureRefs: [identity('engine-b', candidateChecksum, 'generated-part', blockIndex)],
    baseDescriptorHashes: [`base-rich-${blockIndex}`],
    candidateDescriptorHashes: [`candidate-rich-${blockIndex}`],
    differenceClasses: ['notation'],
    completenessWarnings: [],
    contentSignature: `scanner-block-content-v2:${sha(`block-${blockIndex}`)}`
  };
}

function succeededAnalysis(blocks = [block()]): ScannerComparisonAnalysis {
  return {
    version: SCANNER_COMPARISON_ANALYSIS_VERSION,
    status: 'succeeded',
    pair: { baseEngineId: 'engine-a', candidateEngineId: 'engine-b' },
    partMatches: [],
    blocks
  };
}

function measureRef(
  value: ScannerComparisonMeasureIdentity,
  region: [number, number, number, number] = [100, 200, 500, 320]
): ScannerMeasureRef {
  return {
    ...value,
    cropRegions: [{ systemIndex: 0, staffIndices: [0], region }]
  };
}

function manifest(
  measureRefs = [
    measureRef(identity('engine-a', baseChecksum, 'P1', 0)),
    measureRef(identity('engine-b', candidateChecksum, 'generated-part', 0))
  ]
): ScannerMeasureGeometryManifest {
  return {
    version: SCANNER_MEASURE_GEOMETRY_VERSION,
    producerId: 'provider-neutral-layout',
    producerRevision: 'layout-v1',
    sourceImage,
    measureRefs
  };
}

describe('scanner comparison geometry join', () => {
  it('upgrades exact identities and de-duplicates their shared source crop', () => {
    const result = joinScannerComparisonGeometry({
      analysis: succeededAnalysis(),
      sourceImage,
      geometry: manifest()
    });

    expect(result).toMatchObject({
      version: SCANNER_COMPARISON_GEOMETRY_JOIN_VERSION,
      status: 'ready',
      pair: { baseEngineId: 'engine-a', candidateEngineId: 'engine-b' },
      sourceImage,
      geometryProducer: { id: 'provider-neutral-layout', revision: 'layout-v1' },
      geometrySignature: expect.stringMatching(/^scanner-measure-geometry-v1:[a-f0-9]{64}$/),
      refusalReasons: [],
      blocks: [
        {
          status: 'ready',
          block: {
            baseMeasureRefs: [{ engine: 'engine-a', cropRegions: expect.any(Array) }],
            candidateMeasureRefs: [{ engine: 'engine-b', cropRegions: expect.any(Array) }],
            cropRegions: [{ systemIndex: 0, staffIndices: [0], region: [100, 200, 500, 320] }]
          }
        }
      ]
    });
  });

  it('canonicalizes manifest order and checksum casing in its signature', () => {
    const geometry = manifest();
    const reversed = manifest(
      [...geometry.measureRefs].reverse().map((ref) => ({
        ...ref,
        artifactChecksumSha256: ref.artifactChecksumSha256.toUpperCase()
      }))
    );
    (reversed as any).providerDebug = 'must not enter durable identity';
    (reversed.sourceImage as any).temporaryUrl = 'must not enter durable identity';
    (reversed.measureRefs[0] as any).confidence = 0.9;
    const first = joinScannerComparisonGeometry({
      analysis: succeededAnalysis(),
      sourceImage,
      geometry
    });
    const second = joinScannerComparisonGeometry({
      analysis: succeededAnalysis(),
      sourceImage: { ...sourceImage, checksumSha256: sourceImage.checksumSha256.toUpperCase() },
      geometry: reversed
    });

    expect(second.geometrySignature).toBe(first.geometrySignature);
    expect(second.sourceImage.checksumSha256).toBe(sourceImage.checksumSha256);
  });

  it('refuses every structural block when geometry is unavailable', () => {
    const result = joinScannerComparisonGeometry({
      analysis: succeededAnalysis([block(0), block(1)]),
      sourceImage
    });

    expect(result.status).toBe('refused');
    expect(result.refusalReasons).toEqual([
      {
        code: 'geometry-unavailable',
        detail: 'No verified measure-to-image geometry is available for this page'
      }
    ]);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.every((entry) => entry.status === 'refused')).toBe(true);
  });

  it('refuses geometry produced for another source image', () => {
    const geometry = manifest();
    geometry.sourceImage = { ...sourceImage, checksumSha256: sha('different-image') };
    const result = joinScannerComparisonGeometry({
      analysis: succeededAnalysis(),
      sourceImage,
      geometry
    });

    expect(result).toMatchObject({
      status: 'refused',
      refusalReasons: [{ code: 'source-image-mismatch' }]
    });
  });

  it('refuses only unresolved blocks while preserving grounded evidence', () => {
    const first = block(0);
    const second = block(1);
    const geometry = manifest([
      ...manifest().measureRefs,
      measureRef(second.baseMeasureRefs[0], [100, 400, 500, 520])
    ]);
    const result = joinScannerComparisonGeometry({
      analysis: succeededAnalysis([first, second]),
      sourceImage,
      geometry
    });

    expect(result.status).toBe('refused');
    expect(result.blocks.map((entry) => entry.status)).toEqual(['ready', 'refused']);
    expect(result.refusalReasons).toEqual([
      expect.objectContaining({
        code: 'missing-measure-reference',
        engineId: 'engine-b',
        documentPartId: 'generated-part',
        measureIndex: 1
      })
    ]);
  });

  it('rejects duplicate identities and out-of-bounds crop coordinates', () => {
    const duplicate = manifest();
    duplicate.measureRefs.push({ ...duplicate.measureRefs[0] });
    expect(
      joinScannerComparisonGeometry({
        analysis: succeededAnalysis(),
        sourceImage,
        geometry: duplicate
      })
    ).toMatchObject({
      status: 'refused',
      refusalReasons: [{ code: 'ambiguous-measure-reference' }]
    });

    const invalid = manifest();
    invalid.measureRefs[0] = measureRef(identity('engine-a', baseChecksum, 'P1', 0), [
      100,
      200,
      sourceImage.width + 1,
      320
    ]);
    expect(
      joinScannerComparisonGeometry({
        analysis: succeededAnalysis(),
        sourceImage,
        geometry: invalid
      })
    ).toMatchObject({
      status: 'refused',
      refusalReasons: [{ code: 'invalid-geometry-manifest' }]
    });
  });

  it('requires the measure number to agree with the structural identity', () => {
    const geometry = manifest();
    geometry.measureRefs[1] = { ...geometry.measureRefs[1], measureNumber: '99' };
    const result = joinScannerComparisonGeometry({
      analysis: succeededAnalysis(),
      sourceImage,
      geometry
    });

    expect(result).toMatchObject({
      status: 'refused',
      refusalReasons: [
        {
          code: 'measure-reference-mismatch',
          engineId: 'engine-b',
          documentPartId: 'generated-part',
          measureIndex: 0
        }
      ]
    });
  });

  it('propagates structural refusals without pretending geometry can repair them', () => {
    const analysis: ScannerComparisonAnalysis = {
      version: SCANNER_COMPARISON_ANALYSIS_VERSION,
      status: 'refused',
      pair: { baseEngineId: 'engine-a', candidateEngineId: 'engine-b' },
      partMatches: [],
      refusalReasons: ['Part 2 has no unique cross-engine match']
    };
    const result = joinScannerComparisonGeometry({ analysis, sourceImage, geometry: manifest() });

    expect(result).toMatchObject({
      status: 'refused',
      blocks: [],
      refusalReasons: [
        {
          code: 'structural-comparison-refused',
          detail: 'Part 2 has no unique cross-engine match'
        }
      ]
    });
  });

  it('needs no geometry when the engines structurally agree', () => {
    expect(
      joinScannerComparisonGeometry({ analysis: succeededAnalysis([]), sourceImage })
    ).toMatchObject({ status: 'ready', blocks: [], refusalReasons: [] });
  });
});
