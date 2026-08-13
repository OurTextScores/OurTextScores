import { comparisonCropRects, cropForLevel, padAndClamp, staffBandWithinContext } from './scanner-crop';

const IMAGE = { width: 1000, height: 800 };

describe('padAndClamp', () => {
  it('pads a region and keeps it inside the image', () => {
    expect(padAndClamp([100, 100, 300, 200], 10, IMAGE)).toEqual({
      left: 90,
      top: 90,
      width: 220,
      height: 120
    });
  });

  it('clamps at the edges rather than going negative', () => {
    const rect = padAndClamp([0, 0, 50, 50], 20, IMAGE);
    expect(rect.left).toBe(0);
    expect(rect.top).toBe(0);
  });

  it('never yields a zero-sized rectangle', () => {
    // sharp throws on a zero extent, and a degenerate region should not turn
    // into a 500 on a page that otherwise recognised fine.
    const rect = padAndClamp([500, 500, 500, 500], 0, IMAGE);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  });

  it('tolerates a region given with reversed corners', () => {
    expect(padAndClamp([300, 200, 100, 100], 0, IMAGE)).toEqual({
      left: 100,
      top: 100,
      width: 200,
      height: 100
    });
  });
});

describe('cropForLevel', () => {
  it('crops to the staff region with a little air', () => {
    const rect = cropForLevel('staff', [178, 341, 811, 537], IMAGE);
    expect(rect.left).toBe(166);
    expect(rect.width).toBe(657);
  });

  it('grows only downwards and upwards for context', () => {
    // The band is positioned as a fraction of the crop's width, so widening
    // would silently move the highlight off the symbol. Holding x fixed means
    // one band position is correct at both levels.
    const staff = [178, 341, 811, 537];
    const above = [178, 120, 811, 300];
    const below = [178, 580, 811, 760];
    const base = cropForLevel('staff', staff, IMAGE);
    const context = cropForLevel('context', staff, IMAGE, [above, below]);

    expect(context.left).toBe(base.left);
    expect(context.width).toBe(base.width);
    expect(context.top).toBeLessThan(base.top);
    expect(context.top + context.height).toBeGreaterThan(base.top + base.height);
  });

  it('is the staff itself when there are no neighbours', () => {
    const staff = [178, 341, 811, 537];
    expect(cropForLevel('context', staff, IMAGE, [])).toEqual(cropForLevel('staff', staff, IMAGE));
  });

  it('does not run past the image for an edge staff', () => {
    const staff = [10, 10, 500, 90];
    const below = [10, 700, 500, 795];
    const context = cropForLevel('context', staff, IMAGE, [below]);
    expect(context.top).toBeGreaterThanOrEqual(0);
    expect(context.top + context.height).toBeLessThanOrEqual(IMAGE.height);
  });

  it('falls back to the whole page when geometry is missing', () => {
    // A provider that returned no region must degrade to something viewable
    // rather than failing the request.
    expect(cropForLevel('staff', null, IMAGE).width).toBe(1000);
    expect(cropForLevel('staff', [1, 2], IMAGE).width).toBe(1000);
  });
});

describe('comparisonCropRects', () => {
  it('unions adjacent measures on one system and keeps systems separate', () => {
    expect(
      comparisonCropRects(
        [
          { systemIndex: 1, region: [100, 300, 500, 380] },
          { systemIndex: 0, region: [100, 100, 300, 180] },
          { systemIndex: 0, region: [300, 100, 500, 180] }
        ],
        { width: 800, height: 600 },
        0
      )
    ).toEqual([
      { left: 100, top: 100, width: 400, height: 80 },
      { left: 100, top: 300, width: 400, height: 80 }
    ]);
  });

  it('ignores malformed regions and clamps valid evidence to the image', () => {
    expect(
      comparisonCropRects(
        [
          { systemIndex: -1, region: [0, 0, 10, 10] },
          { systemIndex: 0, region: [-5, -5, 105, 55] }
        ],
        { width: 100, height: 50 },
        0
      )
    ).toEqual([{ left: 0, top: 0, width: 100, height: 50 }]);
  });
});

describe('staffBandWithinContext', () => {
  const image = { width: 1000, height: 1000 };

  it('gives the staff its own slice of a crop that holds its neighbours', () => {
    // The complaint this fixes: at context zoom the highlight covered all three
    // staves, pointing at a system to ask about a symbol on one line of it.
    const staff = [100, 400, 900, 460];
    const above = [100, 200, 900, 260];
    const below = [100, 600, 900, 660];
    const band = staffBandWithinContext(staff, image, [above, below]);

    expect(band).not.toBeNull();
    // The staff sits in the middle of the crop, not filling it.
    expect(band!.top).toBeGreaterThan(0.2);
    expect(band!.top + band!.height).toBeLessThan(0.8);
  });

  it('fills the crop when there are no neighbours to make room for', () => {
    const band = staffBandWithinContext([100, 400, 900, 460], image, []);

    expect(band!.top).toBeCloseTo(0, 5);
    expect(band!.height).toBeCloseTo(1, 5);
  });

  it('says nothing when the staff has no region', () => {
    expect(staffBandWithinContext(null, image, [])).toBeNull();
    expect(staffBandWithinContext([1, 2, 3], image, [])).toBeNull();
  });
});
