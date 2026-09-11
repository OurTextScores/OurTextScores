import { findingCrop, findingSystems, FindingStaff } from './scanner-finding-crop';

/**
 * The raster and staves below are the real ones from job `cc2ce56d` (quartet profile,
 * presto4) - the page that produced 17 findings and is also the Phase 7 defect. Real
 * numbers rather than tidy invented ones, because two of the properties that matter here
 * only appear in the real data: the staff regions run outside the raster on every side
 * (x from -12 to 1009 on a 1007px page), and HOMR reported eleven one-staff "systems"
 * where the page has a handful of four-staff ones.
 */
const RASTER = { width: 1007, height: 1849 };

const REAL_STAVES: FindingStaff[] = [
  { index: 0, systemIndex: 0, partIndex: 0, region: [17, 26, 990, 178] },
  { index: 1, systemIndex: 1, partIndex: 0, region: [12, 131, 990, 279] },
  { index: 2, systemIndex: 2, partIndex: 0, region: [12, 232, 989, 381] },
  { index: 3, systemIndex: 3, partIndex: 0, region: [-7, 333, 1009, 631] },
  { index: 4, systemIndex: 4, partIndex: 0, region: [12, 585, 989, 734] },
  { index: 5, systemIndex: 5, partIndex: 0, region: [-2, 689, 993, 955] },
  { index: 6, systemIndex: 6, partIndex: 0, region: [-4, 914, 995, 1205] },
  { index: 7, systemIndex: 7, partIndex: 0, region: [-12, 1147, 993, 1429] },
  { index: 8, systemIndex: 8, partIndex: 0, region: [1, 1401, 979, 1542] },
  { index: 9, systemIndex: 9, partIndex: 0, region: [-4, 1506, 979, 1647] },
  { index: 10, systemIndex: 10, partIndex: 0, region: [-10, 1597, 985, 1865] }
];

/** A healthy four-staff system, which the defective page does not contain. */
const QUARTET: FindingStaff[] = [
  { index: 0, systemIndex: 0, partIndex: 0, region: [50, 100, 950, 200] },
  { index: 1, systemIndex: 0, partIndex: 1, region: [50, 210, 950, 310] },
  { index: 2, systemIndex: 0, partIndex: 2, region: [50, 320, 950, 420] },
  { index: 3, systemIndex: 0, partIndex: 3, region: [50, 430, 950, 530] },
  { index: 4, systemIndex: 1, partIndex: 0, region: [50, 600, 950, 700] }
];

describe('findingCrop against the real job that motivated it', () => {
  it('resolves every system index the real findings referenced', () => {
    // All 17 findings on that page carried system 0..10, and none dangled.
    for (let system = 0; system <= 10; system++) {
      const crop = findingCrop({ kind: 'profile_layout_deviation', system }, REAL_STAVES, RASTER);
      expect(crop.reason).toBeUndefined();
      expect(crop.level).toBe('system');
      expect(crop.staffIndexes).toEqual([system]);
    }
  });

  it('clamps regions that run outside the raster on every side', () => {
    // Staff 7 is the worst case: x runs -12..993 on a 1007px page. The left edge clamps
    // to 0 (it would otherwise be -24 after padding); the right edge pads to 1005 and so
    // stays inside without clamping. Both directions, one case.
    const crop = findingCrop({ kind: 'dangling_slur_stop', system: 7 }, REAL_STAVES, RASTER);
    expect(crop.rect).toEqual({ left: 0, top: 1135, width: 1005, height: 306 });
  });

  it('clamps the right edge when padding would cross it', () => {
    // Staff 3 reaches x=1009, already past the 1007px page before any padding.
    const crop = findingCrop({ kind: 'profile_layout_deviation', system: 3 }, REAL_STAVES, RASTER);
    expect(crop.rect!.left + crop.rect!.width).toBe(1007);
  });

  it('clamps the bottom edge of the last system', () => {
    // Region bottom is 1865 on an 1849-tall page; padding must not push it further.
    const crop = findingCrop({ kind: 'profile_layout_deviation', system: 10 }, REAL_STAVES, RASTER);
    expect(crop.rect!.top + crop.rect!.height).toBe(1849);
  });

  it('reproduces the real slur findings, which band a single-staff system', () => {
    // Six findings carried staffIndices, every one of them [0] - because HOMR had split
    // the page into one-staff systems. The band is then the system.
    const crop = findingCrop(
      { kind: 'dangling_slur_start', system: 2, staffIndices: [0] },
      REAL_STAVES,
      RASTER
    );
    expect(crop.level).toBe('staff');
    expect(crop.staffIndexes).toEqual([2]);
    expect(crop.reason).toBeUndefined();
  });
});

describe('staff-level banding', () => {
  it('bands only the implicated staves inside a four-staff system', () => {
    const crop = findingCrop(
      { kind: 'clef_profile_mismatch', system: 0, staffIndices: [3], part: 'cello' },
      QUARTET,
      RASTER
    );
    expect(crop.level).toBe('staff');
    expect(crop.staffIndexes).toEqual([3]);
    // The cello staff alone, not the whole system.
    expect(crop.rect).toEqual({ left: 38, top: 418, width: 924, height: 124 });
  });

  it('spans a contiguous range when several staves are implicated', () => {
    const crop = findingCrop(
      { kind: 'time_signature_mismatch', system: 0, staffIndices: [1, 2] },
      QUARTET,
      RASTER
    );
    expect(crop.staffIndexes).toEqual([1, 2]);
    expect(crop.rect).toEqual({ left: 38, top: 198, width: 924, height: 234 });
  });

  it('treats staffIndices as positions within the system, not page-wide staff numbers', () => {
    // Position 0 of system 1 is page-wide staff 4. Reading it as a page-wide index would
    // return staff 0 - a different system entirely, and a plausible-looking wrong crop.
    const crop = findingCrop(
      { kind: 'dangling_slur_start', system: 1, staffIndices: [0] },
      QUARTET,
      RASTER
    );
    expect(crop.staffIndexes).toEqual([4]);
    expect(crop.rect!.top).toBeGreaterThan(500);
  });

  it('falls back to the whole system when a position does not resolve', () => {
    // Coarse but correct beats banding somewhere arbitrary.
    const crop = findingCrop(
      { kind: 'time_signature_mismatch', system: 0, staffIndices: [0, 9] },
      QUARTET,
      RASTER
    );
    expect(crop.level).toBe('system');
    expect(crop.reason).toBe('staff-index-out-of-range');
    expect(crop.staffIndexes).toEqual([0, 1, 2, 3]);
  });
});

describe('refusing rather than guessing', () => {
  it('refuses a system that has no staves', () => {
    const crop = findingCrop({ kind: 'measure_count_mismatch', system: 99 }, QUARTET, RASTER);
    expect(crop).toEqual({ level: 'none', staffIndexes: [], reason: 'unknown-system' });
  });

  it('refuses a page-level finding rather than inventing a system', () => {
    // `page_staff_count_mismatch` and `part_order_mismatch` are raised with staffIndices
    // and no system at all; they are not croppable and must not be forced into a frame.
    const crop = findingCrop(
      { kind: 'page_staff_count_mismatch', staffIndices: [0, 1] },
      QUARTET,
      RASTER
    );
    expect(crop).toEqual({ level: 'none', staffIndexes: [], reason: 'page-level' });
  });

  it('ignores staves whose region is malformed rather than cropping to NaN', () => {
    const broken: FindingStaff[] = [
      { index: 0, systemIndex: 0, region: [Number.NaN, 1, 2, 3] },
      { index: 1, systemIndex: 0, region: [10, 20] }
    ];
    expect(findingCrop({ kind: 'x', system: 0 }, broken, RASTER).reason).toBe('unknown-system');
  });

  it('survives an empty staff list', () => {
    expect(findingCrop({ kind: 'x', system: 0 }, [], RASTER).reason).toBe('unknown-system');
  });
});

describe('findingSystems', () => {
  it('groups the real defect page into the eleven systems HOMR reported', () => {
    // Not four systems of four. The crop must show what HOMR called a system, because
    // that is the evidence a reviewer needs to see the grouping is wrong.
    const systems = findingSystems(REAL_STAVES, RASTER);
    expect(systems).toHaveLength(11);
    expect(systems.map((system) => system.staffIndexes)).toEqual(
      Array.from({ length: 11 }, (_, index) => [index]),
    );
  });

  it('unions a healthy four-staff system into one strip', () => {
    const systems = findingSystems(QUARTET, RASTER);
    expect(systems).toHaveLength(2);
    expect(systems[0].staffIndexes).toEqual([0, 1, 2, 3]);
    expect(systems[0].region).toEqual([50, 100, 950, 530]);
  });

  it('clamps the crop rectangle to the raster', () => {
    const systems = findingSystems(REAL_STAVES, RASTER);
    for (const system of systems) {
      expect(system.cropRegion[0]).toBeGreaterThanOrEqual(0);
      expect(system.cropRegion[1]).toBeGreaterThanOrEqual(0);
      expect(system.cropRegion[2]).toBeLessThanOrEqual(RASTER.width);
      expect(system.cropRegion[3]).toBeLessThanOrEqual(RASTER.height);
    }
  });

  it('agrees with findingCrop on the same system', () => {
    // Both read the same staff geometry, so a finding's system addresses this list by
    // construction. A divergence would put the strip and the crop in different places.
    const systems = findingSystems(QUARTET, RASTER);
    const crop = findingCrop({ kind: 'x', system: 0 }, QUARTET, RASTER);
    expect(systems[0].cropRegion).toEqual([
      crop.rect!.left,
      crop.rect!.top,
      crop.rect!.left + crop.rect!.width,
      crop.rect!.top + crop.rect!.height,
    ]);
  });

  it('leaves measure indexes empty, because no geometry manifest exists here', () => {
    // A findings review has one engine; the measure-geometry manifest is derived during
    // a comparison and needs part matching between two. Inventing a self-matched one
    // would re-derive the comparison pipeline against itself.
    for (const system of findingSystems(QUARTET, RASTER)) {
      expect(system.leftMeasureIndexes).toEqual([]);
      expect(system.rightMeasureIndexes).toEqual([]);
    }
  });

  it('orders systems down the page and staves down the system', () => {
    const shuffled = [QUARTET[3], QUARTET[4], QUARTET[0], QUARTET[2], QUARTET[1]];
    const systems = findingSystems(shuffled, RASTER);
    expect(systems.map((system) => system.systemIndex)).toEqual([0, 1]);
    expect(systems[0].staffIndexes).toEqual([0, 1, 2, 3]);
  });

  it('ignores malformed staves rather than cropping to NaN', () => {
    const systems = findingSystems(
      [...QUARTET, { index: 9, systemIndex: 5, region: [Number.NaN, 0, 1, 1] }],
      RASTER,
    );
    expect(systems.map((system) => system.systemIndex)).toEqual([0, 1]);
  });

  it('survives an empty staff list', () => {
    expect(findingSystems([], RASTER)).toEqual([]);
  });
});
