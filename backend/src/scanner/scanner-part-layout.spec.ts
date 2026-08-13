import { createHash } from 'node:crypto';
import { reconcileScannerPartLayout } from './scanner-part-layout';
import { validateScannerMusicXmlSemantics } from './scanner-musicxml-semantics';
import { matchScannerMusicXmlParts } from './scanner-part-matching';

/**
 * The grand-staff case: HOMR writes a piano as one part on two braced staves,
 * Transcoda writes it as two parts of one staff each. Both are right, and
 * nothing downstream could align them, so the comparison refused a page a
 * reader could see was the same music.
 */

const score = (partList: string, parts: string) => Buffer.from(`<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list>${partList}</part-list>
  ${parts}
</score-partwise>`);

const declaration = (id: string, name = '') =>
  `<score-part id="${id}"><part-name>${name}</part-name></score-part>`;

const note = (step: string, octave: number, duration = 4, extra = '') =>
  `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch>` +
  `<duration>${duration}</duration><type>quarter</type>${extra}</note>`;

/** One two-staff part, the way HOMR writes a keyboard page. */
const grandStaff = (measures = 1) =>
  score(
    declaration('P1', 'Piano'),
    `<part id="P1">${Array.from(
      { length: measures },
      (_unused, index) => `
      <measure number="${index + 1}">
        ${
          index === 0
            ? '<attributes><divisions>4</divisions><staves>2</staves><time><beats>2</beats>' +
              '<beat-type>4</beat-type></time><clef number="1"><sign>G</sign><line>2</line></clef>' +
              '<clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
            : ''
        }
        ${note('C', 5, 4, '<voice>1</voice><staff>1</staff>')}
        ${note('D', 5, 4, '<voice>1</voice><staff>1</staff>')}
        <backup><duration>8</duration></backup>
        ${note('C', 3, 4, '<voice>5</voice><staff>2</staff>')}
        ${note('G', 3, 4, '<voice>5</voice><staff>2</staff>')}
      </measure>`
    ).join('')}</part>`
  );

/** The same page as two single-staff parts, the way Transcoda writes it. */
const splitStaves = (measures = 1, options: { divisions?: [number, number] } = {}) => {
  const [upperDivisions, lowerDivisions] = options.divisions || [4, 4];
  const part = (id: string, divisions: number, sign: string, pitches: [string, number][]) =>
    `<part id="${id}">${Array.from(
      { length: measures },
      (_unused, index) => `
      <measure number="${index + 1}">
        ${
          index === 0
            ? `<attributes><divisions>${divisions}</divisions><time><beats>2</beats>` +
              `<beat-type>4</beat-type></time><clef><sign>${sign}</sign>` +
              `<line>${sign === 'G' ? 2 : 4}</line></clef></attributes>`
            : ''
        }
        ${pitches
          .map(([step, octave]) => note(step, octave, divisions))
          .join('')}
      </measure>`
    ).join('')}</part>`;
  return score(
    `${declaration('Pupper')}${declaration('Plower')}`,
    part('Pupper', upperDivisions, 'G', [
      ['C', 5],
      ['D', 5]
    ]) +
      part('Plower', lowerDivisions, 'F', [
        ['C', 3],
        ['G', 3]
      ])
  );
};

const reconcile = (base: Buffer, candidate: Buffer) =>
  reconcileScannerPartLayout({ baseXml: base, candidateXml: candidate });

describe('scanner part-layout reconciliation', () => {
  it('folds two single-staff parts onto one braced pair', () => {
    const result = reconcile(grandStaff(), splitStaves());

    expect(result.applied).toBe(true);
    expect(result.refusals).toEqual([]);
    const xml = result.musicXml.toString('utf8');
    // One part, on two staves, with each staff's own clef numbered.
    expect((xml.match(/<part id=/g) || []).length).toBe(1);
    expect((xml.match(/<score-part id=/g) || []).length).toBe(1);
    expect(xml).toContain('<staves>2</staves>');
    expect(xml).toContain('<clef number="1">');
    expect(xml).toContain('<clef number="2">');
    // The lower staff's notes are on staff 2 and in a voice of their own, so
    // the two hands are not merged into one line.
    expect(xml).toMatch(/<step>C<\/step>\s*<octave>3<\/octave>[\s\S]*?<voice>5<\/voice>/);
    expect(xml).toMatch(/<step>C<\/step>\s*<octave>5<\/octave>[\s\S]*?<voice>1<\/voice>/);
    // And the clock is returned to the top of the bar before they start.
    expect(xml).toContain('<backup>');
  });

  it('produces a document that is still valid MusicXML', () => {
    const result = reconcile(grandStaff(2), splitStaves(2));

    expect(result.applied).toBe(true);
    expect(validateScannerMusicXmlSemantics(result.musicXml).violations).toEqual([]);
  });

  it('lets part matching allow a comparison it used to refuse', () => {
    // The whole point: before this, `staffCountEqual` was false for every pair
    // of parts, so no edge was eligible and the page refused outright.
    const base = grandStaff(2);
    const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    const before = matchScannerMusicXmlParts(
      { engineId: 'homr', artifactChecksumSha256: sha(base), musicXml: base },
      {
        engineId: 'transcoda',
        artifactChecksumSha256: sha(splitStaves(2)),
        musicXml: splitStaves(2)
      }
    );
    expect(before.comparisonAllowed).toBe(false);
    expect(before.refusalReasons[0]).toMatch(/no compatible candidate part/);

    const folded = reconcile(base, splitStaves(2));
    const after = matchScannerMusicXmlParts(
      { engineId: 'homr', artifactChecksumSha256: sha(base), musicXml: base },
      {
        engineId: 'transcoda',
        // The stored artifact stays the reading's identity; the folded bytes
        // are what was actually read, and are checked in their own right.
        artifactChecksumSha256: sha(splitStaves(2)),
        musicXml: folded.musicXml,
        contentChecksumSha256: folded.contentChecksumSha256
      }
    );
    expect(after.comparisonAllowed).toBe(true);
    expect(after.matches[0]).toMatchObject({
      outcome: 'matched',
      evidence: { staffCountEqual: true }
    });
  });

  it('leaves matching layouts alone', () => {
    const result = reconcile(grandStaff(), grandStaff());

    expect(result.applied).toBe(false);
    expect(result.note).toBeUndefined();
    expect(result.contentChecksumSha256).toBe(
      createHash('sha256').update(grandStaff()).digest('hex')
    );
  });

  it('does not fold parts that are not the same music', () => {
    // Three single-staff parts against one two-staff part is a disagreement
    // about the page, not about how to write a keyboard down, and folding two
    // of them would be picking which two by position.
    const candidate = score(
      `${declaration('Pa')}${declaration('Pb')}${declaration('Pc')}`,
      ['Pa', 'Pb', 'Pc']
        .map(
          (id) =>
            `<part id="${id}"><measure number="1"><attributes><divisions>4</divisions>` +
            `</attributes>${note('C', 4)}</measure></part>`
        )
        .join('')
    );
    const result = reconcile(grandStaff(), candidate);

    expect(result.applied).toBe(false);
    expect(result.refusals).toEqual([]);
  });

  it('refuses to fold parts that count time differently', () => {
    // Rewriting one staff into the other's divisions is a change to what it
    // says, and this operation exists precisely because nothing should be
    // guessed about the notes.
    const result = reconcile(grandStaff(), splitStaves(1, { divisions: [4, 8] }));

    expect(result.applied).toBe(false);
    expect(result.refusals).toEqual([
      { code: 'divisions-differ', detail: expect.stringContaining('count time differently') }
    ]);
  });

  it('refuses to fold parts of unequal length', () => {
    const upper = `<part id="Pupper"><measure number="1"><attributes><divisions>4</divisions>` +
      `</attributes>${note('C', 5)}</measure><measure number="2">${note('D', 5)}</measure></part>`;
    const lower = `<part id="Plower"><measure number="1"><attributes><divisions>4</divisions>` +
      `</attributes>${note('C', 3)}</measure></part>`;
    const result = reconcile(
      grandStaff(2),
      score(`${declaration('Pupper')}${declaration('Plower')}`, upper + lower)
    );

    expect(result.applied).toBe(false);
    expect(result.refusals[0].code).toBe('measure-count-differs');
  });

  it('never rewrites the base', () => {
    // A merged score is built on the base document, so reshaping it would
    // reshape the reviewer's output as a side effect of comparing.
    const base = grandStaff(2);
    const before = base.toString('utf8');
    reconcile(base, splitStaves(2));

    expect(base.toString('utf8')).toBe(before);
  });

  it('folds nothing when the base is the split one', () => {
    // Splitting a part would have to decide which staff every note belongs to,
    // and a cross-staff beam has no answer to that — so the reverse
    // arrangement is left for the refusal to explain.
    const result = reconcile(splitStaves(2), grandStaff(2));

    expect(result.applied).toBe(false);
    expect(result.refusals).toEqual([]);
  });
});
