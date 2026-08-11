import { alignSequenceLcs, MAX_LCS_SEQUENCE_LENGTH } from './sequence-alignment';

describe('alignSequenceLcs', () => {
  it('localizes additions and removals without shifting later matches', () => {
    expect(alignSequenceLcs(['a', 'b', 'c'], ['a', 'x', 'b'])).toEqual([
      { type: 'equal', baseIndex: 0, candidateIndex: 0 },
      { type: 'added', candidateIndex: 1 },
      { type: 'equal', baseIndex: 1, candidateIndex: 2 },
      { type: 'removed', baseIndex: 2 }
    ]);
  });

  it('preserves removal-first tie breaking', () => {
    expect(alignSequenceLcs(['a'], ['b'])).toEqual([
      { type: 'removed', baseIndex: 0 },
      { type: 'added', candidateIndex: 0 }
    ]);
  });

  it('bounds its quadratic table', () => {
    const tooMany = Array.from({ length: MAX_LCS_SEQUENCE_LENGTH + 1 }, () => 'x');
    expect(() => alignSequenceLcs(tooMany, [])).toThrow(/limited to 4096 items/);
  });
});
