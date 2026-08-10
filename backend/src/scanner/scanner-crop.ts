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

export type CropLevel = 'staff' | 'page';

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
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
 * `staff` is the staff's own region, which `_calculate_region` already extends
 * to the staves above and below — so it is the design's "surrounding bars and
 * staves" view, not a bare five-line strip.
 *
 * A measure-level crop is not offered yet: it needs bar-line positions in page
 * coordinates, and those are not available at the point where the provider
 * captures staff geometry. Until they are, `staff` is the tightest rectangle
 * that can be guaranteed correct.
 */
export function cropForLevel(
  level: CropLevel,
  staffRegion: number[] | null | undefined,
  image: { width: number; height: number }
): CropRect {
  if (level === 'page' || !staffRegion || staffRegion.length !== 4) {
    return { left: 0, top: 0, width: image.width, height: image.height };
  }
  // A little air around the staff so the symbol is not flush against an edge.
  return padAndClamp(staffRegion, 12, image);
}
