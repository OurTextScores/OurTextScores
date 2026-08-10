import { locateSymbol } from './scanner-locate';

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
