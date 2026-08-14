export const SCANNER_MERGED_MEASURE_MAP_VERSION = 'scanner-merged-measure-map-v1';

/**
 * Where each bar of the merged score came from in the engine it follows.
 *
 * `map[i]` is the source engine's measure index for merged bar `i`, or `null`
 * for a bar inserted from the other reading, which has no counterpart there.
 *
 * It exists because the two numberings drift apart the moment a bar is added or
 * removed. Every decision names its passage by the *engine's* index — that is
 * what the comparison computed and what the reviewer was shown — while the
 * splice has to act on the *merged* document. Without a map the two coincide
 * only until the first structural change, after which a take lands on the wrong
 * bar and looks like it worked.
 */
export type ScannerMergedMeasureMap = Array<number | null>;

/** Before any structural change the two numberings are the same. */
export const identityMeasureMap = (measureCount: number): ScannerMergedMeasureMap =>
  Array.from({ length: Math.max(0, measureCount) }, (_value, index) => index);

/**
 * Merged positions for a passage named by engine measure index.
 *
 * Returns null when any of them is gone — a bar the reviewer already deleted
 * cannot now be taken, and saying so is better than silently acting on a
 * neighbour.
 */
export function resolveMergedIndexes(
  map: ScannerMergedMeasureMap,
  sourceIndexes: readonly number[]
): number[] | null {
  const resolved: number[] = [];
  for (const sourceIndex of sourceIndexes) {
    const position = map.indexOf(sourceIndex);
    if (position < 0) return null;
    resolved.push(position);
  }
  return resolved;
}

/**
 * The merged position an insertion goes after.
 *
 * `-1` means the start of the part, and stays `-1`. Otherwise the anchor is an
 * engine measure index, which has to be translated like any other; if the bar
 * it names has been deleted there is nowhere to anchor to.
 */
export function resolveMergedAnchor(
  map: ScannerMergedMeasureMap,
  sourceAnchorIndex: number
): number | null {
  if (sourceAnchorIndex < 0) return -1;
  const position = map.indexOf(sourceAnchorIndex);
  return position < 0 ? null : position;
}

/**
 * The map after bars were inserted at `afterPosition`.
 *
 * Inserted bars map to `null`: they exist in the merged score and nowhere in
 * the engine it follows, so no engine index can name them. A later decision
 * about *them* would have to come from the other engine, which addresses its
 * own numbering and is why structural takes still come last.
 */
export const withInsertedMeasures = (
  map: ScannerMergedMeasureMap,
  afterPosition: number,
  count: number
): ScannerMergedMeasureMap => {
  const next = [...map];
  next.splice(afterPosition + 1, 0, ...Array.from({ length: count }, () => null));
  return next;
};

/** The map after the bars at these merged positions were removed. */
export const withRemovedMeasures = (
  map: ScannerMergedMeasureMap,
  positions: readonly number[]
): ScannerMergedMeasureMap => {
  const doomed = new Set(positions);
  return map.filter((_value, index) => !doomed.has(index));
};

/**
 * The map after a passage was replaced by one of a different length.
 *
 * A take that swaps N bars for M is not covered by insertion or removal alone,
 * and treating it as neither leaves the map claiming a length the document no
 * longer has: every bar after the passage then resolves one place out, and the
 * next take lands on the wrong bar while reporting success. That is the exact
 * failure this map exists to prevent, so a replacement has to move it too.
 *
 * The new bars map to `null`. They came from the other reading and have no
 * counterpart in the engine this score follows — the same thing an insertion
 * means, because that is what a replacement is once the old bars are gone.
 */
export const withReplacedMeasures = (
  map: ScannerMergedMeasureMap,
  positions: readonly number[],
  count: number
): ScannerMergedMeasureMap => {
  if (positions.length === 0) return map;
  const first = Math.min(...positions);
  const removed = withRemovedMeasures(map, positions);
  return withInsertedMeasures(removed, first - 1, count);
};

/**
 * Which reading a block's notes currently come from.
 *
 * The merged score starts as a copy of one engine, so every block reads from
 * that engine until a decision moves it, and the last decision on a block is
 * the one in force. A markings take does not move it: taking dynamics leaves
 * the notes where they were.
 *
 * The server needs this for the same reason the client does. Comparing against
 * the engine the *document* started from instead made a take irreversible —
 * once a bar had been taken from the other reading there was no way to take it
 * back, because the origin engine was refused forever after with "the merged
 * score already reads this passage the way that engine does" while the bar on
 * screen plainly said otherwise.
 */
export function mergedBlockReadsFrom(
  blockIndex: number,
  sourceEngineId: string,
  decisions: ReadonlyArray<{
    blockIndex?: number;
    engineId?: string;
    markingsOnly?: 'dynamics' | 'lyrics';
  }> | undefined
): string {
  let current = sourceEngineId;
  for (const decision of decisions || []) {
    if (decision.blockIndex !== blockIndex || decision.markingsOnly) continue;
    if (decision.engineId) current = decision.engineId;
  }
  return current;
}
