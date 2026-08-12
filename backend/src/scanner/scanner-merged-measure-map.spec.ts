import {
  identityMeasureMap,
  resolveMergedAnchor,
  resolveMergedIndexes,
  withInsertedMeasures,
  withRemovedMeasures
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
});
