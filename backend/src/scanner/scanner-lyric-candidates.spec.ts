import {
  buildLyricCandidateInventory,
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
