import {
  charWidths,
  anchorRows,
  noteXPositions,
  splitSyllables,
  AnchorStaff
} from './scanner-lyric-anchors';

// A 1000px-wide staff at y 100-160: |  n n n |  n n | with bar lines at x=300 and x=700.
const staff = (extra: Partial<AnchorStaff> = {}): AnchorStaff => ({
  index: 0,
  partIndex: 0,
  systemIndex: 0,
  region: [0, 100, 1000, 160],
  tokens: [
    ['clef_G2'],
    ['note_8', 'C4'],
    ['note_8', 'D4'],
    ['note_8', 'E4'],
    ['barline'],
    ['note_4', 'F4'],
    ['note_4', 'G4'],
    ['barline'],
    ['rest_2']
  ],
  barLines: [300, 700],
  // Attention (model canvas 1280 wide): C4 at 10%, D4 at 20%, G4 at 60%; E4, F4 and the rest pruned.
  symbols: [
    { index: 1, attention: [128, 0] },
    { index: 2, attention: [256, 0] },
    { index: 6, attention: [768, 0] }
  ],
  ...extra
});

describe('splitSyllables', () => {
  it('splits on spaces, hyphens and underscores and places pieces proportionally', () => {
    const parts = splitSyllables('wish -ing');
    expect(parts.map((p) => p.text)).toEqual(['wish', 'ing']);
    expect(parts[0].start).toBe(0);
    expect(parts[1].end).toBe(1);
    expect(splitSyllables('  _ - ')).toEqual([]);
  });
});

describe('punctuation-only fragments', () => {
  it('withholds isolated punctuation without moving neighbouring lyric syllables', () => {
    const pieces = splitSyllables('die . be !');
    expect(pieces.map((piece) => piece.text)).toEqual(['die', 'be']);
    expect(pieces[1].start).toBeCloseTo(6 / 10, 5);
    expect(splitSyllables('Ah! I’d O.')).toHaveLength(3);
    expect(splitSyllables('sé ché')).toHaveLength(2);
  });
});

describe('ellipsis-aware placement', () => {
  it('counts a run of three or more dots as one unit and everything else as one each', () => {
    expect(charWidths('ab')).toEqual([1, 1]);
    expect(charWidths('a...b')).toEqual([1, 1, 0, 0, 1]);
    expect(charWidths('a..b')).toEqual([1, 1, 1, 1]);
  });

  it('does not let a run of dots push later words right', () => {
    expect(splitSyllables('ziehn,......wir').map((p) => p.text)).toEqual(['ziehn,', 'wir']);
    expect(splitSyllables('a..b').map((p) => p.text)).toEqual(['a..b']); // two dots stay inside a word
    const dotted = splitSyllables('ab ...... wir');
    const wir = dotted[dotted.length - 1];
    expect(wir.text).toBe('wir');
    // Counting every dot would put it at 10/13 = 0.77; one unit for the run puts it at 6/8 = 0.75... but the
    // dots belong to no word, so compare against the same text without the run.
    const without = splitSyllables('ab . wir');
    expect(Math.abs(wir.start - without[without.length - 1].start)).toBeLessThan(0.02);
    // Rows without an ellipsis are placed exactly as before.
    const plain = splitSyllables('wish -ing');
    expect(plain[1].start).toBeCloseTo(6 / 9, 5);
  });
});

describe('noteXPositions', () => {
  it('uses attention where ordered and interpolates between known marks and bar lines', () => {
    const positions = noteXPositions(staff());
    expect(positions.get(1)).toEqual({ x: 100, how: 'attention' });
    expect(positions.get(6)).toEqual({ x: 600, how: 'attention' });
    const e4 = positions.get(3)!; // between D4 (200) and the bar line (300)
    expect(e4.how).toBe('interpolated');
    expect(e4.x).toBeGreaterThan(200);
    expect(e4.x).toBeLessThan(300);
    expect(positions.has(0)).toBe(false); // the clef is not a note
  });

  it('rejects an out-of-order attention point rather than trusting it', () => {
    const bad = staff({
      symbols: [
        { index: 1, attention: [900, 0] },
        { index: 2, attention: [256, 0] }
      ]
    });
    expect(noteXPositions(bad).get(1)!.how).toBe('interpolated');
  });
});

describe('anchorRows', () => {
  const row = (id: string, box: number[], text: string) => ({
    id,
    box: box as [number, number, number, number],
    text
  });

  it('assigns the staff above, ranks printed lines top to bottom and finds measure and note', () => {
    const rows = [
      row('a', [90, 170, 140, 190], 'kind'), // line 1, under C4 in measure 0
      row('b', [450, 172, 690, 192], 'wish -ing'), // line 1, measure 1 (between the bar lines)
      row('c', [90, 210, 140, 230], 'Kind') // line 2
    ];
    const out = anchorRows(rows, [staff()]);
    expect(out.get('a')).toMatchObject({ staffIndex: 0, printedLine: 1 });
    expect(out.get('c')!.printedLine).toBe(2);
    const a = out.get('a')!.syllables[0];
    expect(a).toMatchObject({
      measureInStaff: 0,
      noteTokenIndex: 1,
      notePitch: 'C4',
      noteOrdinalInMeasure: 1,
      position: 'attention'
    });
    const b = out.get('b')!.syllables;
    expect(b.map((s) => s.measureInStaff)).toEqual([1, 1]);
    expect(b.map((s) => s.noteTokenIndex)).toEqual([5, 6]); // F4 then G4, left to right
    expect(b.map((s) => s.noteOrdinalInMeasure)).toEqual([1, 2]);
  });

  it('leaves rows far from any staff, or with no staff above, unanchored', () => {
    expect(anchorRows([row('far', [0, 900, 50, 920], 'x')], [staff()]).size).toBe(0);
    expect(anchorRows([row('above', [0, 10, 50, 30], 'x')], [staff()]).size).toBe(0);
  });

  it('picks the staff whose bottom is nearest when regions overlap and a row sits inside its own staff', () => {
    const voice = staff({ index: 0, region: [0, 100, 1000, 400] });
    const piano = staff({ index: 1, partIndex: 1, region: [0, 330, 1000, 800] });
    // The row is inside both regions; the voice staff's bottom edge (400) is the nearer one.
    expect(
      anchorRows([row('in', [90, 370, 140, 390], 'kind')], [piano, voice]).get('in')!.staffIndex
    ).toBe(0);
  });

  it('gives a syllable far from every note of its measure no note at all', () => {
    const sparse = staff({
      tokens: [['clef_G2'], ['note_8', 'C4'], ['barline']],
      barLines: [900],
      symbols: [{ index: 1, attention: [128, 0] }]
    });
    // C4 sits at x=100; a credit set ~500px away under the same staff is nowhere near it.
    const out = anchorRows([row('credit', [590, 170, 650, 190], 'PAUL')], [sparse]);
    expect(out.get('credit')!.syllables[0]).toMatchObject({
      noteTokenIndex: null,
      noteX: null,
      position: 'none'
    });
    // A syllable 90px from the note still gets it.
    const near = anchorRows([row('near', [165, 170, 215, 190], 'kind')], [sparse]);
    expect(near.get('near')!.syllables[0].noteTokenIndex).toBe(1);
  });

  it('gives a clipped single consonant at a row edge no note, but keeps vowels and lone words', () => {
    const out = anchorRows(
      [
        row('a', [90, 170, 330, 190], 'n hin- nen'),
        row('b', [90, 220, 330, 240], 'i hin-nen'),
        row('c', [90, 195, 120, 215], 'n')
      ],
      [staff()]
    );
    const first = out.get('a')!.syllables;
    expect(first[0]).toMatchObject({ text: 'n', fragment: true, noteTokenIndex: null });
    expect(first[1].noteTokenIndex).not.toBeNull();
    expect(out.get('b')!.syllables[0].fragment).toBeUndefined();
    // A row that is only one consonant is not "clipped" by a neighbour here; it is judged elsewhere.
    expect(out.get('c')!.syllables[0].fragment).toBeUndefined();
  });

  it('ignores staves with no notes', () => {
    const empty = staff({ tokens: [['clef_G2'], ['barline']], symbols: [] });
    expect(anchorRows([row('a', [90, 170, 140, 190], 'x')], [empty]).size).toBe(0);
  });
});


describe('double-bar measure boundaries', () => {
  it('keeps lyrics after a double bar in their own measure, including interpolation', () => {
    const context = staff({
      tokens: [['rest_1'], ['doublebarline'], ['note_4', 'B3'], ['note_4', 'E4'], ['barline']],
      barLines: [300, 700],
      symbols: []
    });
    const positions = noteXPositions(context);
    expect(positions.get(2)!.x).toBeGreaterThan(300);
    expect(positions.get(3)!.x).toBeLessThan(700);
    const anchor = anchorRows([{ id: 'after-double-bar', text: 'Dans la', box: [420, 170, 610, 190] }], [context]).get('after-double-bar')!;
    expect(anchor.syllables.map((s) => s.measureInStaff)).toEqual([1, 1]);
    expect(anchor.syllables.map((s) => s.noteTokenIndex)).toEqual([2, 3]);
    expect(anchor.syllables.map((s) => s.notePitch)).toEqual(['B3', 'E4']);
  });
});
