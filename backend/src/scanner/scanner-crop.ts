/**
 * Crop geometry for the per-page review (design section 6).
 *
 * Every rectangle here comes from segmentation, never from the decoder's
 * attention. HOMR is explicit that attention coordinates are "inherently
 * imprecise, since the model is optimized for predictive accuracy rather than
 * spatial localization", and a tight box confidently in the wrong place is
 * worse than a generous one in the right place.
 *
 * Pointing *within* a crop is `scanner-locate.ts`, which derives a band from
 * bar lines in the token sequence — ordering is exact even where spacing is
 * approximate, so a band cannot land in the wrong part of the line.
 */

export type CropLevel = 'staff' | 'context';

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ComparisonCropRegion {
  systemIndex: number;
  region: [number, number, number, number];
}

/** Grow a region by a margin, then clamp it to the image. */
export function padAndClamp(
  region: number[],
  padding: number,
  image: { width: number; height: number }
): CropRect {
  const [x0, y0, x1, y1] = region;
  const left = Math.max(0, Math.floor(Math.min(x0, x1) - padding));
  const top = Math.max(0, Math.floor(Math.min(y0, y1) - padding));
  const right = Math.min(image.width, Math.ceil(Math.max(x0, x1) + padding));
  const bottom = Math.min(image.height, Math.ceil(Math.max(y0, y1) + padding));
  return {
    left,
    top,
    // A degenerate region must still yield an extractable rectangle: sharp
    // throws on a zero width or height, and a bad crop should not turn into a
    // 500 on a page that otherwise recognised fine.
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

/**
 * The rectangle to extract for a spot at a given zoom level.
 *
 * `context` keeps the *same horizontal extent* as `staff` and only grows
 * vertically, into the staves above and below. That is deliberate: the
 * highlight is positioned as a fraction of the crop's width, so a wider crop
 * would silently move it off the symbol. Holding x fixed means one band
 * position is correct at both levels.
 *
 * A whole-page view was the earlier behaviour and was not useful — the staff
 * becomes a thin strip and the symbol is invisible.
 */
export function cropForLevel(
  level: CropLevel,
  staffRegion: number[] | null | undefined,
  image: { width: number; height: number },
  neighbourRegions: Array<number[] | null | undefined> = []
): CropRect {
  if (!staffRegion || staffRegion.length !== 4) {
    return { left: 0, top: 0, width: image.width, height: image.height };
  }
  // A little air around the staff so the symbol is not flush against an edge.
  const base = padAndClamp(staffRegion, 12, image);
  if (level === 'staff') return base;

  let top = base.top;
  let bottom = base.top + base.height;
  for (const region of neighbourRegions) {
    if (!region || region.length !== 4) continue;
    top = Math.min(top, Math.max(0, Math.floor(Math.min(region[1], region[3]) - 12)));
    bottom = Math.max(
      bottom,
      Math.min(image.height, Math.ceil(Math.max(region[1], region[3]) + 12))
    );
  }
  // Horizontal extent is untouched, so the band stays aligned.
  return { left: base.left, top, width: base.width, height: Math.max(1, bottom - top) };
}

/**
 * Where the staff itself sits inside the context crop, as fractions 0-1.
 *
 * The context crop deliberately holds the staves above and below, so a
 * highlight drawn over its full height points at three staves to ask about a
 * symbol on one. This is what lets the band cover only the staff it is about
 * while the reader still sees the system around it.
 */
export function staffBandWithinContext(
  staffRegion: number[] | null | undefined,
  image: { width: number; height: number },
  neighbourRegions: Array<number[] | null | undefined> = []
): { top: number; height: number } | null {
  if (!staffRegion || staffRegion.length !== 4) return null;
  const staff = padAndClamp(staffRegion, 12, image);
  const context = cropForLevel('context', staffRegion, image, neighbourRegions);
  if (context.height <= 0) return null;
  const top = (staff.top - context.top) / context.height;
  const height = staff.height / context.height;
  const clamped = Math.min(1, Math.max(0, top));
  return { top: clamped, height: Math.min(1 - clamped, Math.max(0.02, height)) };
}

/** Merge consecutive measure boxes into one padded crop per physical system. */
export function comparisonCropRects(
  regions: ComparisonCropRegion[],
  image: { width: number; height: number },
  padding = 12
): CropRect[] {
  const systems = new Map<number, [number, number, number, number]>();
  for (const crop of regions) {
    if (
      !Number.isInteger(crop?.systemIndex) ||
      crop.systemIndex < 0 ||
      !Array.isArray(crop.region) ||
      crop.region.length !== 4 ||
      crop.region.some((coordinate) => !Number.isFinite(coordinate))
    ) {
      continue;
    }
    const [x0, y0, x1, y1] = crop.region;
    const normalized: [number, number, number, number] = [
      Math.min(x0, x1),
      Math.min(y0, y1),
      Math.max(x0, x1),
      Math.max(y0, y1)
    ];
    const current = systems.get(crop.systemIndex);
    systems.set(
      crop.systemIndex,
      current
        ? [
            Math.min(current[0], normalized[0]),
            Math.min(current[1], normalized[1]),
            Math.max(current[2], normalized[2]),
            Math.max(current[3], normalized[3])
          ]
        : normalized
    );
  }
  return [...systems.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, region]) => padAndClamp(region, padding, image));
}
