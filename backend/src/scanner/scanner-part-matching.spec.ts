import { createHash } from 'node:crypto';
import {
  matchScannerMusicXmlParts,
  MAX_SCANNER_COMPARISON_PARTS,
  normalizeScannerPartName,
  SCANNER_PART_MATCH_VERSION
} from './scanner-part-matching';

interface FixturePart {
  id: string;
  name?: string;
  staves?: number;
  notes?: number;
  restEvery?: number;
}

function score(parts: FixturePart[]): Buffer {
  const partList = parts
    .map(
      (part) => `<score-part id="${part.id}"><part-name>${part.name || ''}</part-name></score-part>`
    )
    .join('');
  const bodies = parts
    .map((part) => {
      const notes = Array.from({ length: part.notes ?? 4 }, (_, index) =>
        part.restEvery && index % part.restEvery === 0
          ? '<note><rest/><duration>1</duration><voice>1</voice></note>'
          : '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>'
      ).join('');
      return `<part id="${part.id}"><measure number="1"><attributes><staves>${
        part.staves || 1
      }</staves></attributes>${notes}</measure></part>`;
    })
    .join('');
  return Buffer.from(
    `<score-partwise><part-list>${partList}</part-list>${bodies}</score-partwise>`
  );
}

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function document(engineId: string, parts: FixturePart[]) {
  const musicXml = score(parts);
  return { engineId, artifactChecksumSha256: sha(musicXml), musicXml };
}

describe('scanner part matching', () => {
  it('matches genuine HOMR/music21-shaped IDs without treating IDs as identity', () => {
    const result = matchScannerMusicXmlParts(
      document('homr', [{ id: 'P1', name: 'Piano', staves: 2, notes: 8 }]),
      document('transcoda', [
        { id: 'P68eb6a19a44c2406b6bf74275797c83e', name: 'Piano', staves: 2, notes: 7 }
      ])
    );

    expect(result).toMatchObject({
      version: SCANNER_PART_MATCH_VERSION,
      comparisonAllowed: true,
      pair: { baseEngineId: 'homr', candidateEngineId: 'transcoda' },
      matches: [
        {
          outcome: 'matched',
          stablePartKey: expect.stringMatching(/^scanner-part-v1:[a-f0-9]{64}$/),
          base: { documentPartId: 'P1', normalizedName: 'piano', staffCount: 2 },
          candidate: {
            documentPartId: 'P68eb6a19a44c2406b6bf74275797c83e',
            normalizedName: 'piano',
            staffCount: 2
          },
          evidence: { normalizedNameEqual: true, staffCountEqual: true }
        }
      ]
    });
  });

  it('uses names and structure when document order changes', () => {
    const result = matchScannerMusicXmlParts(
      document('engine-a', [
        { id: 'A1', name: 'Flute', notes: 9 },
        { id: 'A2', name: 'Piano', staves: 2, notes: 14 }
      ]),
      document('engine-b', [
        { id: 'B1', name: 'Piano', staves: 2, notes: 13 },
        { id: 'B2', name: 'Flute', notes: 8 }
      ])
    );

    expect(result.comparisonAllowed).toBe(true);
    expect(
      result.matches
        .filter((match) => match.outcome === 'matched')
        .map((match: any) => [match.base.documentPartId, match.candidate.documentPartId])
    ).toEqual([
      ['A1', 'B2'],
      ['A2', 'B1']
    ]);
  });

  it('refuses indistinguishable duplicate parts instead of trusting ordinal order', () => {
    const result = matchScannerMusicXmlParts(
      document('engine-a', [
        { id: 'A1', name: 'Violin', notes: 8 },
        { id: 'A2', name: 'Violin', notes: 8 }
      ]),
      document('engine-b', [
        { id: 'B1', name: 'Violin', notes: 8 },
        { id: 'B2', name: 'Violin', notes: 8 }
      ])
    );

    expect(result.comparisonAllowed).toBe(false);
    expect(result.matches.some((match) => match.outcome === 'matched')).toBe(false);
    expect(result.matches.every((match) => match.outcome === 'ambiguous')).toBe(true);
    expect(result.refusalReasons).toEqual(
      expect.arrayContaining([expect.stringContaining('no unique cross-engine match')])
    );
  });

  it('refuses a staff-count mismatch even when names and ordinals agree', () => {
    const result = matchScannerMusicXmlParts(
      document('engine-a', [{ id: 'A1', name: 'Piano', staves: 2 }]),
      document('engine-b', [{ id: 'B1', name: 'Piano', staves: 1 }])
    );

    expect(result.comparisonAllowed).toBe(false);
    expect(result.matches.map((match) => match.outcome)).toEqual(['unmatched', 'unmatched']);
  });

  it('normalizes superficial name spelling but does not invent instrument aliases', () => {
    expect(normalizeScannerPartName('  VIOLIN—1  ')).toBe('violin 1');
    expect(normalizeScannerPartName('Pno.')).toBe('pno');
    expect(normalizeScannerPartName('Piano')).toBe('piano');
  });

  it('binds stable keys to ordered engines and artifact revisions', () => {
    const make = (baseEngine: string, noteCount: number) =>
      matchScannerMusicXmlParts(
        document(baseEngine, [{ id: 'P1', name: 'Piano', notes: noteCount }]),
        document('engine-b', [{ id: 'random-id', name: 'Piano' }])
      ).matches[0];
    const first: any = make('engine-a', 4);

    expect(make('engine-a', 4)).toEqual(first);
    expect((make('engine-a', 5) as any).stablePartKey).not.toBe(first.stablePartKey);
    expect((make('engine-c', 4) as any).stablePartKey).not.toBe(first.stablePartKey);
  });

  it('rejects invalid pair identity before attempting an unsafe comparison', () => {
    const musicXml = score([{ id: 'P1', name: 'Piano' }]);
    expect(() =>
      matchScannerMusicXmlParts(
        { engineId: 'homr', artifactChecksumSha256: sha(musicXml), musicXml },
        { engineId: 'homr', artifactChecksumSha256: sha(musicXml), musicXml }
      )
    ).toThrow(/distinct engines/);
    expect(() =>
      matchScannerMusicXmlParts(
        { engineId: 'homr', artifactChecksumSha256: 'not-a-checksum', musicXml },
        { engineId: 'transcoda', artifactChecksumSha256: sha('b'), musicXml }
      )
    ).toThrow(/document identity/);
    expect(() =>
      matchScannerMusicXmlParts(
        { engineId: 'homr', artifactChecksumSha256: sha('different bytes'), musicXml },
        document('transcoda', [{ id: 'P1', name: 'Piano' }])
      )
    ).toThrow(/checksum does not match/);
  });

  it('caps the quadratic part candidate space', () => {
    const tooMany = Array.from({ length: MAX_SCANNER_COMPARISON_PARTS + 1 }, (_, index) => ({
      id: `P${index + 1}`,
      name: `Part ${index + 1}`,
      notes: 1
    }));
    expect(() =>
      matchScannerMusicXmlParts(
        {
          engineId: 'engine-a',
          artifactChecksumSha256: sha(score(tooMany)),
          musicXml: score(tooMany)
        },
        document('engine-b', [{ id: 'B1', name: 'Part 1', notes: 1 }])
      )
    ).toThrow(/between 1 and 256 parts/);
  });
});
