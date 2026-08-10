import { attentionIsOrdered, locateSymbol } from './scanner-locate';

function note(): string[] {
  return ['note_4', 'C4', '_', '_', '_', 'upper'];
}
function bar(): string[] {
  return ['barline', '.', '.', '.', '.', '.'];
}

describe('locateSymbol', () => {
  it('places a symbol in its measure', () => {
    // Three bar lines make four measures; a symbol after the second bar line
    // belongs to the third.
    const tokens = [note(), bar(), note(), bar(), note(), bar(), note()];
    const band = locateSymbol(tokens, 4);
    expect(band).toEqual({ start: 0.5, end: 0.75, basis: 'measure' });
  });

  it('puts the first symbol in the first measure', () => {
    const tokens = [note(), bar(), note(), bar(), note()];
    expect(locateSymbol(tokens, 0)).toMatchObject({ start: 0, basis: 'measure' });
  });

  it('keeps a trailing symbol inside the last measure', () => {
    // A symbol after the final bar line must not produce a band past the edge.
    const tokens = [note(), bar(), note(), bar()];
    const band = locateSymbol(tokens, 3)!;
    expect(band.end).toBeLessThanOrEqual(1);
    expect(band.start).toBeLessThan(band.end);
  });

  it('falls back to sequence position when a staff has no bar lines', () => {
    const tokens = [note(), note(), note(), note(), note()];
    const band = locateSymbol(tokens, 2)!;
    expect(band.basis).toBe('position');
    // Centred on the symbol, and wider to admit how rough that is.
    expect(band.start).toBeLessThan(0.5);
    expect(band.end).toBeGreaterThan(0.5);
  });

  it('is monotonic: later symbols never sit left of earlier ones', () => {
    // Spacing is approximate but ordering is exact, which is what stops a band
    // landing in the wrong part of the line.
    const tokens = [note(), note(), bar(), note(), note(), bar(), note()];
    const bands = [0, 1, 3, 4, 6].map((index) => locateSymbol(tokens, index)!);
    for (let i = 1; i < bands.length; i += 1) {
      expect(bands[i].start).toBeGreaterThanOrEqual(bands[i - 1].start);
    }
  });

  it('returns nothing when there is no sequence to locate against', () => {
    expect(locateSymbol(undefined, 0)).toBeNull();
    expect(locateSymbol([], 0)).toBeNull();
    expect(locateSymbol([note()], 5)).toBeNull();
  });

});

describe('note-level location', () => {
  // Two bar lines, so the measure fallback is available to fall back *to*.
  const tokens = [note(), note(), bar(), note(), bar(), note()];

  it('uses the attention point when it sits in scan order', () => {
    // Measured ~98% monotonic on a real printed page, so this is the common
    // case, not the exception.
    const symbols = [
      { index: 0, attention: [128, 40] },
      { index: 1, attention: [640, 40] },
      { index: 3, attention: [1152, 40] }
    ];
    const band = locateSymbol(tokens, 1, symbols)!;
    expect(band.basis).toBe('note');
    // 640 / 1280 = half way along the staff.
    expect((band.start + band.end) / 2).toBeCloseTo(0.5, 5);
    expect(band.end - band.start).toBeLessThan(0.1);
  });

  it('falls back to the measure when the point breaks scan order', () => {
    // HOMR names this test: patch tokens are processed in raster order, so a
    // coordinate that goes backwards is the unreliable one.
    const symbols = [
      { index: 0, attention: [128, 40] },
      { index: 1, attention: [1200, 40] },
      { index: 3, attention: [300, 40] }
    ];
    expect(locateSymbol(tokens, 1, symbols)!.basis).toBe('measure');
  });

  it('falls back when there is no attention point at all', () => {
    expect(locateSymbol(tokens, 1, [{ index: 1, attention: null }])!.basis).not.toBe('note');
    expect(locateSymbol(tokens, 1)!.basis).not.toBe('note');
  });

  it('is much narrower than a measure', () => {
    // The point of note-level: a measure can hold eight notes.
    const symbols = [{ index: 1, attention: [640, 40] }];
    const note = locateSymbol(tokens, 1, symbols)!;
    const measure = locateSymbol(tokens, 1)!;
    expect(note.end - note.start).toBeLessThan(measure.end - measure.start);
  });
});

describe('attentionIsOrdered', () => {
  it('accepts a run that only increases', () => {
    const symbols = [
      { index: 0, attention: [10, 1] },
      { index: 1, attention: [20, 1] },
      { index: 2, attention: [30, 1] }
    ];
    expect(attentionIsOrdered(symbols, 1)).toBe(true);
  });

  it('rejects a point that goes backwards', () => {
    const symbols = [
      { index: 0, attention: [50, 1] },
      { index: 1, attention: [10, 1] },
      { index: 2, attention: [60, 1] }
    ];
    expect(attentionIsOrdered(symbols, 1)).toBe(false);
  });

  it('tolerates gaps, since confident symbols are pruned away', () => {
    // A subsequence of a monotonic sequence is still monotonic.
    const symbols = [
      { index: 0, attention: [10, 1] },
      { index: 7, attention: [400, 1] },
      { index: 19, attention: [900, 1] }
    ];
    expect(attentionIsOrdered(symbols, 7)).toBe(true);
  });
});
