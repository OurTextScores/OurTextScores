import {
  buildLyricCandidateInventory,
  looksLikeCredit,
  lyricCandidateCrop,
  LYRIC_CANDIDATE_SCHEMA
} from './scanner-lyric-candidates';

const raster = { checksumSha256: 'r', width: 1000, height: 800 };
const lyric = (id: string, box: number[], extra: object = {}) => ({
  id,
  label: 'Lyrics',
  box,
  rawConfidence: 0.8,
  calibratedConfidence: 0.7,
  ...extra
});
const region = (status: string, candidates: object[], reason = 'independent') => ({
  status,
  reason,
  candidates
});

describe('buildLyricCandidateInventory', () => {
  it('lists only lyric candidates of accepted or review regions in reading order', () => {
    const inventory = buildLyricCandidateInventory(
      {
        textPolicy: { mode: 'fusion-v1' },
        fusedRegions: [
          region('accepted', [lyric('b', [300, 500, 400, 540])]),
          region(
            'review',
            [
              lyric('a', [100, 100, 200, 140]),
              { id: 'd', label: 'Tempo', box: [100, 100, 200, 140], rawConfidence: 0.5 }
            ],
            'insufficient-margin'
          ),
          region('rejected', [lyric('r', [0, 0, 10, 10])], 'invalid-box'),
          region('accepted', [{ id: 'x', label: 'Tempo', box: [1, 1, 5, 5], rawConfidence: 0.9 }])
        ]
      },
      2,
      raster
    );
    expect(inventory.schemaVersion).toBe(LYRIC_CANDIDATE_SCHEMA);
    expect(inventory.automaticAttachment).toBe(false);
    expect(inventory.candidates.map((c) => c.id)).toEqual(['a', 'b']);
    expect(inventory.candidates[0]).toMatchObject({
      regionStatus: 'review',
      reason: 'insufficient-margin',
      competingText: true,
      text: '',
      textSource: 'none'
    });
    expect(inventory.candidates[1].competingText).toBe(false);
  });

  it.each([
    ['box outside the page', [900, 100, 1200, 140]],
    ['empty box', [10, 10, 10, 40]],
    ['non-integer box', [1.5, 2, 30, 40]]
  ])('refuses a %s', (_name, box) => {
    expect(() =>
      buildLyricCandidateInventory(
        { fusedRegions: [region('accepted', [lyric('a', box)])] },
        1,
        raster
      )
    ).toThrow();
  });

  it('refuses duplicate ids, bad confidence and a missing region list', () => {
    expect(() =>
      buildLyricCandidateInventory(
        {
          fusedRegions: [
            region('accepted', [lyric('a', [1, 1, 5, 5])]),
            region('accepted', [lyric('a', [9, 9, 19, 19])])
          ]
        },
        1,
        raster
      )
    ).toThrow();
    expect(() =>
      buildLyricCandidateInventory(
        { fusedRegions: [region('accepted', [lyric('a', [1, 1, 5, 5], { rawConfidence: 2 })])] },
        1,
        raster
      )
    ).toThrow();
    expect(() => buildLyricCandidateInventory({}, 1, raster)).toThrow();
  });
});

describe('looksLikeCredit', () => {
  it.each([
    'PAUL DUPONT Editeur, 4, rue du Bouloi.',
    'B.& H.20327',
    '© 1912 Breitkopf',
    'Verlag von C. F. Peters',
    'Edition Peters Nº 4'
  ])('flags imprint text: %s', (text) => expect(looksLikeCredit(text)).toBe(true));

  it.each([
    "He doesn't love me.",
    'wish -ing',
    'ziehn,......wir müssen',
    "Quand j'aurai jeté",
    'rêves',
    'In the year we met'
  ])('leaves sung text alone: %s', (text) => expect(looksLikeCredit(text)).toBe(false));
});

describe('OCR rows', () => {
  const row = (text: string, box: number[], extra: object = {}) => ({
    box,
    text,
    ocrConfidence: 0.9,
    regionCoverage: 0.7,
    semantic: 'Lyrics',
    semanticScore: 0.8,
    proposedLyric: true,
    ...extra
  });

  it('are absent without lyricText, carried with stable ids, and deduplicated', () => {
    expect(buildLyricCandidateInventory({ fusedRegions: [] }, 1, raster)).toMatchObject({
      ocrRows: [],
      ocrStatus: 'absent'
    });
    const artifact = {
      fusedRegions: [],
      lyricText: {
        status: 'ok',
        rows: [
          row('kind,', [10, 10, 60, 30]),
          row('kind,', [10, 10, 60, 30]),
          row('a tempo.', [70, 10, 120, 30], { semantic: 'DirectionText', proposedLyric: false })
        ]
      }
    };
    const first = buildLyricCandidateInventory(artifact, 1, raster);
    const again = buildLyricCandidateInventory(artifact, 1, raster);
    expect(first.ocrRows.map((r) => r.text)).toEqual(['kind,', 'a tempo.']);
    expect(first.ocrRows.map((r) => r.id)).toEqual(again.ocrRows.map((r) => r.id));
    expect(first.ocrRows[0].id).toMatch(/^ocr-[0-9a-f]{20}$/);
    expect(first.ocrRows[1].proposedLyric).toBe(false);
    expect(first.ocrStatus).toBe('ok');
  });

  it('carry an anchor when staves are supplied and null otherwise', () => {
    const artifact = {
      fusedRegions: [],
      lyricText: { status: 'ok', rows: [row('kind,', [90, 170, 140, 190])] }
    };
    const staff = {
      index: 0,
      region: [0, 100, 1000, 160],
      tokens: [['clef_G2'], ['note_8', 'C4'], ['barline']],
      barLines: [300],
      symbols: [{ index: 1, attention: [128, 0] }]
    };
    expect(buildLyricCandidateInventory(artifact, 1, raster).ocrRows[0].anchor).toBeNull();
    const anchored = buildLyricCandidateInventory(artifact, 1, raster, [staff]).ocrRows[0].anchor;
    expect(anchored).toMatchObject({ staffIndex: 0, printedLine: 1 });
    expect(anchored!.syllables[0]).toMatchObject({ notePitch: 'C4', measureInStaff: 0 });
  });

  it('withhold a gate-approved row that no staff reaches, but only when staves are known', () => {
    const staff = {
      index: 0,
      region: [0, 300, 1000, 360],
      tokens: [['clef_G2'], ['note_8', 'C4'], ['barline']],
      barLines: [300],
      symbols: [{ index: 1, attention: [128, 0] }]
    };
    const artifact = {
      fusedRegions: [],
      lyricText: {
        status: 'ok',
        rows: [row('FRANZ SCHUBERT.', [10, 20, 200, 60]), row('kind,', [90, 370, 140, 390])]
      }
    };
    const withStaves = buildLyricCandidateInventory(artifact, 1, raster, [staff]).ocrRows;
    expect(withStaves.map((r) => [r.text, r.proposedLyric, r.withheldReason])).toEqual([
      ['FRANZ SCHUBERT.', false, 'no-staff'],
      ['kind,', true, null]
    ]);
    const without = buildLyricCandidateInventory(artifact, 1, raster).ocrRows;
    expect(without.every((r) => r.proposedLyric && r.withheldReason === null)).toBe(true);
  });

  it('withhold a gate-approved row under a staff but far from all of its notes', () => {
    const staff = {
      index: 0,
      region: [0, 100, 1000, 160],
      tokens: [['clef_G2'], ['note_8', 'C4'], ['barline']],
      barLines: [900],
      symbols: [{ index: 1, attention: [128, 0] }]
    };
    const artifact = {
      fusedRegions: [],
      lyricText: {
        status: 'ok',
        rows: [row('PAUL', [600, 170, 680, 190]), row('kind,', [90, 170, 140, 190])]
      }
    };
    const rows = buildLyricCandidateInventory(artifact, 1, raster, [staff]).ocrRows;
    expect(rows.map((r) => [r.text, r.proposedLyric, r.withheldReason])).toEqual([
      ['PAUL', false, 'far-from-notes'],
      ['kind,', true, null]
    ]);
  });

  it('withhold a gate-approved row in the bottom margin of the page', () => {
    // raster is 1000x800: the footer starts at y > 0.92 * 800 = 736.
    const artifact = {
      fusedRegions: [],
      lyricText: {
        status: 'ok',
        rows: [row('Made in England', [100, 750, 300, 790]), row('kind,', [100, 600, 160, 640])]
      }
    };
    const rows = buildLyricCandidateInventory(artifact, 1, raster).ocrRows;
    expect(rows.map((r) => [r.text, r.proposedLyric, r.withheldReason])).toEqual([
      ['Made in England', false, 'footer'],
      ['kind,', true, null]
    ]);
  });

  it('report a failed OCR run and refuse a row outside the page', () => {
    expect(
      buildLyricCandidateInventory(
        { fusedRegions: [], lyricText: { status: 'failed', rows: [] } },
        1,
        raster
      ).ocrStatus
    ).toBe('failed');
    expect(() =>
      buildLyricCandidateInventory(
        { fusedRegions: [], lyricText: { status: 'ok', rows: [row('x', [900, 10, 1200, 30])] } },
        1,
        raster
      )
    ).toThrow();
  });
});

describe('lyricCandidateCrop', () => {
  const candidate = (box: [number, number, number, number]) =>
    buildLyricCandidateInventory(
      { fusedRegions: [region('accepted', [lyric('a', box)])] },
      1,
      raster
    ).candidates[0];

  it('pads and clamps to the page', () => {
    expect(lyricCandidateCrop(candidate([10, 10, 110, 50]), raster)).toEqual({
      left: 0,
      top: 0,
      width: 134,
      height: 74
    });
  });

  it('refuses an unreasonably large crop', () => {
    const big = { checksumSha256: 'r', width: 6000, height: 6000 };
    const c = buildLyricCandidateInventory(
      { fusedRegions: [region('accepted', [lyric('a', [0, 0, 5000, 5000])])] },
      1,
      big
    ).candidates[0];
    expect(lyricCandidateCrop(c, big)).toBeNull();
  });
});
