export const MAX_LCS_SEQUENCE_LENGTH = 4096;

export type LcsAlignmentOp =
  | { type: 'equal'; baseIndex: number; candidateIndex: number }
  | { type: 'removed'; baseIndex: number }
  | { type: 'added'; candidateIndex: number };

/**
 * Deterministic longest-common-subsequence alignment.
 * On a tie, removal wins to preserve historical change-review output.
 */
export function alignSequenceLcs<T>(
  base: readonly T[],
  candidate: readonly T[],
  equals: (left: T, right: T) => boolean = (left, right) => left === right
): LcsAlignmentOp[] {
  const rows = base.length;
  const cols = candidate.length;
  if (rows > MAX_LCS_SEQUENCE_LENGTH || cols > MAX_LCS_SEQUENCE_LENGTH) {
    throw new Error(`LCS alignment is limited to ${MAX_LCS_SEQUENCE_LENGTH} items per side`);
  }
  const width = cols + 1;
  const lengths = new Uint16Array((rows + 1) * width);
  const at = (row: number, col: number) => row * width + col;
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      lengths[at(row, col)] = equals(base[row], candidate[col])
        ? lengths[at(row + 1, col + 1)] + 1
        : Math.max(lengths[at(row + 1, col)], lengths[at(row, col + 1)]);
    }
  }

  const ops: LcsAlignmentOp[] = [];
  let row = 0;
  let col = 0;
  while (row < rows && col < cols) {
    if (equals(base[row], candidate[col])) {
      ops.push({ type: 'equal', baseIndex: row, candidateIndex: col });
      row += 1;
      col += 1;
    } else if (lengths[at(row + 1, col)] >= lengths[at(row, col + 1)]) {
      ops.push({ type: 'removed', baseIndex: row });
      row += 1;
    } else {
      ops.push({ type: 'added', candidateIndex: col });
      col += 1;
    }
  }
  while (row < rows) ops.push({ type: 'removed', baseIndex: row++ });
  while (col < cols) ops.push({ type: 'added', candidateIndex: col++ });
  return ops;
}
