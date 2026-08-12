import { createHash } from 'node:crypto';
import {
  buildScannerComparisonAnalysis,
  buildScannerComparisonBlocks,
  SCANNER_COMPARISON_ANALYSIS_VERSION,
  SCANNER_COMPARISON_BLOCK_VERSION,
  type ScannerComparisonSideInput
} from './scanner-comparison-blocks';
import type { ScannerPartMatch } from './scanner-dual-engine';
import {
  describeScannerMusicXmlMeasures,
  type ScannerMeasureDescriptor
} from './scanner-measure-analysis';
import { matchScannerMusicXmlParts, SCANNER_PART_MATCH_VERSION } from './scanner-part-matching';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function descriptor(
  measureIndex: number,
  coarseKey: string,
  richHash: string,
  changed: Partial<Record<keyof ScannerMeasureDescriptor['componentHashes'], string>> = {}
): ScannerMeasureDescriptor {
  const components = {
    notation: `notation-${coarseKey}`,
    voice: `voice-${coarseKey}`,
    staff: `staff-${coarseKey}`,
    attributes: `attributes-${coarseKey}`,
    lyrics: `lyrics-${coarseKey}`,
    dynamics: `dynamics-${coarseKey}`,
    directions: `directions-${coarseKey}`,
    notations: `notations-${coarseKey}`,
    ...changed
  };
  return {
    measureIndex,
    measureNumber: String(measureIndex + 1),
    coarseKey,
    richHash,
    componentHashes: components,
    eventCount: 1
  };
}

const equalDescriptor = (measureIndex: number, key: string) =>
  descriptor(measureIndex, key, `equal-${key}`);

function fuzzyDescriptor(
  measureIndex: number,
  key: string,
  tokens: string[]
): ScannerMeasureDescriptor {
  return {
    ...descriptor(measureIndex, key, `rich-${key}`),
    eventCount: tokens.length,
    alignment: {
      events: tokens,
      pitches: tokens,
      durations: tokens.map(() => 'quarter')
    }
  };
}

function matchedPart(
  baseChecksum = sha('base'),
  candidateChecksum = sha('candidate')
): Extract<ScannerPartMatch, { outcome: 'matched' }> {
  return {
    outcome: 'matched',
    stablePartKey: `scanner-part-v1:${sha(`${baseChecksum}:${candidateChecksum}`)}`,
    base: {
      engineId: 'homr',
      artifactChecksumSha256: baseChecksum,
      documentPartId: 'P1',
      ordinal: 0,
      normalizedName: 'piano',
      staffCount: 2
    },
    candidate: {
      engineId: 'transcoda',
      artifactChecksumSha256: candidateChecksum,
      documentPartId: 'random-part-id',
      ordinal: 0,
      normalizedName: 'piano',
      staffCount: 2
    },
    evidence: { normalizedNameEqual: true, staffCountEqual: true }
  };
}

function sides(
  baseMeasures: ScannerMeasureDescriptor[],
  candidateMeasures: ScannerMeasureDescriptor[],
  match = matchedPart()
): { base: ScannerComparisonSideInput; candidate: ScannerComparisonSideInput } {
  return {
    base: {
      engineId: match.base.engineId,
      artifactChecksumSha256: match.base.artifactChecksumSha256,
      documentPartId: match.base.documentPartId,
      measures: baseMeasures
    },
    candidate: {
      engineId: match.candidate.engineId,
      artifactChecksumSha256: match.candidate.artifactChecksumSha256,
      documentPartId: match.candidate.documentPartId,
      measures: candidateMeasures
    }
  };
}

describe('scanner comparison blocks', () => {
  it('emits no block when coarse and rich descriptors agree', () => {
    const match = matchedPart();
    const measures = [equalDescriptor(0, 'a'), equalDescriptor(1, 'b')];
    expect(
      buildScannerComparisonBlocks({
        partMatch: match,
        ...sides(measures, measures, match)
      })
    ).toEqual([]);
  });

  it('groups adjacent rich differences between equal context measures', () => {
    const match = matchedPart();
    const contextBefore = equalDescriptor(0, 'context-before');
    const contextAfter = equalDescriptor(3, 'context-after');
    const base = [
      contextBefore,
      descriptor(1, 'same-one', 'base-one', {
        notation: 'same-notation-one',
        voice: 'base-voice'
      }),
      descriptor(2, 'same-two', 'base-two', {
        notation: 'same-notation-two',
        attributes: 'base-attributes'
      }),
      contextAfter
    ];
    const candidate = [
      contextBefore,
      descriptor(1, 'same-one', 'candidate-one', {
        notation: 'same-notation-one',
        voice: 'candidate-voice'
      }),
      descriptor(2, 'same-two', 'candidate-two', {
        notation: 'same-notation-two',
        attributes: 'candidate-attributes'
      }),
      contextAfter
    ];

    const blocks = buildScannerComparisonBlocks({
      partMatch: match,
      ...sides(base, candidate, match)
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      version: SCANNER_COMPARISON_BLOCK_VERSION,
      blockIndex: 0,
      pair: { baseEngineId: 'homr', candidateEngineId: 'transcoda' },
      stablePartKey: match.stablePartKey,
      baseMeasureRefs: [
        { engine: 'homr', documentPartId: 'P1', measureIndex: 1 },
        { engine: 'homr', documentPartId: 'P1', measureIndex: 2 }
      ],
      candidateMeasureRefs: [
        { engine: 'transcoda', documentPartId: 'random-part-id', measureIndex: 1 },
        { engine: 'transcoda', documentPartId: 'random-part-id', measureIndex: 2 }
      ],
      differenceClasses: ['attributes', 'voice'],
      contentSignature: expect.stringMatching(/^scanner-block-content-v2:[a-f0-9]{64}$/)
    });
  });

  it('forms one replacement block and explicit insertion/removal blocks', () => {
    const match = matchedPart();
    const before = equalDescriptor(0, 'before');
    const afterBase = equalDescriptor(3, 'after');
    const afterCandidate = { ...afterBase, measureIndex: 3 };
    const replacement = buildScannerComparisonBlocks({
      partMatch: match,
      ...sides(
        [before, descriptor(1, 'base-a', 'base-a'), descriptor(2, 'base-b', 'base-b'), afterBase],
        [
          before,
          descriptor(1, 'candidate-a', 'candidate-a'),
          descriptor(2, 'candidate-b', 'candidate-b'),
          afterCandidate
        ],
        match
      )
    });
    expect(replacement).toHaveLength(1);
    expect(replacement[0].baseMeasureRefs).toHaveLength(2);
    expect(replacement[0].candidateMeasureRefs).toHaveLength(2);
    expect(replacement[0].differenceClasses).toContain('notation');

    const insertionCandidate = [
      equalDescriptor(0, 'before'),
      descriptor(1, 'inserted', 'inserted'),
      equalDescriptor(2, 'after')
    ];
    const insertionBase = [equalDescriptor(0, 'before'), equalDescriptor(1, 'after')];
    const insertion = buildScannerComparisonBlocks({
      partMatch: match,
      ...sides(insertionBase, insertionCandidate, match)
    });
    expect(insertion[0]).toMatchObject({
      baseMeasureRefs: [],
      candidateMeasureRefs: [{ measureIndex: 1 }],
      differenceClasses: ['measure-added']
    });

    const removal = buildScannerComparisonBlocks({
      partMatch: match,
      ...sides(insertionCandidate, insertionBase, match)
    });
    expect(removal[0]).toMatchObject({
      baseMeasureRefs: [{ measureIndex: 1 }],
      candidateMeasureRefs: [],
      differenceClasses: ['measure-removed']
    });
  });

  it('anchors a block the base does not read to the measure it follows', () => {
    // A block with base measures knows where it is from those. One the base
    // never read has no position at all without this, and "insert these bars"
    // is meaningless without one — the matched measures between blocks are not
    // themselves blocks, so nothing else can supply it.
    const match = matchedPart();
    const candidate = [
      equalDescriptor(0, 'before'),
      equalDescriptor(1, 'also-before'),
      descriptor(2, 'inserted', 'inserted'),
      equalDescriptor(3, 'after')
    ];
    const base = [
      equalDescriptor(0, 'before'),
      equalDescriptor(1, 'also-before'),
      equalDescriptor(2, 'after')
    ];

    const insertion = buildScannerComparisonBlocks({
      partMatch: match,
      ...sides(base, candidate, match)
    });
    expect(insertion[0]).toMatchObject({
      baseMeasureRefs: [],
      candidateMeasureRefs: [{ measureIndex: 2 }],
      // The inserted bar belongs after the base's measure 1, not at the start.
      baseAnchorIndex: 1
    });

    // A block the base *does* read is anchored by its own first measure.
    const removal = buildScannerComparisonBlocks({
      partMatch: match,
      ...sides(candidate, base, match)
    });
    expect(removal[0]).toMatchObject({
      baseMeasureRefs: [{ measureIndex: 2 }],
      baseAnchorIndex: 1
    });
  });

  it('anchors a block before the first bar to the start of the part', () => {
    const match = matchedPart();
    const candidate = [descriptor(0, 'inserted', 'inserted'), equalDescriptor(1, 'after')];
    const base = [equalDescriptor(0, 'after')];

    const blocks = buildScannerComparisonBlocks({
      partMatch: match,
      ...sides(base, candidate, match)
    });
    expect(blocks[0]).toMatchObject({ baseMeasureRefs: [], baseAnchorIndex: -1 });
  });

  it('uses a conservative fuzzy pair as a block boundary, not an equality claim', () => {
    const match = matchedPart();
    const before = equalDescriptor(0, 'before');
    const afterBase = equalDescriptor(3, 'after');
    const afterCandidate = equalDescriptor(2, 'after');
    const base = [
      before,
      fuzzyDescriptor(1, 'base-fuzzy', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']),
      descriptor(2, 'removed', 'removed'),
      afterBase
    ];
    const candidate = [
      before,
      fuzzyDescriptor(1, 'candidate-fuzzy', ['a', 'b', 'c', 'd', 'e', 'f', 'x', 'h']),
      afterCandidate
    ];

    const blocks = buildScannerComparisonBlocks({
      partMatch: match,
      ...sides(base, candidate, match)
    });

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      baseMeasureRefs: [{ measureIndex: 1 }],
      candidateMeasureRefs: [{ measureIndex: 1 }],
      differenceClasses: expect.arrayContaining(['notation'])
    });
    expect(blocks[1]).toMatchObject({
      baseMeasureRefs: [{ measureIndex: 2 }],
      candidateMeasureRefs: [],
      differenceClasses: ['measure-removed']
    });
  });

  it('binds the signature to immediate equal context', () => {
    const match = matchedPart();
    const conflictBase = descriptor(1, 'same-conflict', 'base-conflict', {
      notation: 'same-notation',
      voice: 'base-voice'
    });
    const conflictCandidate = descriptor(1, 'same-conflict', 'candidate-conflict', {
      notation: 'same-notation',
      voice: 'candidate-voice'
    });
    const build = (contextRichHash: string) => {
      const context = descriptor(0, 'same-context', contextRichHash);
      return buildScannerComparisonBlocks({
        partMatch: match,
        ...sides([context, conflictBase], [context, conflictCandidate], match)
      })[0].contentSignature;
    };

    expect(build('context-v1')).toBe(build('context-v1'));
    expect(build('context-v2')).not.toBe(build('context-v1'));
  });

  it('canonicalizes checksums before emitting identities and signatures', () => {
    const match = matchedPart();
    const base = descriptor(0, 'same', 'base', { voice: 'base-voice' });
    const candidate = descriptor(0, 'same', 'candidate', { voice: 'candidate-voice' });
    const lowerSides = sides([base], [candidate], match);
    const upperSides = sides([base], [candidate], match);
    upperSides.base.artifactChecksumSha256 = upperSides.base.artifactChecksumSha256.toUpperCase();
    upperSides.candidate.artifactChecksumSha256 =
      upperSides.candidate.artifactChecksumSha256.toUpperCase();

    const lower = buildScannerComparisonBlocks({ partMatch: match, ...lowerSides })[0];
    const upper = buildScannerComparisonBlocks({ partMatch: match, ...upperSides })[0];
    expect(upper.contentSignature).toBe(lower.contentSignature);
    expect(upper.baseMeasureRefs[0].artifactChecksumSha256).toBe(match.base.artifactChecksumSha256);
    expect(upper.candidateMeasureRefs[0].artifactChecksumSha256).toBe(
      match.candidate.artifactChecksumSha256
    );
  });

  it('warns only for limitations involved in this block', () => {
    const match = matchedPart();
    const base = descriptor(0, 'same', 'base', {
      notation: 'same-notation',
      lyrics: 'base-lyrics'
    });
    const candidate = descriptor(0, 'same', 'candidate', {
      notation: 'same-notation',
      lyrics: 'candidate-lyrics'
    });
    const inputSides = sides([base], [candidate], match);
    inputSides.candidate.completeness = 'possibly-incomplete';
    inputSides.candidate.unsupportedSemanticClasses = ['dynamics', 'lyrics'];

    const block = buildScannerComparisonBlocks({ partMatch: match, ...inputSides })[0];
    expect(block.differenceClasses).toEqual(['lyrics']);
    expect(block.completenessWarnings).toEqual([
      {
        engineId: 'transcoda',
        code: 'output-completeness',
        detail: 'Engine output completeness is possibly-incomplete'
      },
      {
        engineId: 'transcoda',
        code: 'unsupported-semantic-class',
        semanticClass: 'lyrics',
        detail: 'Engine does not support lyrics'
      }
    ]);
  });

  it('refuses side identity or measure-order mismatches', () => {
    const match = matchedPart();
    const inputSides = sides([equalDescriptor(0, 'a')], [equalDescriptor(0, 'a')], match);
    inputSides.candidate.documentPartId = 'wrong-part';
    expect(() => buildScannerComparisonBlocks({ partMatch: match, ...inputSides })).toThrow(
      /does not match the selected part endpoint/
    );

    const orderedSides = sides([equalDescriptor(1, 'a')], [equalDescriptor(0, 'a')], match);
    expect(() => buildScannerComparisonBlocks({ partMatch: match, ...orderedSides })).toThrow(
      /ordered and contiguous/
    );
  });
});

describe('scanner comparison analysis gate', () => {
  it('forms a signed block through the real MusicXML analysis pipeline', () => {
    const score = (partId: string, middleStep: string): Buffer =>
      Buffer.from(`<score-partwise version="4.0">
        <part-list><score-part id="${partId}"><part-name>Violin</part-name></score-part></part-list>
        <part id="${partId}">
          <measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure>
          <measure number="2"><note><pitch><step>${middleStep}</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure>
          <measure number="3"><note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure>
        </part>
      </score-partwise>`);
    const baseXml = score('P1', 'D');
    const candidateXml = score('generated-id', 'E');
    const baseDocument = {
      engineId: 'engine-a',
      artifactChecksumSha256: sha(baseXml),
      musicXml: baseXml
    };
    const candidateDocument = {
      engineId: 'engine-b',
      artifactChecksumSha256: sha(candidateXml),
      musicXml: candidateXml
    };
    const partMatchResult = matchScannerMusicXmlParts(baseDocument, candidateDocument);

    const result = buildScannerComparisonAnalysis({
      partMatchResult,
      base: {
        engineId: baseDocument.engineId,
        artifactChecksumSha256: baseDocument.artifactChecksumSha256,
        parts: describeScannerMusicXmlMeasures(baseXml)
      },
      candidate: {
        engineId: candidateDocument.engineId,
        artifactChecksumSha256: candidateDocument.artifactChecksumSha256,
        parts: describeScannerMusicXmlMeasures(candidateXml)
      }
    });

    expect(result).toMatchObject({
      status: 'succeeded',
      blocks: [
        {
          blockIndex: 0,
          pair: { baseEngineId: 'engine-a', candidateEngineId: 'engine-b' },
          baseMeasureRefs: [{ documentPartId: 'P1', measureIndex: 1 }],
          candidateMeasureRefs: [{ documentPartId: 'generated-id', measureIndex: 1 }],
          differenceClasses: ['notation'],
          contentSignature: expect.stringMatching(/^scanner-block-content-v2:[a-f0-9]{64}$/)
        }
      ]
    });
  });

  it('refuses the entire page when any part match is unresolved', () => {
    const match = matchedPart();
    const refusal: ScannerPartMatch = {
      outcome: 'ambiguous',
      base: { ...match.base, documentPartId: 'P2', ordinal: 1 },
      candidate: { ...match.candidate, documentPartId: 'candidate-2', ordinal: 1 },
      evidence: {},
      refusalReason: 'Part 2 has no unique cross-engine match'
    };

    expect(
      buildScannerComparisonAnalysis({
        partMatchResult: {
          version: SCANNER_PART_MATCH_VERSION,
          pair: { baseEngineId: 'homr', candidateEngineId: 'transcoda' },
          matches: [match, refusal],
          comparisonAllowed: false,
          refusalReasons: [refusal.refusalReason]
        },
        base: {
          engineId: 'homr',
          artifactChecksumSha256: match.base.artifactChecksumSha256,
          parts: []
        },
        candidate: {
          engineId: 'transcoda',
          artifactChecksumSha256: match.candidate.artifactChecksumSha256,
          parts: []
        }
      })
    ).toMatchObject({
      version: SCANNER_COMPARISON_ANALYSIS_VERSION,
      status: 'refused',
      refusalReasons: [refusal.refusalReason]
    });
  });

  it('builds all matched parts and numbers their blocks page-wide', () => {
    const first = matchedPart();
    const second: Extract<ScannerPartMatch, { outcome: 'matched' }> = {
      ...first,
      stablePartKey: `scanner-part-v1:${sha('second-part')}`,
      base: { ...first.base, documentPartId: 'P2', ordinal: 1 },
      candidate: { ...first.candidate, documentPartId: 'candidate-2', ordinal: 1 }
    };
    const changed = (prefix: string) => [
      descriptor(0, `${prefix}-same`, `${prefix}-base`, { voice: `${prefix}-base-voice` })
    ];
    const candidateChanged = (prefix: string) => [
      descriptor(0, `${prefix}-same`, `${prefix}-candidate`, {
        voice: `${prefix}-candidate-voice`
      })
    ];

    const result = buildScannerComparisonAnalysis({
      partMatchResult: {
        version: SCANNER_PART_MATCH_VERSION,
        pair: { baseEngineId: 'homr', candidateEngineId: 'transcoda' },
        matches: [first, second],
        comparisonAllowed: true,
        refusalReasons: []
      },
      base: {
        engineId: 'homr',
        artifactChecksumSha256: first.base.artifactChecksumSha256,
        parts: [
          { documentPartId: 'P1', measures: changed('first') },
          { documentPartId: 'P2', measures: changed('second') }
        ]
      },
      candidate: {
        engineId: 'transcoda',
        artifactChecksumSha256: first.candidate.artifactChecksumSha256,
        parts: [
          { documentPartId: 'random-part-id', measures: candidateChanged('first') },
          { documentPartId: 'candidate-2', measures: candidateChanged('second') }
        ]
      }
    });

    expect(result).toMatchObject({
      version: SCANNER_COMPARISON_ANALYSIS_VERSION,
      status: 'succeeded',
      blocks: [
        { blockIndex: 0, stablePartKey: first.stablePartKey },
        { blockIndex: 1, stablePartKey: second.stablePartKey }
      ]
    });
  });

  it('requires descriptor coverage to exactly match the authorized parts', () => {
    const match = matchedPart();
    expect(() =>
      buildScannerComparisonAnalysis({
        partMatchResult: {
          version: SCANNER_PART_MATCH_VERSION,
          pair: { baseEngineId: 'homr', candidateEngineId: 'transcoda' },
          matches: [match],
          comparisonAllowed: true,
          refusalReasons: []
        },
        base: {
          engineId: 'homr',
          artifactChecksumSha256: match.base.artifactChecksumSha256,
          parts: []
        },
        candidate: {
          engineId: 'transcoda',
          artifactChecksumSha256: match.candidate.artifactChecksumSha256,
          parts: []
        }
      })
    ).toThrow(/cover exactly the matched parts/);
  });

  it('rejects a malformed allowed result that reuses a part endpoint', () => {
    const match = matchedPart();
    const duplicate: Extract<ScannerPartMatch, { outcome: 'matched' }> = {
      ...match,
      stablePartKey: `scanner-part-v1:${sha('duplicate')}`
    };
    expect(() =>
      buildScannerComparisonAnalysis({
        partMatchResult: {
          version: SCANNER_PART_MATCH_VERSION,
          pair: { baseEngineId: 'homr', candidateEngineId: 'transcoda' },
          matches: [match, duplicate],
          comparisonAllowed: true,
          refusalReasons: []
        },
        base: {
          engineId: 'homr',
          artifactChecksumSha256: match.base.artifactChecksumSha256,
          parts: []
        },
        candidate: {
          engineId: 'transcoda',
          artifactChecksumSha256: match.candidate.artifactChecksumSha256,
          parts: []
        }
      })
    ).toThrow(/must be one-to-one/);
  });
});
