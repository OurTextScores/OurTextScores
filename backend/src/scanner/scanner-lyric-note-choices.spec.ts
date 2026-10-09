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
    expect(noteChoicesForRow(staff, [150, 170, 260, 190], ids, 10).map((c) => c.pitch)).toEqual(['D4']);
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
