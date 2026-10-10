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
  it('mirrors the writer when the rhythm and pitch heads disagree', () => {
    const decoded = [{ ...staves[0], tokens: [
      ['rest_4', 'C4'], ['note_4', '_'], ['note_4', '.']
    ] }];
    const written: XmlNote[] = [
      { partId: 'P1', measure: 1, ordinal: 1, rest: false, pitch: 'C4' },
      { partId: 'P1', measure: 1, ordinal: 2, rest: true, pitch: null },
      { partId: 'P1', measure: 1, ordinal: 3, rest: true, pitch: null }
    ];
    const map = alignTokensToNotes(decoded, written, 0);
    expect(map.get('0:0')).toBe('["P1",1,1]');
    expect(map.get('0:1')).toBe('["P1",1,2]');
    expect(map.get('0:2')).toBe('["P1",1,3]');
    expect(() => alignTokensToNotes(decoded, [
      { ...written[0], rest: true, pitch: null }, ...written.slice(1)
    ], 0)).toThrow(/kinds differ/);
  });

  it('does not swap simultaneous pitched and pitchless tokens', () => {
    const decoded = [{ ...staves[0], tokens: [
      ...Array.from({ length: 60 }, () => ['note_4', 'D4']),
      ['rest_8', 'C5'], ['chord'], ['note_8', '_']
    ] }];
    const written: XmlNote[] = [
      ...Array.from({ length: 60 }, (_, index) => ({
        partId: 'P1', measure: 1, ordinal: index + 1, rest: false, pitch: 'D4'
      })),
      { partId: 'P1', measure: 1, ordinal: 61, rest: true, pitch: null },
      { partId: 'P1', measure: 1, ordinal: 62, rest: false, pitch: 'C5' }
    ];
    const map = alignTokensToNotes(decoded, written, 0);
    expect(map.get('0:60')).toBe('["P1",1,62]');
    expect(map.get('0:62')).toBe('["P1",1,61]');
  });
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

describe('grand-staff chords', () => {
  // Tokens list both hands' simultaneous notes as one run (high to low); the XML writes each hand as its
  // own chord group, lowest of the hand first.
  const piano = [
    {
      index: 0,
      partIndex: 0,
      systemIndex: 0,
      region: [0, 0, 1, 1],
      tokens: [
        ['clef_G2', 'upper'],
        ['note_8', 'E4'],
        ['chord'],
        ['note_8', 'B3'],
        ['chord'],
        ['note_8', 'G3'],
        ['chord'],
        ['note_2', 'E3'],
        ['chord'],
        ['note_2', 'B2'],
        ['note_4', 'C4']
      ]
    }
  ];
  const note = (ordinal: number, pitch: string, chord: boolean): XmlNote => ({
    partId: 'P1',
    measure: 1,
    ordinal,
    rest: false,
    pitch,
    chord
  });
  const sequence = [
    note(1, 'G3', false),
    note(2, 'E4', true),
    note(3, 'B3', true),
    note(4, 'E3', false),
    note(5, 'B2', true),
    note(6, 'C4', false)
  ];

  it('pairs notes by pitch within a simultaneous run, whatever order the chord is written in', () => {
    const map = alignTokensToNotes(piano, sequence, 0);
    expect(map.get('0:1')).toBe('["P1",1,2]'); // E4
    expect(map.get('0:3')).toBe('["P1",1,3]'); // B3
    expect(map.get('0:5')).toBe('["P1",1,1]'); // G3
    expect(map.get('0:7')).toBe('["P1",1,4]'); // E3
    expect(map.get('0:9')).toBe('["P1",1,5]'); // B2
    expect(map.get('0:10')).toBe('["P1",1,6]'); // the following single note
  });

  it('refuses when the groups do not add up to the same notes', () => {
    const short = sequence.slice(0, 5).concat(note(6, 'C4', true)); // C4 joins the chord: runs no longer line up
    expect(() => alignTokensToNotes(piano, short, 0)).toThrow(/chord groups|counts/);
  });
});
