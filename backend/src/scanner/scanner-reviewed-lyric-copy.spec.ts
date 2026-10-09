import {
  withoutLyrics,
  withoutReviewAdditions,
  applyReviewedLyricCopy,
  lyricNoteInventory
} from './scanner-reviewed-lyric-copy';
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

describe('withoutLyrics', () => {
  it('returns a lyric-free score byte for byte and removes only lyric elements otherwise', () => {
    expect(withoutLyrics(xml)).toBe(xml);
    const copy = applyReviewedLyricCopy(
      xml,
      {
        automaticAttachment: false,
        musicXmlSha256: inventory.musicXmlSha256,
        placements: [{ ...row, textConfirmed: true, lineConfirmed: true, noteConfirmed: true }]
      },
      new Set(['c1'])
    );
    expect(copy.toString('utf8')).toContain('<lyric');
    const stripped = withoutLyrics(copy);
    expect(stripped.toString('utf8')).not.toContain('<lyric');
    // Saving again must be able to start from the stripped score and arrive at the same inventory.
    expect(lyricNoteInventory(stripped).notes.map((n) => n.id)).toEqual(
      inventory.notes.map((n) => n.id)
    );
  });
});

describe('reviewed directions', () => {
  const direction = (extra: object = {}) => ({
    id: 'd1',
    candidateId: 'c1',
    noteId: inventory.notes[0].id,
    kind: 'words',
    text: 'cresc. poco a poco',
    placement: 'above',
    textConfirmed: true,
    noteConfirmed: true,
    ...extra
  });
  const req = (directions: object[], placements: object[] = []) => ({
    automaticAttachment: false,
    musicXmlSha256: inventory.musicXmlSha256,
    placements,
    directions
  });

  it('writes a words direction before its note, with a review id and escaped text', () => {
    const out = applyReviewedLyricCopy(
      xml,
      req([direction({ text: 'a & <b>' })]),
      new Set(['c1'])
    ).toString();
    expect(out).toMatch(
      /<direction placement="above" id="ots-review-[0-9a-f]{12}"><direction-type><words>a &amp; &lt;b&gt;<\/words><\/direction-type><\/direction><note><pitch>/
    );
  });

  it('writes a dynamic mark as a dynamics element and keeps lyrics and directions together', () => {
    const out = applyReviewedLyricCopy(
      xml,
      req([direction({ kind: 'dynamic', mark: 'mf', text: 'mf', placement: 'below' })], [row]),
      new Set(['c1'])
    ).toString();
    expect(out).toContain('<dynamics><mf></mf></dynamics>');
    expect(out).toContain('placement="below"');
    expect(out).toContain('<lyric number="2">');
  });

  it('adds a staff element only for a note that already names its staff', () => {
    const staffed = Buffer.from(
      xml.toString().replace('<voice>1</voice>', '<voice>1</voice><staff>2</staff>')
    );
    const inv = lyricNoteInventory(staffed);
    const out = applyReviewedLyricCopy(
      staffed,
      { ...req([direction({ noteId: inv.notes[0].id })]), musicXmlSha256: inv.musicXmlSha256 },
      new Set(['c1'])
    ).toString();
    expect(out).toContain('</direction-type><staff>2</staff></direction>');
  });

  it.each([
    ['unconfirmed text', { textConfirmed: false }],
    ['unconfirmed note', { noteConfirmed: false }],
    ['unknown note', { noteId: '["P1",9,9]' }],
    ['unknown kind', { kind: 'lyric' }],
    ['an unknown dynamic mark', { kind: 'dynamic', mark: 'zz' }],
    ['a bad placement', { placement: 'left' }],
    ['empty text', { text: '  ' }],
    ['a candidate that is not in the inventory', { candidateId: 'other' }]
  ])('refuses %s', (_name, extra) => {
    expect(() => applyReviewedLyricCopy(xml, req([direction(extra)]), new Set(['c1']))).toThrow();
  });

  it('refuses a duplicate direction on one note and requires something to write', () => {
    expect(() =>
      applyReviewedLyricCopy(xml, req([direction(), direction({ id: 'd2' })]), new Set(['c1']))
    ).toThrow(/Duplicate/);
    expect(() => applyReviewedLyricCopy(xml, req([]), new Set(['c1']))).toThrow();
  });

  it('strips what a review added so a re-save starts clean, and leaves other scores untouched', () => {
    const written = applyReviewedLyricCopy(xml, req([direction()], [row]), new Set(['c1']));
    const base = withoutReviewAdditions(written);
    expect(base.toString()).not.toContain('ots-review-');
    expect(base.toString()).not.toContain('<lyric');
    expect(base.toString()).toContain('<note><rest></rest>');
    expect(withoutReviewAdditions(xml)).toBe(xml);
    // A direction the source score had itself is not ours and survives.
    const own = Buffer.from(
      xml
        .toString()
        .replace(
          '<note><rest/>',
          '<direction placement="above"><direction-type><words>Allegro</words></direction-type></direction><note><rest/>'
        )
    );
    expect(withoutReviewAdditions(own)).toBe(own);
  });
});
