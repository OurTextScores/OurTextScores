import {
  identityMeasureMap,
  resolveMergedAnchor,
  resolveMergedIndexes,
  withInsertedMeasures,
  withRemovedMeasures,
  withReplacedMeasures,
  mergedBlockReadsFrom,
  editedMeasuresAfterSplice
} from './scanner-merged-measure-map';

/**
 * The two numberings drift apart at the first structural change. Every case
 * here is one a reviewer reaches by doing ordinary things in an order nobody
 * told them was special.
 */
describe('merged measure map', () => {
  it('starts as the identity, because nothing has moved yet', () => {
    expect(identityMeasureMap(3)).toEqual([0, 1, 2]);
    expect(resolveMergedIndexes(identityMeasureMap(3), [1, 2])).toEqual([1, 2]);
  });

  it('shifts everything after an insertion', () => {
    // Insert one bar after merged position 0. The engine's bar 1 is now the
    // merged score's bar 2, and a decision naming it must land there.
    const map = withInsertedMeasures(identityMeasureMap(3), 0, 1);

    expect(map).toEqual([0, null, 1, 2]);
    expect(resolveMergedIndexes(map, [1])).toEqual([2]);
    expect(resolveMergedIndexes(map, [2])).toEqual([3]);
  });

  it('shifts everything after a deletion', () => {
    const map = withRemovedMeasures(identityMeasureMap(4), [1]);

    expect(map).toEqual([0, 2, 3]);
    // The engine still calls it bar 2; the merged score now keeps it at 1.
    expect(resolveMergedIndexes(map, [2])).toEqual([1]);
  });

  it('refuses to locate a bar the reviewer already deleted', () => {
    // Silently acting on a neighbour is the failure this whole map exists to
    // prevent, so the answer is nothing rather than something plausible.
    const map = withRemovedMeasures(identityMeasureMap(4), [1]);

    expect(resolveMergedIndexes(map, [1])).toBeNull();
    expect(resolveMergedIndexes(map, [0, 1])).toBeNull();
  });

  it('keeps an inserted bar unnameable by engine index', () => {
    // It exists in the merged score and nowhere in the engine it follows, so no
    // engine index should resolve to it.
    const map = withInsertedMeasures(identityMeasureMap(2), 0, 2);

    expect(map).toEqual([0, null, null, 1]);
    expect(map.filter((entry) => entry === null)).toHaveLength(2);
    expect(resolveMergedIndexes(map, [0, 1])).toEqual([0, 3]);
  });

  it('composes across several changes in the order they were made', () => {
    // A reviewer inserting, then deleting, then taking a bar — nothing about
    // that sequence is unusual, and each step has to see the one before it.
    let map = identityMeasureMap(5);
    map = withInsertedMeasures(map, 1, 1);
    expect(map).toEqual([0, 1, null, 2, 3, 4]);
    map = withRemovedMeasures(map, [0]);
    expect(map).toEqual([1, null, 2, 3, 4]);

    expect(resolveMergedIndexes(map, [3])).toEqual([3]);
    expect(resolveMergedIndexes(map, [0])).toBeNull();
  });

  it('anchors an insertion at the start without translating', () => {
    const map = withRemovedMeasures(identityMeasureMap(3), [0]);

    expect(resolveMergedAnchor(map, -1)).toBe(-1);
    expect(resolveMergedAnchor(map, 1)).toBe(0);
    // The anchor bar itself is gone, so there is nowhere to put this.
    expect(resolveMergedAnchor(map, 0)).toBeNull();
  });
  it('moves the map when a passage is replaced by one of a different length', () => {
    // One bar of the source reading swapped for the other engine's two. The
    // bars after it have not changed, but they have all moved along one, and a
    // map that still claimed otherwise would send the next take a bar early.
    const map = withReplacedMeasures(identityMeasureMap(5), [2], 2);

    expect(map).toEqual([0, 1, null, null, 3, 4]);
    expect(resolveMergedIndexes(map, [3])).toEqual([4]);
    // The replaced bar is no longer addressable in the engine's numbering,
    // which is what stops a later take from acting on a neighbour.
    expect(resolveMergedIndexes(map, [2])).toBeNull();
  });

  it('leaves the map alone when the replacement is the same length', () => {
    const map = withReplacedMeasures(identityMeasureMap(4), [1], 1);

    // The passage still occupies one bar in the same place, so every engine
    // index after it still resolves where it did — which is what lets a
    // same-length take be taken back.
    expect(resolveMergedIndexes(map, [2])).toEqual([2]);
    expect(resolveMergedIndexes(map, [3])).toEqual([3]);
  });
});

describe('editedMeasuresAfterSplice', () => {
  const edits = [
    { stablePartKey: 'violin', measureIndex: 0 },
    { stablePartKey: 'violin', measureIndex: 2 },
    { stablePartKey: 'violin', measureIndex: 4 },
    { stablePartKey: 'cello', measureIndex: 2 },
    { measureIndex: 2 }
  ];

  it('clears the replaced bars and shifts later edits in the same part', () => {
    expect(editedMeasuresAfterSplice(edits, 'violin', [2], 2, 1)).toEqual([
      { stablePartKey: 'violin', measureIndex: 0 },
      { stablePartKey: 'violin', measureIndex: 5 },
      { stablePartKey: 'cello', measureIndex: 2 },
      { measureIndex: 2 }
    ]);
  });

  it('shifts later edits when bars are inserted without clearing the anchor', () => {
    expect(editedMeasuresAfterSplice(edits, 'violin', [], 1, 0)).toEqual([
      { stablePartKey: 'violin', measureIndex: 0 },
      { stablePartKey: 'violin', measureIndex: 3 },
      { stablePartKey: 'violin', measureIndex: 5 },
      { stablePartKey: 'cello', measureIndex: 2 },
      { measureIndex: 2 }
    ]);
  });
});

describe('mergedBlockReadsFrom', () => {
  it('reads from the engine the score started from until a decision moves it', () => {
    expect(mergedBlockReadsFrom(1, 'homr', [])).toBe('homr');
    expect(mergedBlockReadsFrom(1, 'homr', undefined)).toBe('homr');
  });

  it('follows the last decision on that block', () => {
    const decisions = [
      { blockIndex: 1, engineId: 'transcoda' },
      { blockIndex: 2, engineId: 'transcoda' }
    ];

    expect(mergedBlockReadsFrom(1, 'homr', decisions)).toBe('transcoda');
    // Taking it back is an ordinary decision, and the block reads from the
    // origin engine again — which is the case that used to be unreachable.
    expect(
      mergedBlockReadsFrom(1, 'homr', [...decisions, { blockIndex: 1, engineId: 'homr' }])
    ).toBe('homr');
  });

  it('ignores a markings take, which moves no notes', () => {
    const decisions = [
      { blockIndex: 1, engineId: 'transcoda' },
      { blockIndex: 1, engineId: 'homr', markingsOnly: 'dynamics' as const }
    ];

    expect(mergedBlockReadsFrom(1, 'homr', decisions)).toBe('transcoda');
  });

  it("does not let another block's decision speak for this one", () => {
    expect(mergedBlockReadsFrom(1, 'homr', [{ blockIndex: 2, engineId: 'transcoda' }])).toBe(
      'homr'
    );
  });
});
