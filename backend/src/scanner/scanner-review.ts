/**
 * Design section 4: choose and rank the spots worth asking a reviewer about.
 *
 * Two decisions, deliberately separate:
 *
 * - **Filtering** decides what is worth a question at all, and musical impact
 *   belongs here. A doubtful slur matters less than a doubtful pitch, so a
 *   low-impact head has to be considerably more uncertain to qualify.
 * - **Ranking** is strictly by ascending confidence, least certain first, and
 *   impact is deliberately absent from it. The queue is open-ended, and its
 *   whole value is that the reviewer can be told:
 *
 *       19 spots left, all at least 84% confident.
 *
 *   That is only true, and only checkable, if the queue is monotonic in
 *   confidence. A weighted ordering would buy marginally better expected value
 *   per question and lose the ability to say anything honest about what is left.
 *
 * This lives in the backend rather than the provider so the thresholds can be
 * retuned against real reviewer behaviour without re-scanning pages through a
 * GPU. The provider only prunes for payload size.
 */

export interface ReviewHead {
  chosen: string;
  confidence: number;
  alternatives: Array<{ value: string; confidence: number }>;
}

export interface ReviewSymbol {
  index: number;
  rhythm?: string;
  heads: Record<string, ReviewHead>;
  attention?: number[] | null;
}

export interface ReviewStaff {
  index: number;
  region?: number[] | null;
  /** The full decoded sequence, six fields per symbol. */
  tokens?: string[][];
  barLines?: number[];
  symbols: ReviewSymbol[];
}

export interface ReviewSpot {
  staffIndex: number;
  symbolIndex: number;
  head: string;
  chosen: string;
  confidence: number;
  alternatives: Array<{ value: string; confidence: number }>;
  attention?: number[] | null;
}

export interface ReviewThresholds {
  floor: number;
  lowImpactFloor: number;
  minAlternativeRatio: number;
  /**
   * Below this, do not ask at all.
   *
   * A choice between 11% and 10% is not the model proposing an alternative, it
   * is the model shrugging: neither option is likely correct, so the question
   * is noise dressed as a decision. This matters more than it looks, because
   * ascending order puts exactly these spots first — without a lower bound the
   * queue opens with its least useful questions.
   */
  minimum: number;
}

export const DEFAULT_REVIEW_THRESHOLDS: ReviewThresholds = {
  floor: 0.8,
  lowImpactFloor: 0.5,
  // A ratio, not an absolute gap: an absolute margin is unsatisfiable at higher
  // confidences, since at 0.72 the runner-up cannot exceed 0.28.
  minAlternativeRatio: 0.25,
  minimum: 0.35
};

/**
 * Above this share of symbols being askable, the page is past what recognition
 * can do reliably and should be labelled as such.
 *
 * A signal, never a gate: the reviewer may still work the queue. What it
 * prevents is presenting hundreds of questions with no comment, which implies
 * the page is nearly right when it is not.
 */
export const UNSUITABLE_ASKABLE_RATIO = 0.2;

/**
 * The highest confidence that can ever qualify, given the ratio rule.
 *
 * Probabilities sum to one, so the runner-up is at most `1 - chosen`. Requiring
 * `runnerUp >= chosen * ratio` therefore implies `chosen <= 1 / (1 + ratio)` —
 * 0.8 at the default ratio. This is inherent, not a bug: a prediction the model
 * is very sure about cannot also have a competitive alternative.
 *
 * It matters for tuning. Raising `floor` above this ceiling has **no effect**,
 * because the ratio rule excludes everything above it anyway. To ask about more
 * confident predictions, lower `minAlternativeRatio` as well — that is what
 * moves the ceiling.
 */
export function effectiveCeiling(thresholds: ReviewThresholds): number {
  return 1 / (1 + thresholds.minAlternativeRatio);
}

/** Heads a reviewer can actually judge from a crop of the score. */
const ASKABLE_HEADS = ['pitch', 'rhythm', 'lift', 'articulation', 'slur'] as const;

/** Decoration by comparison: these must be more doubtful to be worth asking. */
const LOW_IMPACT_HEADS = new Set(['slur', 'articulation']);

/**
 * HOMR's placeholders: `.` is "no note" and `_` is "no decoration".
 *
 * A question whose every option is a placeholder — "Which note is this? `.` 37%
 * or `_` 31%" — asks a reviewer to choose between two ways of saying nothing.
 * Seen on a real printed page, so it is filtered rather than left to the UI.
 */
const PLACEHOLDER_VALUES = new Set(['.', '_', '']);

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_VALUES.has(value);
}

export function floorFor(head: string, thresholds: ReviewThresholds): number {
  return LOW_IMPACT_HEADS.has(head)
    ? Math.min(thresholds.floor, thresholds.lowImpactFloor)
    : thresholds.floor;
}

export function selectSpots(
  staves: ReviewStaff[],
  thresholds: ReviewThresholds = DEFAULT_REVIEW_THRESHOLDS
): ReviewSpot[] {
  const spots: ReviewSpot[] = [];
  for (const staff of staves || []) {
    for (const symbol of staff.symbols || []) {
      for (const head of ASKABLE_HEADS) {
        const entry = symbol.heads?.[head];
        if (!entry) continue;
        const confidence = Number(entry.confidence);
        if (!Number.isFinite(confidence)) continue;
        if (confidence >= floorFor(head, thresholds)) continue;
        if (confidence < thresholds.minimum) continue;
        const alternatives = entry.alternatives || [];
        if (alternatives.length === 0) continue;
        const runnerUp = Number(alternatives[0]?.confidence ?? 0);
        if (runnerUp < confidence * thresholds.minAlternativeRatio) continue;
        // At least one option has to mean something.
        const options = [entry.chosen, ...alternatives.map((item) => item.value)];
        if (options.every(isPlaceholder)) continue;
        spots.push({
          staffIndex: staff.index,
          symbolIndex: symbol.index,
          head,
          chosen: entry.chosen,
          confidence,
          alternatives,
          attention: symbol.attention ?? null
        });
      }
    }
  }
  // Ties broken by position so the queue is stable across identical scans, and
  // so a reviewer returning to a page sees the same order.
  spots.sort(
    (left, right) =>
      left.confidence - right.confidence ||
      left.staffIndex - right.staffIndex ||
      left.symbolIndex - right.symbolIndex
  );
  return spots;
}

/**
 * Confidence of the least certain spot still unanswered — the number behind
 * "N left, all at least X% confident".
 *
 * Because the queue is sorted ascending this is simply the next one, and it
 * rises as the reviewer works. That is what turns stopping into a judgement
 * about the remainder rather than an admission of fatigue.
 */
export function remainingFloor(spots: ReviewSpot[], answered: number): number | null {
  if (answered >= spots.length) return null;
  return spots[answered].confidence;
}

/**
 * Whether a page is past reliable recognition, and the evidence for saying so.
 *
 * `askableRatio` counts spots against symbols the provider kept, so it reflects
 * how much of what the model was unsure about is actually worth asking. On a
 * clean printed page this is near zero; on out-of-scope input it approaches one.
 */
export function pageSuitability(
  staves: ReviewStaff[],
  spots: ReviewSpot[]
): { symbols: number; spots: number; askableRatio: number; unsuitable: boolean } {
  const symbols = (staves || []).reduce(
    (total, staff) => total + (staff.symbols?.length || 0),
    0
  );
  const askableRatio = symbols === 0 ? 0 : spots.length / symbols;
  return {
    symbols,
    spots: spots.length,
    askableRatio,
    unsuitable: askableRatio > UNSUITABLE_ASKABLE_RATIO
  };
}
