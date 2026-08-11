import { createHash } from 'node:crypto';
import {
  buildScannerHomrMeasureGeometry,
  SCANNER_HOMR_MEASURE_GEOMETRY_PRODUCER_ID,
  SCANNER_HOMR_MEASURE_GEOMETRY_PRODUCER_VERSION
} from './scanner-homr-measure-geometry';
import { joinScannerComparisonGeometry } from './scanner-comparison-geometry';
import {
  SCANNER_COMPARISON_ANALYSIS_VERSION,
  SCANNER_COMPARISON_BLOCK_VERSION,
  type ScannerComparisonAnalysis
} from './scanner-comparison-blocks';
import type { ScannerDescribedPart, ScannerMeasureDescriptor } from './scanner-measure-analysis';
import { SCANNER_PART_MATCH_VERSION, type ScannerPartMatchResult } from './scanner-part-matching';
import type { ReviewStaff } from './scanner-review';
import type { ScannerPartMatch } from './scanner-dual-engine';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const homrChecksum = sha('homr-musicxml');
const candidateChecksum = sha('candidate-musicxml');
const sourceImage = { checksumSha256: sha('recognition-raster'), width: 800, height: 1000 };

function token(rhythm: string): string[] {
  return [rhythm, '.', '_', '_', '_', 'upper'];
}

function staff(
  index: number,
  tokens: string[][],
  options: { region?: number[]; barLines?: number[] } = {}
): ReviewStaff {
  return {
    index,
    tokens,
    region: options.region || [100, 100 + index * 150, 500, 180 + index * 150],
    barLines: options.barLines || [100, 500],
    symbols: []
  };
}

function descriptor(measureIndex: number): ScannerMeasureDescriptor {
  return {
    measureIndex,
    measureNumber: String(measureIndex + 1),
    coarseKey: `coarse-${measureIndex}`,
    richHash: `rich-${measureIndex}`,
    componentHashes: {
      notation: `notation-${measureIndex}`,
      voice: `voice-${measureIndex}`,
      staff: `staff-${measureIndex}`,
      attributes: `attributes-${measureIndex}`,
      lyrics: `lyrics-${measureIndex}`,
      dynamics: `dynamics-${measureIndex}`,
      directions: `directions-${measureIndex}`,
      notations: `notations-${measureIndex}`
    },
    eventCount: 1
  };
}

function parts(counts: number[]): ScannerDescribedPart[] {
  return counts.map((count, partIndex) => ({
    documentPartId: `P${partIndex + 1}`,
    measures: Array.from({ length: count }, (_, measureIndex) => descriptor(measureIndex))
  }));
}

function matchedPart(partIndex: number): Extract<ScannerPartMatch, { outcome: 'matched' }> {
  return {
    outcome: 'matched',
    stablePartKey: `scanner-part-v1:${sha(`part-${partIndex}`)}`,
    base: {
      engineId: 'homr',
      artifactChecksumSha256: homrChecksum,
      documentPartId: `P${partIndex + 1}`,
      ordinal: partIndex,
      staffCount: 1
    },
    candidate: {
      engineId: 'transcoda',
      artifactChecksumSha256: candidateChecksum,
      documentPartId: `generated-${partIndex + 1}`,
      ordinal: partIndex,
      staffCount: 1
    },
    evidence: { ordinalEqual: true, staffCountEqual: true }
  };
}

function partMatches(count: number): ScannerPartMatchResult {
  return {
    version: SCANNER_PART_MATCH_VERSION,
    pair: { baseEngineId: 'homr', candidateEngineId: 'transcoda' },
    matches: Array.from({ length: count }, (_, index) => matchedPart(index)),
    comparisonAllowed: true,
    refusalReasons: []
  };
}

function build(input: {
  parts: ScannerDescribedPart[];
  staves: ReviewStaff[];
  partMatchResult?: ScannerPartMatchResult;
  artifactChecksumSha256?: string;
}) {
  return buildScannerHomrMeasureGeometry({
    engineId: 'homr',
    artifactChecksumSha256: input.artifactChecksumSha256 || homrChecksum,
    sourceImage,
    producerRevision: '1ddc6fcc',
    partMatchResult: input.partMatchResult || partMatches(input.parts.length),
    parts: input.parts,
    staves: input.staves
  });
}

describe('HOMR measure geometry producer', () => {
  it('maps sequential measures across physical systems using proven boundaries', () => {
    const result = build({
      parts: parts([3]),
      staves: [
        staff(0, [token('note_4'), token('barline'), token('note_4'), token('barline')], {
          region: [100, 100, 500, 180],
          barLines: [100, 300, 500]
        }),
        staff(1, [token('note_4')], {
          region: [100, 300, 500, 380],
          barLines: [100, 500]
        })
      ]
    });

    expect(result).toMatchObject({
      status: 'succeeded',
      geometry: {
        producerId: SCANNER_HOMR_MEASURE_GEOMETRY_PRODUCER_ID,
        producerRevision: `${SCANNER_HOMR_MEASURE_GEOMETRY_PRODUCER_VERSION}:1ddc6fcc`,
        sourceImage,
        measureRefs: [
          {
            documentPartId: 'P1',
            measureIndex: 0,
            measureNumber: '1',
            cropRegions: [{ systemIndex: 0, staffIndices: [0], region: [100, 100, 300, 180] }]
          },
          {
            documentPartId: 'P1',
            measureIndex: 1,
            cropRegions: [{ systemIndex: 0, staffIndices: [0], region: [300, 100, 500, 180] }]
          },
          {
            documentPartId: 'P1',
            measureIndex: 2,
            cropRegions: [{ systemIndex: 1, staffIndices: [1], region: [100, 300, 500, 380] }]
          }
        ]
      }
    });
  });

  it('produces a manifest accepted by the strict geometry join', () => {
    const produced = build({
      parts: parts([1]),
      staves: [staff(0, [token('note_4')])]
    });
    expect(produced.status).toBe('succeeded');
    if (produced.status !== 'succeeded') return;
    const match = matchedPart(0);
    const analysis: ScannerComparisonAnalysis = {
      version: SCANNER_COMPARISON_ANALYSIS_VERSION,
      status: 'succeeded',
      pair: { baseEngineId: 'homr', candidateEngineId: 'transcoda' },
      partMatches: [match],
      blocks: [
        {
          version: SCANNER_COMPARISON_BLOCK_VERSION,
          blockIndex: 0,
          pair: { baseEngineId: 'homr', candidateEngineId: 'transcoda' },
          stablePartKey: match.stablePartKey,
          baseMeasureRefs: [
            {
              engine: 'homr',
              artifactChecksumSha256: homrChecksum,
              stablePartKey: match.stablePartKey,
              documentPartId: 'P1',
              measureIndex: 0,
              measureNumber: '1'
            }
          ],
          candidateMeasureRefs: [],
          baseDescriptorHashes: ['base-rich'],
          candidateDescriptorHashes: [],
          differenceClasses: ['measure-removed'],
          completenessWarnings: [],
          contentSignature: `scanner-block-content-v2:${sha('block')}`
        }
      ]
    };

    expect(
      joinScannerComparisonGeometry({
        analysis,
        sourceImage,
        geometry: produced.geometry
      })
    ).toMatchObject({
      status: 'ready',
      blocks: [{ status: 'ready', block: { baseMeasureRefs: [{ measureIndex: 0 }] } }]
    });
  });

  it('honors HOMR voice-major capture order for multiple parts', () => {
    const oneMeasure = [token('note_4'), token('barline')];
    const result = build({
      parts: parts([2, 2]),
      // P1 system 0/1, then P2 system 0/1: this is the pinned parse_staffs order.
      staves: [
        staff(0, oneMeasure),
        staff(1, oneMeasure),
        staff(2, oneMeasure),
        staff(3, oneMeasure)
      ]
    });

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    expect(
      result.geometry.measureRefs.map((ref) => [
        ref.documentPartId,
        ref.measureIndex,
        ref.cropRegions[0].systemIndex,
        ref.cropRegions[0].staffIndices[0]
      ])
    ).toEqual([
      ['P1', 0, 0, 0],
      ['P1', 1, 1, 1],
      ['P2', 0, 0, 2],
      ['P2', 1, 1, 3]
    ]);
  });

  it('emits multiple crop regions when one measure spans a system break', () => {
    const result = build({
      parts: parts([1]),
      staves: [staff(0, [token('note_4')]), staff(1, [token('note_4')])]
    });

    expect(result).toMatchObject({
      status: 'succeeded',
      geometry: {
        measureRefs: [
          {
            measureIndex: 0,
            cropRegions: [
              { systemIndex: 0, staffIndices: [0] },
              { systemIndex: 1, staffIndices: [1] }
            ]
          }
        ]
      }
    });
  });

  it('refuses when token boundaries do not reproduce the MusicXML measure count', () => {
    expect(build({ parts: parts([2]), staves: [staff(0, [token('note_4')])] })).toMatchObject({
      status: 'refused',
      refusalReasons: [{ code: 'measure-count-mismatch', documentPartId: 'P1' }]
    });
  });

  it('refuses when segmentation does not prove every horizontal boundary', () => {
    expect(
      build({
        parts: parts([2]),
        staves: [
          staff(0, [token('note_4'), token('barline'), token('note_4')], {
            barLines: []
          })
        ]
      })
    ).toMatchObject({
      status: 'refused',
      refusalReasons: [{ code: 'barline-count-mismatch', staffIndex: 0 }]
    });
  });

  it('refuses ambiguous parts before applying staff-order assumptions', () => {
    const matches = partMatches(1);
    matches.comparisonAllowed = false;
    matches.matches = [
      {
        outcome: 'ambiguous',
        base: matchedPart(0).base,
        candidate: matchedPart(0).candidate,
        evidence: {},
        refusalReason: 'No unique part match'
      }
    ];
    expect(
      build({ parts: parts([1]), staves: [staff(0, [token('note_4')])], partMatchResult: matches })
    ).toMatchObject({
      status: 'refused',
      refusalReasons: [{ code: 'part-match-unavailable' }]
    });
  });

  it('refuses non-HOMR part IDs and artifact revisions', () => {
    const wrongParts = parts([1]);
    wrongParts[0].documentPartId = 'generated-id';
    expect(build({ parts: wrongParts, staves: [staff(0, [token('note_4')])] })).toMatchObject({
      status: 'refused',
      refusalReasons: [{ code: 'unsupported-part-layout' }]
    });

    expect(
      build({
        parts: parts([1]),
        staves: [staff(0, [token('note_4')])],
        artifactChecksumSha256: sha('wrong-artifact')
      })
    ).toMatchObject({
      status: 'refused',
      refusalReasons: [{ code: 'artifact-identity-mismatch' }]
    });
  });

  it('refuses incomplete or reordered physical staff grids', () => {
    expect(
      build({
        parts: parts([2, 2]),
        staves: [staff(0, [token('note_4')]), staff(2, [token('note_4')]), staff(3, [])]
      })
    ).toMatchObject({
      status: 'refused',
      refusalReasons: [{ code: 'unsupported-part-layout' }]
    });
  });
});
