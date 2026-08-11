import {
  DEFAULT_REVIEW_THRESHOLDS,
  effectiveCeiling,
  homrReviewVoicesForRegeneration,
  pageSuitability,
  ReviewStaff,
  remainingFloor,
  selectSpots
} from './scanner-review';

const token = (rhythm: string, pitch = '.') => [rhythm, pitch, '_', '_', '_', 'upper'];

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

describe('homrReviewVoicesForRegeneration', () => {
  it('reconstructs voice-major parts and inserts system breaks', () => {
    const staves: ReviewStaff[] = [
      { ...staff(0, []), partIndex: 0, systemIndex: 0, tokens: [token('note_4', 'C4')] },
      { ...staff(1, []), partIndex: 0, systemIndex: 1, tokens: [token('note_4', 'D4')] },
      { ...staff(2, []), partIndex: 1, systemIndex: 0, tokens: [token('note_4', 'E4')] },
      { ...staff(3, []), partIndex: 1, systemIndex: 1, tokens: [token('note_4', 'F4')] }
    ];

    expect(homrReviewVoicesForRegeneration(staves)).toEqual([
      [token('note_4', 'C4'), token('newline'), token('note_4', 'D4')],
      [token('note_4', 'E4'), token('newline'), token('note_4', 'F4')]
    ]);
  });

  it('keeps a single legacy staff but refuses ambiguous legacy multi-staff data', () => {
    const legacy = { ...staff(0, []), tokens: [token('note_4', 'C4')] };
    expect(homrReviewVoicesForRegeneration([legacy])).toEqual([[token('note_4', 'C4')]]);
    expect(homrReviewVoicesForRegeneration([legacy, { ...legacy, index: 1 }])).toBeNull();
  });

  it('refuses partial, duplicate, or non-contiguous mappings', () => {
    const mapped = {
      ...staff(0, []),
      partIndex: 0,
      systemIndex: 0,
      tokens: [token('note_4', 'C4')]
    };
    expect(
      homrReviewVoicesForRegeneration([mapped, { ...mapped, index: 1, systemIndex: undefined }])
    ).toBeNull();
    expect(homrReviewVoicesForRegeneration([mapped, { ...mapped, index: 1 }])).toBeNull();
    expect(
      homrReviewVoicesForRegeneration([mapped, { ...mapped, index: 1, systemIndex: 2 }])
    ).toBeNull();
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

describe('the lower bound', () => {
  it('does not ask when the model is merely shrugging', () => {
    // Measured on a real out-of-scope page: the least certain spot was
    // `pitch C3 11% vs B3 10%`. Neither is likely right, so the choice is noise
    // dressed as a decision — and ascending order would put it first.
    const staves = [staff(0, [symbol(1, { pitch: head('C3', 0.11, [['B3', 0.1]]) })])];
    expect(selectSpots(staves)).toEqual([]);
  });

  it('still asks just above the bound', () => {
    const staves = [staff(0, [symbol(1, { pitch: head('C3', 0.4, [['B3', 0.3]]) })])];
    expect(selectSpots(staves)).toHaveLength(1);
  });

  it('keeps the queue opening with useful questions', () => {
    const staves = [
      staff(0, [
        symbol(1, { pitch: head('C3', 0.12, [['B3', 0.11]]) }),
        symbol(2, { pitch: head('E4', 0.45, [['F4', 0.4]]) })
      ])
    ];
    const spots = selectSpots(staves);
    expect(spots).toHaveLength(1);
    expect(spots[0].confidence).toBeCloseTo(0.45);
  });
});

describe('pageSuitability', () => {
  it('is quiet about a page the model mostly handled', () => {
    const staves = [
      staff(
        0,
        Array.from({ length: 20 }, (_, i) =>
          symbol(i, { pitch: head('C4', i === 0 ? 0.5 : 0.99, [['D4', i === 0 ? 0.4 : 0.005]]) })
        )
      )
    ];
    const report = pageSuitability(staves, selectSpots(staves));
    expect(report.spots).toBe(1);
    expect(report.unsuitable).toBe(false);
  });

  it('flags a page past reliable recognition without blocking it', () => {
    // The real manuscript produced 791 spots from 899 symbols. Presenting that
    // with no comment implies the page is nearly right.
    const staves = [
      staff(
        0,
        Array.from({ length: 10 }, (_, i) => symbol(i, { pitch: head('C4', 0.45, [['D4', 0.4]]) }))
      )
    ];
    const spots = selectSpots(staves);
    const report = pageSuitability(staves, spots);
    expect(report.askableRatio).toBeCloseTo(1);
    expect(report.unsuitable).toBe(true);
    // A signal, not a gate: the queue is still there to work.
    expect(spots).toHaveLength(10);
  });
});

describe('placeholder options', () => {
  it('does not ask a question whose every answer means nothing', () => {
    // Seen on a real printed page: `pitch . 37% vs _ 31%`. Both are HOMR
    // placeholders, so the reviewer would be choosing between two ways of
    // saying nothing.
    const staves = [staff(0, [symbol(1, { pitch: head('.', 0.37, [['_', 0.31]]) })])];
    expect(selectSpots(staves)).toEqual([]);
  });

  it('still asks when one option is real', () => {
    // `slur . 39% vs slurStart 31%` is a genuine question: no slur, or a slur
    // starting here.
    const staves = [staff(0, [symbol(1, { slur: head('.', 0.39, [['slurStart', 0.31]]) })])];
    expect(selectSpots(staves)).toHaveLength(1);
  });
});
