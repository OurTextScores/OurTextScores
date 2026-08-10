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
}

export const DEFAULT_REVIEW_THRESHOLDS: ReviewThresholds = {
  floor: 0.8,
  lowImpactFloor: 0.5,
  // A ratio, not an absolute gap: an absolute margin is unsatisfiable at higher
  // confidences, since at 0.72 the runner-up cannot exceed 0.28.
  minAlternativeRatio: 0.25
};

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
        const alternatives = entry.alternatives || [];
        if (alternatives.length === 0) continue;
        const runnerUp = Number(alternatives[0]?.confidence ?? 0);
        if (runnerUp < confidence * thresholds.minAlternativeRatio) continue;
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
