import { noteChoicesForRow } from './scanner-lyric-note-choices';
import { placementCropRect, placementOverlaySvg } from './scanner-lyric-placement-crop';

const staff = {
  index: 0,
  partIndex: 0,
  systemIndex: 0,
  region: [0, 100, 1000, 160],
  tokens: [
    ['clef_G2'],
    ['note_8', 'C4'],
    ['note_8', 'D4'],
    ['rest_4'],
    ['note_4', 'E4'],
    ['barline']
  ],
  barLines: [900],
  symbols: [
    { index: 1, attention: [128, 0] },
    { index: 2, attention: [256, 0] },
    { index: 4, attention: [640, 0] }
  ]
};
const ids = new Map([
  ['0:1', '["P1",1,1]'],
  ['0:2', '["P1",1,2]'],
  ['0:4', '["P1",1,4]']
]);

describe('noteChoicesForRow', () => {
  it('offers the aligned notes near the row, left to right and numbered, skipping rests', () => {
    const choices = noteChoicesForRow(staff, [150, 170, 260, 190], ids, 100);
    expect(choices.map((c) => [c.number, c.pitch, c.ordinal])).toEqual([
      [1, 'C4', 1],
      [2, 'D4', 2]
    ]);
    expect(choices[0].x).toBeLessThan(choices[1].x);
  });

  it('offers nothing for notes that did not align and nothing far from the row', () => {
    expect(noteChoicesForRow(staff, [150, 170, 260, 190], new Map(), 100)).toEqual([]);
    // With a 10px margin only D4 (x=200) reaches the row (x 150-260); C4 (x=100) does not.
    expect(noteChoicesForRow(staff, [150, 170, 260, 190], ids, 10).map((c) => c.pitch)).toEqual([
      'D4'
    ]);
    expect(noteChoicesForRow(staff, [880, 170, 950, 190], ids, 50)).toEqual([]);
  });
});

describe('placement crop', () => {
  const choices = noteChoicesForRow(staff, [150, 170, 260, 190], ids, 100);
  it('covers the row, the staff and every choice, and stays on the page', () => {
    const rect = placementCropRect([150, 170, 260, 190], staff.region, choices, {
      width: 1000,
      height: 400
    });
    expect(rect.left).toBeLessThanOrEqual(100);
    expect(rect.top).toBeLessThanOrEqual(100);
    expect(rect.top + rect.height).toBeLessThanOrEqual(400);
    expect(rect.left + rect.width).toBeLessThanOrEqual(1000);
  });

  it('draws a numbered line per choice and marks the proposed one in blue', () => {
    const rect = placementCropRect([150, 170, 260, 190], staff.region, choices, {
      width: 1000,
      height: 400
    });
    const svg = placementOverlaySvg(
      rect,
      [150, 170, 260, 190],
      staff.region,
      choices,
      new Set([choices[1].noteId])
    );
    expect((svg.match(/<line /g) || []).length).toBe(2);
    expect(svg).toContain('#1766ce');
    expect(svg).toContain('>1<');
    expect(svg).toContain('>2<');
  });
});

describe('collapsing chord tones for directions', () => {
  // Two hands sounding together at x=100 (three tones in the right hand), then one note at x=200.
  const piano = {
    index: 0,
    partIndex: 0,
    systemIndex: 0,
    region: [0, 100, 1000, 300],
    tokens: [
      ['clef_G2', 'upper'],
      ['note_8', 'E4', 'b', '_', '_', 'upper'],
      ['chord'],
      ['note_8', 'B3', 'b', '_', '_', 'upper'],
      ['chord'],
      ['note_8', 'G3', 'b', '_', '_', 'upper'],
      ['chord'],
      ['note_2', 'E2', 'b', '_', '_', 'lower'],
      ['note_4', 'C4', '_', '_', '_', 'upper']
    ],
    symbols: [1, 3, 5, 7]
      .map((index) => ({ index, attention: [128, 0] }))
      .concat([{ index: 8, attention: [256, 0] }])
  };
  const pianoIds = new Map([
    ['0:1', '["P1",1,1]'],
    ['0:3', '["P1",1,2]'],
    ['0:5', '["P1",1,3]'],
    ['0:7', '["P1",1,4]'],
    ['0:8', '["P1",1,5]']
  ]);

  it('keeps every tone by default', () => {
    expect(noteChoicesForRow(piano, [50, 20, 250, 50], pianoIds, 100)).toHaveLength(5);
  });

  it('offers one choice per onset whatever the hand, keeping the preferred note, and numbers them again', () => {
    const choices = noteChoicesForRow(piano, [50, 20, 250, 50], pianoIds, 100, {
      prefer: '["P1",1,2]'
    });
    // Both hands sound at x=100: one choice (the preferred note); then the single note at x=200.
    expect(choices.map((c) => [c.number, c.pitch])).toEqual([
      [1, 'B3'],
      [2, 'C4']
    ]);
  });
});
