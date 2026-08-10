/**
 * Locate a spot horizontally within its staff, so the crop can point at it.
 *
 * A staff crop can hold thirty notes. "Which duration is this?" over the whole
 * line is unanswerable, so the review has to indicate *where* — and the obvious
 * source, the decoder's attention coordinate, is documented by HOMR as
 * unreliable for exactly this purpose.
 *
 * The token sequence is a better source. It contains `barline` symbols, so
 * counting the bar lines before a symbol gives the measure it belongs to, and
 * measures within one staff are close enough to evenly spaced for a band to be
 * useful. Ordering is exact even though spacing is approximate, so the band is
 * never in the wrong part of the line the way a mis-attended point can be.
 */

const BARLINE_RHYTHMS = new Set(['barline', 'barline_repeat', 'repeat']);

function isBarline(rhythm: string): boolean {
  return BARLINE_RHYTHMS.has(rhythm) || rhythm.startsWith('barline') || rhythm.includes('repeat');
}

export interface SpotBand {
  /** Fraction of the staff width, 0-1. */
  start: number;
  end: number;
  /** How the band was derived, so the UI can be honest about precision. */
  basis: 'measure' | 'position';
}

/**
 * The horizontal band a symbol sits in, as fractions of the staff's width.
 *
 * Falls back to the symbol's ordinal position when a staff has no bar lines —
 * a single-measure staff, or one where detection missed them. That is coarser
 * but still monotonic, which is what matters: earlier symbols are always left
 * of later ones.
 */
export function locateSymbol(tokens: string[][] | undefined, symbolIndex: number): SpotBand | null {
  if (!tokens || tokens.length === 0) return null;
  if (symbolIndex < 0 || symbolIndex >= tokens.length) return null;

  const barlineIndices: number[] = [];
  tokens.forEach((token, index) => {
    if (isBarline(String(token?.[0] || ''))) barlineIndices.push(index);
  });

  if (barlineIndices.length >= 2) {
    const measures = barlineIndices.length + 1;
    const before = barlineIndices.filter((index) => index < symbolIndex).length;
    // Clamp: a symbol after the final bar line belongs to the last measure.
    const measure = Math.min(before, measures - 1);
    return { start: measure / measures, end: (measure + 1) / measures, basis: 'measure' };
  }

  // No usable bar lines: place the symbol by its position in the sequence and
  // widen the band to admit how rough that is.
  const fraction = symbolIndex / Math.max(1, tokens.length - 1);
  const halfWidth = 0.08;
  return {
    start: Math.max(0, fraction - halfWidth),
    end: Math.min(1, fraction + halfWidth),
    basis: 'position'
  };
}
