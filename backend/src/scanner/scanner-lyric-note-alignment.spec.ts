import { alignAllParts, alignTokensToNotes, XmlNote } from './scanner-lyric-note-alignment';

const staves = [
  {
    index: 0,
    partIndex: 0,
    systemIndex: 0,
    region: [0, 0, 1, 1],
    tokens: [['clef_G2'], ['note_4', 'C4'], ['rest_4'], ['barline']]
  },
  { index: 1, partIndex: 0, systemIndex: 1, region: [0, 0, 1, 1], tokens: [['note_4', 'D4']] },
  { index: 2, partIndex: 1, systemIndex: 0, region: [0, 0, 1, 1], tokens: [['note_4', 'E2']] }
];
const xml: XmlNote[] = [
  { partId: 'P1', measure: 1, ordinal: 1, rest: false, pitch: 'C4' },
  { partId: 'P1', measure: 1, ordinal: 2, rest: true, pitch: null },
  { partId: 'P1', measure: 2, ordinal: 1, rest: false, pitch: 'D4' },
  { partId: 'P2', measure: 1, ordinal: 1, rest: false, pitch: 'E2' }
];

describe('alignTokensToNotes', () => {
  it('maps each note-like token to the exact XML note across systems', () => {
    const map = alignTokensToNotes(staves, xml, 0);
    expect(map.get('0:1')).toBe('["P1",1,1]');
    expect(map.get('0:2')).toBe('["P1",1,2]');
    expect(map.get('1:0')).toBe('["P1",2,1]');
    expect(map.has('0:0')).toBe(false); // the clef is not a note
  });

  it('refuses a count, kind or pitch disagreement', () => {
    expect(() => alignTokensToNotes(staves, xml.slice(0, 2).concat(xml[3]), 0)).toThrow(
      /counts differ/
    );
    expect(() =>
      alignTokensToNotes(staves, [{ ...xml[0], rest: true, pitch: null }, ...xml.slice(1)], 0)
    ).toThrow(/kinds differ/);
    expect(() =>
      alignTokensToNotes(staves, [xml[0], xml[1], { ...xml[2], pitch: 'A5' }, xml[3]], 0)
    ).toThrow(/pitches differ/);
  });
});

describe('alignAllParts', () => {
  it('keeps the parts that align and drops the ones that do not', () => {
    const broken = xml
      .filter((n) => n.partId === 'P1')
      .concat([{ partId: 'P2', measure: 1, ordinal: 1, rest: true, pitch: null }]);
    const map = alignAllParts(staves, broken);
    expect(map.has('0:1')).toBe(true);
    expect(map.has('2:0')).toBe(false);
  });
});
