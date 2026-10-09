import {
  buildLyricCandidateInventory,
  settleUnplaced,
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

describe('direction rows in the inventory', () => {
  const staffForTest = {
    index: 0,
    partIndex: 0,
    systemIndex: 0,
    region: [0, 100, 1000, 160],
    tokens: [['clef_G2'], ['note_4', 'C4'], ['note_4', 'D4'], ['barline']],
    barLines: [900],
    symbols: [
      { index: 1, attention: [128, 0] },
      { index: 2, attention: [256, 0] }
    ]
  };
  const artifact = (rows: object[]) => ({
    fusedRegions: [],
    lyricText: { status: 'ok', rows: [], rowsOmitted: 0, directionRows: { rows, rowsOmitted: 0 } }
  });
  const row = (text: string, box: number[], kind = 'words', extra: object = {}) => ({
    box,
    text,
    kind,
    semantic: 'DirectionText',
    semanticScore: 0.1,
    ocrConfidence: 0.9,
    ...extra
  });

  it('offers anchored direction and dynamic rows, and withholds footer, credit and unanchored ones', () => {
    const inventory = buildLyricCandidateInventory(
      artifact([
        row('dolce', [90, 60, 180, 85]),
        row('mf', [120, 175, 150, 195], 'dynamic', { mark: 'mf' }),
        row('Peters Verlag', [90, 60, 180, 85]),
        row('rit.', [90, 760, 180, 790]),
        row('Allegro', [500, 400, 600, 420])
      ]),
      1,
      raster,
      [staffForTest]
    );
    const byText = Object.fromEntries(inventory.ocrRows.map((r) => [r.text, r]));
    expect(byText['dolce']).toMatchObject({
      kind: 'words',
      proposedDirection: true,
      proposedLyric: false
    });
    expect(byText['dolce'].anchor!.syllables[0].noteTokenIndex).toBe(1);
    expect(byText['mf']).toMatchObject({ kind: 'dynamic', mark: 'mf', proposedDirection: true });
    expect(byText['Peters Verlag']).toMatchObject({
      proposedDirection: false,
      withheldReason: 'credit-like'
    });
    expect(byText['rit.']).toMatchObject({ proposedDirection: false, withheldReason: 'no-staff' });
    expect(byText['Allegro']).toMatchObject({
      proposedDirection: false,
      withheldReason: 'no-staff'
    });
  });

  it('offers a direction in the bottom margin when a staff reaches it, and withholds a plate number', () => {
    const lastSystem = { ...staffForTest, region: [0, 690, 1000, 760] };
    const inventory = buildLyricCandidateInventory(
      artifact([
        row('una corda', [90, 765, 190, 790]),
        row('F. E. C. L. 4913', [90, 770, 300, 795])
      ]),
      1,
      raster,
      [lastSystem]
    );
    const byText = Object.fromEntries(inventory.ocrRows.map((r) => [r.text, r]));
    expect(byText['una corda']).toMatchObject({ proposedDirection: true, withheldReason: null });
    expect(byText['F. E. C. L. 4913']).toMatchObject({
      proposedDirection: false,
      withheldReason: 'credit-like'
    });
  });

  it('offers a direction a staff reaches but no note is near as unplaced, instead of withholding it', () => {
    const inventory = buildLyricCandidateInventory(
      artifact([
        row('p', [940, 175, 975, 195], 'dynamic', { mark: 'p' }),
        row('cresc.', [920, 60, 990, 85]),
        row('dolce', [90, 60, 180, 85])
      ]),
      1,
      raster,
      [staffForTest]
    );
    const byText = Object.fromEntries(inventory.ocrRows.map((r) => [r.text, r]));
    expect(byText['p']).toMatchObject({
      proposedDirection: true,
      unplaced: true,
      withheldReason: null
    });
    expect(byText['cresc.']).toMatchObject({ proposedDirection: true, unplaced: true });
    expect(byText['dolce'].unplaced).toBeUndefined();
    expect(byText['p'].anchor!.syllables[0].noteTokenIndex).toBeNull();
  });

  it('keeps who read a direction row, and ignores an unknown source', () => {
    const inventory = buildLyricCandidateInventory(
      artifact([
        row('f', [120, 175, 150, 195], 'dynamic', { mark: 'f', source: 'classifier' }),
        row('p', [300, 175, 330, 195], 'dynamic', { mark: 'p', source: 'ocr' }),
        row('mf', [500, 175, 530, 195], 'dynamic', { mark: 'mf', source: 'guess' })
      ]),
      1,
      raster,
      [staffForTest]
    );
    const byText = Object.fromEntries(inventory.ocrRows.map((r) => [r.text, r]));
    expect(byText['f'].source).toBe('classifier');
    expect(byText['p'].source).toBe('ocr');
    expect(byText['mf'].source).toBeUndefined();
  });

  it('rejects a direction row outside the page or of an unknown kind', () => {
    expect(() =>
      buildLyricCandidateInventory(artifact([row('p', [10, 10, 2000, 30])]), 1, raster, [])
    ).toThrow(/direction row/);
    expect(() =>
      buildLyricCandidateInventory(artifact([row('p', [10, 10, 30, 30], 'lyric')]), 1, raster, [])
    ).toThrow(/direction row/);
  });
});

describe('settleUnplaced', () => {
  const base = {
    id: 'r',
    box: [0, 0, 5, 5],
    text: 'p',
    unplaced: true,
    proposedDirection: true,
    withheldReason: null
  } as any;

  it('keeps an unplaced row that has notes to choose from', () => {
    const row = { ...base, noteChoices: [{ number: 1 }] };
    settleUnplaced(row);
    expect(row).toMatchObject({ unplaced: true, proposedDirection: true, withheldReason: null });
  });

  it('withholds it again when there are none, and leaves placed rows alone', () => {
    const row = { ...base, noteChoices: [] };
    settleUnplaced(row);
    expect(row).toMatchObject({
      unplaced: false,
      proposedDirection: false,
      withheldReason: 'far-from-notes'
    });
    const placed = { ...base, unplaced: undefined, noteChoices: [] };
    settleUnplaced(placed);
    expect(placed.proposedDirection).toBe(true);
  });
});
