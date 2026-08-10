import {
  DEFAULT_REVIEW_THRESHOLDS,
  effectiveCeiling,
  ReviewStaff,
  remainingFloor,
  selectSpots
} from './scanner-review';

function head(chosen: string, confidence: number, alternatives: Array<[string, number]>) {
  return {
    chosen,
    confidence,
    alternatives: alternatives.map(([value, alternativeConfidence]) => ({
      value,
      confidence: alternativeConfidence
    }))
  };
}

function staff(index: number, symbols: any[]): ReviewStaff {
  return { index, region: [0, 0, 100, 50], symbols };
}

function symbol(index: number, heads: Record<string, any>) {
  return { index, rhythm: 'note_4', heads, attention: null };
}

describe('selectSpots', () => {
  it('ranks strictly by ascending confidence', () => {
    // The queue's value is that "everything left is at least X%" is true, which
    // needs monotonic ordering rather than an impact weighting.
    const staves = [
      staff(0, [
        symbol(1, { pitch: head('C4', 0.72, [['D4', 0.2]]) }),
        symbol(2, { pitch: head('E4', 0.41, [['F4', 0.39]]) }),
        symbol(3, { rhythm: head('note_8', 0.55, [['note_16', 0.4]]) })
      ])
    ];
    expect(selectSpots(staves).map((spot) => spot.confidence)).toEqual([0.41, 0.55, 0.72]);
  });

  it('skips heads the model was confident about', () => {
    const staves = [staff(0, [symbol(1, { pitch: head('C4', 0.97, [['D4', 0.02]]) })])];
    expect(selectSpots(staves)).toEqual([]);
  });

  it('skips uncertainty with no plausible alternative', () => {
    // 0.60 against 0.05 is doubt with nothing to offer instead; asking would
    // present a choice the model does not consider close.
    const staves = [staff(0, [symbol(1, { pitch: head('C4', 0.6, [['D4', 0.05]]) })])];
    expect(selectSpots(staves)).toEqual([]);
  });

  it('uses a ratio rather than an absolute margin', () => {
    // Probabilities sum to one, so at 0.72 the runner-up cannot exceed 0.28. An
    // absolute 0.25 margin would have excluded this outright and silently
    // capped the effective floor near 0.62.
    const staves = [staff(0, [symbol(1, { pitch: head('C4', 0.72, [['D4', 0.2]]) })])];
    expect(selectSpots(staves)).toHaveLength(1);
  });

  it('requires low-impact heads to be more doubtful', () => {
    const slur = [staff(0, [symbol(1, { slur: head('slur', 0.6, [['none', 0.39]]) })])];
    expect(selectSpots(slur)).toEqual([]);

    const pitch = [staff(0, [symbol(1, { pitch: head('C4', 0.6, [['D4', 0.39]]) })])];
    expect(selectSpots(pitch)).toHaveLength(1);

    const doubtfulSlur = [staff(0, [symbol(1, { slur: head('slur', 0.44, [['none', 0.42]]) })])];
    expect(selectSpots(doubtfulSlur)).toHaveLength(1);
  });

  it('never asks about heads a reviewer cannot judge from a crop', () => {
    const staves = [staff(0, [symbol(1, { position: head('upper', 0.3, [['lower', 0.29]]) })])];
    expect(selectSpots(staves)).toEqual([]);
  });

  it('is stable for equal confidence so a returning reviewer sees one order', () => {
    const staves = [
      staff(1, [symbol(9, { pitch: head('C4', 0.5, [['D4', 0.4]]) })]),
      staff(0, [symbol(2, { pitch: head('C4', 0.5, [['D4', 0.4]]) })])
    ];
    expect(selectSpots(staves).map((spot) => [spot.staffIndex, spot.symbolIndex])).toEqual([
      [0, 2],
      [1, 9]
    ]);
  });

  it('honours retuned thresholds without re-scanning', () => {
    // The reason selection lives here rather than in the provider.
    const staves = [staff(0, [symbol(1, { pitch: head('C4', 0.7, [['D4', 0.25]]) })])];
    expect(selectSpots(staves, { ...DEFAULT_REVIEW_THRESHOLDS, floor: 0.6 })).toEqual([]);
    expect(selectSpots(staves, { ...DEFAULT_REVIEW_THRESHOLDS, floor: 0.8 })).toHaveLength(1);
  });

  it('raising the floor alone cannot reach past the ratio ceiling', () => {
    // Documented in `effectiveCeiling`: at ratio 0.25 nothing above 0.8 can
    // qualify, because the runner-up cannot be large enough. An operator
    // raising the floor to catch more would otherwise see no change and no
    // explanation.
    const staves = [staff(0, [symbol(1, { pitch: head('C4', 0.9, [['D4', 0.1]]) })])];
    expect(effectiveCeiling(DEFAULT_REVIEW_THRESHOLDS)).toBeCloseTo(0.8);
    expect(selectSpots(staves, { ...DEFAULT_REVIEW_THRESHOLDS, floor: 0.99 })).toEqual([]);

    // Lowering the ratio is what actually moves the ceiling.
    const wider = { ...DEFAULT_REVIEW_THRESHOLDS, floor: 0.99, minAlternativeRatio: 0.1 };
    expect(effectiveCeiling(wider)).toBeCloseTo(0.909, 2);
    expect(selectSpots(staves, wider)).toHaveLength(1);
  });
});

describe('remainingFloor', () => {
  it('rises as the reviewer works and ends at null', () => {
    const staves = [
      staff(0, [
        symbol(1, { pitch: head('C4', 0.4, [['D4', 0.35]]) }),
        symbol(2, { pitch: head('E4', 0.6, [['F4', 0.3]]) }),
        symbol(3, { pitch: head('G4', 0.75, [['A4', 0.2]]) })
      ])
    ];
    const spots = selectSpots(staves);
    expect(remainingFloor(spots, 0)).toBeCloseTo(0.4);
    expect(remainingFloor(spots, 1)).toBeCloseTo(0.6);
    expect(remainingFloor(spots, 2)).toBeCloseTo(0.75);
    expect(remainingFloor(spots, 3)).toBeNull();
  });
});
