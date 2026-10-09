import { applyReviewedLyricCopy, lyricNoteInventory } from './scanner-reviewed-lyric-copy';
const xml = Buffer.from(
  '<score-partwise><part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list><part id="P1"><measure number="4"><attributes><divisions>4</divisions></attributes><note><rest/><duration>4</duration></note><note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice></note></measure></part></score-partwise>'
);
const inventory = lyricNoteInventory(xml);
const row = {
  id: 's1',
  candidateId: 'c1',
  text: 'fi & <fine>',
  printedLine: 2,
  noteId: inventory.notes[0].id,
  textConfirmed: true,
  lineConfirmed: true,
  noteConfirmed: true
};
const request = {
  automaticAttachment: false,
  musicXmlSha256: inventory.musicXmlSha256,
  placements: [row]
};
describe('reviewed lyric score copy', () => {
  it('lists pitched physical note identities, including preceding rest ordinal', () => {
    expect(inventory.notes[0]).toMatchObject({
      partId: 'P1',
      measure: 1,
      measureLabel: '4',
      noteOrdinal: 2,
      pitch: 'C5',
      onsetQuarterNotes: 1
    });
  });
  it('creates an escaped copy preserving original notes and never mutates input', () => {
    const before = Buffer.from(xml);
    const result = applyReviewedLyricCopy(xml, request, new Set(['c1']));
    expect(result.toString()).toContain(
      '<lyric number="2"><text>fi &amp; &lt;fine&gt;</text></lyric>'
    );
    expect(xml.equals(before)).toBe(true);
  });
  it.each(['textConfirmed', 'lineConfirmed', 'noteConfirmed'])('requires explicit %s', (key) => {
    expect(() =>
      applyReviewedLyricCopy(
        xml,
        { ...request, placements: [{ ...row, [key]: false }] },
        new Set(['c1'])
      )
    ).toThrow();
  });
  it('preserves escaped existing text and refuses an occupied line', () => {
    const existing = Buffer.from(
      xml
        .toString()
        .replace('<part-name>Voice</part-name>', '<part-name>Voice &amp; piano</part-name>')
        .replace('</note></measure>', '<lyric number="2"><text>old</text></lyric></note></measure>')
    );
    expect(() =>
      applyReviewedLyricCopy(
        existing,
        { ...request, musicXmlSha256: lyricNoteInventory(existing).musicXmlSha256 },
        new Set(['c1'])
      )
    ).toThrow('occupied');
    const output = applyReviewedLyricCopy(
      existing,
      {
        ...request,
        musicXmlSha256: lyricNoteInventory(existing).musicXmlSha256,
        placements: [{ ...row, printedLine: 3 }]
      },
      new Set(['c1'])
    );
    expect(output.toString()).toContain('Voice &amp; piano');
    expect(output.toString()).toContain('<text>old</text>');
  });

  it('refuses stale hash, foreign region and duplicate note-line slot', () => {
    expect(() =>
      applyReviewedLyricCopy(xml, { ...request, musicXmlSha256: 'stale' }, new Set(['c1']))
    ).toThrow();
    expect(() => applyReviewedLyricCopy(xml, request, new Set())).toThrow();
    expect(() =>
      applyReviewedLyricCopy(
        xml,
        { ...request, placements: [row, { ...row, id: 's2' }] },
        new Set(['c1'])
      )
    ).toThrow();
  });
});
