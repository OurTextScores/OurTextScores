import { cropForLevel, padAndClamp } from './scanner-crop';

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
    expect(cropForLevel('context', staff, IMAGE, [])).toEqual(
      cropForLevel('staff', staff, IMAGE)
    );
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
