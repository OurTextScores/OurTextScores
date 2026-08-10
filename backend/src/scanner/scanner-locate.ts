/**
 * Locate a spot horizontally within its staff, so the crop can point at it.
 *
 * A staff crop can hold thirty notes. "Which duration is this?" over the whole
 * line is unanswerable, so the review has to indicate *where* — and the obvious
 * source, the decoder's attention coordinate, is documented by HOMR as
 * unreliable for exactly this purpose.
 *
 * Two sources, best first.
 *
 * The decoder's attention point is note-level, and measurement says it is far
 * better than HOMR's blanket caveat suggests: on a real printed page it was
 * ~98% monotonic in scan order across every staff, with a point for every
 * symbol. HOMR's own comment names the test to apply — patch tokens are
 * processed in raster order, so a coordinate that breaks that order is the
 * unreliable one. So it is used where it passes that check and discarded where
 * it does not, rather than trusted or dismissed wholesale.
 *
 * Where it fails, the token sequence gives a measure: counting `barline`
 * symbols before a spot locates it to within one measure. Coarser, but ordering
 * is exact even though spacing is approximate, so it can never point at the
 * wrong part of the line.
 */

/** The width the staff image is resized to before the model sees it. */
const STAFF_IMAGE_WIDTH = 1280;

/**
 * Half-width of a note-level band, as a fraction of the staff.
 *
 * Wide enough to cover a notehead and its stem at typical engraving sizes, and
 * to absorb the attention point's own imprecision; narrow enough that it picks
 * out one note rather than a run of them.
 */
const NOTE_HALF_WIDTH = 0.025;

const BARLINE_RHYTHMS = new Set(['barline', 'barline_repeat', 'repeat']);

function isBarline(rhythm: string): boolean {
  return BARLINE_RHYTHMS.has(rhythm) || rhythm.startsWith('barline') || rhythm.includes('repeat');
}

export interface SpotBand {
  /** Fraction of the staff width, 0-1. */
  start: number;
  end: number;
  /** How the band was derived, so the UI can be honest about precision. */
  basis: 'note' | 'measure' | 'position';
}

export interface LocatableSymbol {
  index: number;
  attention?: number[] | null;
}

/**
 * Whether an attention point sits in scan order relative to its neighbours.
 *
 * HOMR: "patch tokens are processed in raster order … this ordering can be used
 * to reject cases where attention-based coordinates violate monotonic scan
 * constraints and are therefore unreliable." Neighbours may be missing — the
 * provider prunes confident symbols — but a subsequence of a monotonic sequence
 * is still monotonic, so the surviving ones are a valid check.
 */
export function attentionIsOrdered(
  symbols: LocatableSymbol[] | undefined,
  symbolIndex: number
): boolean {
  if (!symbols || symbols.length === 0) return false;
  const withAttention = symbols
    .filter((symbol) => Array.isArray(symbol.attention) && Number.isFinite(symbol.attention[0]))
    .sort((left, right) => left.index - right.index);
  const position = withAttention.findIndex((symbol) => symbol.index === symbolIndex);
  if (position < 0) return false;
  const x = withAttention[position].attention![0];
  const before = withAttention[position - 1]?.attention?.[0];
  const after = withAttention[position + 1]?.attention?.[0];
  if (before !== undefined && x < before) return false;
  if (after !== undefined && x > after) return false;
  return true;
}

/**
 * The horizontal band a symbol sits in, as fractions of the staff's width.
 *
 * Falls back to the symbol's ordinal position when a staff has no bar lines —
 * a single-measure staff, or one where detection missed them. That is coarser
 * but still monotonic, which is what matters: earlier symbols are always left
 * of later ones.
 */
export function locateSymbol(
  tokens: string[][] | undefined,
  symbolIndex: number,
  symbols?: LocatableSymbol[]
): SpotBand | null {
  if (!tokens || tokens.length === 0) return null;
  if (symbolIndex < 0 || symbolIndex >= tokens.length) return null;

  // Note-level, where the attention point survives its own ordering check.
  const symbol = symbols?.find((entry) => entry.index === symbolIndex);
  const attentionX = symbol?.attention?.[0];
  if (Number.isFinite(attentionX) && attentionIsOrdered(symbols, symbolIndex)) {
    const centre = Math.min(1, Math.max(0, (attentionX as number) / STAFF_IMAGE_WIDTH));
    return {
      start: Math.max(0, centre - NOTE_HALF_WIDTH),
      end: Math.min(1, centre + NOTE_HALF_WIDTH),
      basis: 'note'
    };
  }

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
