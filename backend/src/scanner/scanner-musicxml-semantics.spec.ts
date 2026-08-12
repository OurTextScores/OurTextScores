import { validateScannerMusicXmlSemantics } from './scanner-musicxml-semantics';
import { assessScannerSplice, readScannerSpliceFacts } from './scanner-splice-safety';

/**
 * §11.3's post-splice half. `parseValidMusicXml` accepts every document here:
 * they are well-formed MusicXML that says something impossible.
 */

const part = (measures: string) => Buffer.from(`<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Cello</part-name></score-part></part-list>
  <part id="P1">${measures}</part>
</score-partwise>`);

const bar = (
  contents: string,
  options: { number?: string; time?: string; divisions?: number; implicit?: boolean } = {}
) => `
  <measure number="${options.number || '1'}"${options.implicit ? ' implicit="yes"' : ''}>
    ${
      options.divisions || options.time
        ? `<attributes>${
              options.divisions ? `<divisions>${options.divisions}</divisions>` : ''
          }${
              options.time
                ? `<time><beats>${options.time.split('/')[0]}</beats><beat-type>${
                      options.time.split('/')[1]
                  }</beat-type></time>`
                : ''
          }</attributes>`
        : ''
    }
    ${contents}
  </measure>`;

const note = (
  duration: number,
  options: { step?: string; voice?: string; tie?: string } = {}
) => `
  <note>
    <pitch><step>${options.step || 'C'}</step><octave>4</octave></pitch>
    <duration>${duration}</duration>
    <voice>${options.voice || '1'}</voice>
    ${options.tie ? `<tie type="${options.tie}"/><notations><tied type="${options.tie}"/></notations>` : ''}
  </note>`;

const codesOf = (musicXml: Buffer) =>
  validateScannerMusicXmlSemantics(musicXml).violations.map((violation) => violation.code);

describe('scanner MusicXML semantics', () => {
  it('accepts a well-formed bar', () => {
    const xml = part(bar(note(4) + note(4) + note(4) + note(4), { divisions: 4, time: '4/4' }));
    expect(validateScannerMusicXmlSemantics(xml)).toEqual({ valid: true, violations: [] });
  });

  it('accepts a tie that spans a bar line', () => {
    // The common case, and the reason ties are resolved across the part rather
    // than one measure at a time.
    const xml = part(
      bar(note(4) + note(4) + note(4) + note(4, { tie: 'start' }), {
        divisions: 4,
        time: '4/4'
      }) + bar(note(4, { tie: 'stop' }) + note(4) + note(4) + note(4), { number: '2' })
    );
    expect(validateScannerMusicXmlSemantics(xml).valid).toBe(true);
  });

  it('catches a tie that never ends', () => {
    // What a bad splice leaves behind: the bar carrying the stop was replaced.
    const xml = part(
      bar(note(4) + note(4) + note(4) + note(4, { tie: 'start' }), {
        divisions: 4,
        time: '4/4'
      }) + bar(note(4) + note(4) + note(4) + note(4), { number: '2' })
    );
    const report = validateScannerMusicXmlSemantics(xml);

    expect(report.valid).toBe(false);
    expect(report.violations[0].code).toBe('tie-unresolved');
    expect(report.violations[0].measureNumber).toBe('1');
    expect(report.violations[0].detail).toMatch(/never ends/);
  });

  it('catches a tie that ends without beginning', () => {
    const xml = part(
      bar(note(4) + note(4) + note(4) + note(4), { divisions: 4, time: '4/4' }) +
        bar(note(4, { tie: 'stop' }) + note(4) + note(4) + note(4), { number: '2' })
    );
    expect(codesOf(xml)).toEqual(['tie-unstarted']);
  });

  it('does not match a tie across a change of pitch or voice', () => {
    // A tie joins two noteheads of the same pitch. One that appears to close on
    // a different note has not closed at all.
    const xml = part(
      bar(note(4) + note(4) + note(4) + note(4, { tie: 'start' }), {
        divisions: 4,
        time: '4/4'
      }) + bar(note(4, { tie: 'stop', step: 'G' }) + note(4) + note(4) + note(4), { number: '2' })
    );
    const codes = codesOf(xml);

    expect(codes).toContain('tie-unstarted');
    expect(codes).toContain('tie-unresolved');
  });

  it('catches a bar that does not fill its time signature', () => {
    const xml = part(bar(note(4) + note(4) + note(4), { divisions: 4, time: '4/4' }));
    const report = validateScannerMusicXmlSemantics(xml);

    expect(report.violations[0].code).toBe('voice-underruns-bar');
    expect(report.violations[0].detail).toMatch(/12 against the 16/);
  });

  it('catches a bar that runs past its time signature', () => {
    const xml = part(
      bar(note(4) + note(4) + note(4) + note(4) + note(4), { divisions: 4, time: '4/4' })
    );
    expect(codesOf(xml)).toEqual(['voice-overruns-bar']);
  });

  it('exempts a bar that declares itself incomplete', () => {
    // A pickup, or a bar split across a system. Flagging these would be noise.
    const xml = part(bar(note(4), { divisions: 4, time: '4/4', implicit: true }));
    expect(validateScannerMusicXmlSemantics(xml).valid).toBe(true);
  });

  it('handles a time signature whose bar length is not a whole number of divisions', () => {
    // 6/8 at divisions 4 is 12 sixteenths — exact, because the multiplication
    // happens before the division. A naive `divisions * 4 / 8` would truncate.
    const sixEight = bar(note(2) + note(2) + note(2) + note(2) + note(2) + note(2), {
      divisions: 4,
      time: '6/8'
    });
    expect(validateScannerMusicXmlSemantics(part(sixEight)).valid).toBe(true);
  });

  it('measures each voice separately, not their sum', () => {
    const twoVoices =
      note(4, { voice: '1' }) +
      note(4, { voice: '1' }) +
      note(4, { voice: '1' }) +
      note(4, { voice: '1' }) +
      '<backup><duration>16</duration></backup>' +
      note(8, { voice: '2' }) +
      note(8, { voice: '2' });
    expect(
      validateScannerMusicXmlSemantics(part(bar(twoVoices, { divisions: 4, time: '4/4' }))).valid
    ).toBe(true);
  });

  it('names the voice that is short, not just the bar', () => {
    const shortSecondVoice =
      note(4, { voice: '1' }) +
      note(4, { voice: '1' }) +
      note(4, { voice: '1' }) +
      note(4, { voice: '1' }) +
      '<backup><duration>16</duration></backup>' +
      note(8, { voice: '2' });
    const report = validateScannerMusicXmlSemantics(
      part(bar(shortSecondVoice, { divisions: 4, time: '4/4' }))
    );

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].detail).toMatch(/Voice 2 falls short/);
  });

  it('catches a backup that reaches before the start of the bar', () => {
    const xml = part(
      bar(note(4) + '<backup><duration>16</duration></backup>' + note(16), {
        divisions: 4,
        time: '4/4'
      })
    );
    expect(codesOf(xml)).toContain('backup-before-bar-start');
  });

  it('says nothing about bar length when no time signature is in force', () => {
    // An engine that emitted no <time> has told us nothing to check against;
    // inventing 4/4 would flag every bar of a page in 3/4.
    const xml = part(bar(note(4) + note(4) + note(4), { divisions: 4 }));
    expect(validateScannerMusicXmlSemantics(xml).valid).toBe(true);
  });

  it('agrees with splice safety about the same bad splice', () => {
    // The two halves of §11.3 have to describe the same document. Splice safety
    // refuses before the fact; this catches it after, in case a decision route
    // ever performs one it should not have. A disagreement between them would
    // mean one of the two is wrong, and this is what would find it.
    const tied =
      bar(note(4) + note(4) + note(4) + note(4, { tie: 'start' }), {
        divisions: 4,
        time: '4/4'
      }) + bar(note(4, { tie: 'stop' }) + note(4) + note(4) + note(4), { number: '2' });
    const untiedFirstBar =
      bar(note(4) + note(4) + note(4) + note(4), { divisions: 4, time: '4/4' }) +
      bar(note(4, { tie: 'stop' }) + note(4) + note(4) + note(4), { number: '2' });

    const refusal = assessScannerSplice({
      base: readScannerSpliceFacts(part(tied)),
      candidate: readScannerSpliceFacts(part(untiedFirstBar)),
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: [0],
      candidateMeasureIndexes: [0]
    });
    expect(refusal.safe).toBe(false);
    expect(refusal.refusals[0].code).toBe('tie-crosses-boundary');

    // And the document that splice would have produced does not validate.
    const report = validateScannerMusicXmlSemantics(part(untiedFirstBar));
    expect(report.valid).toBe(false);
    expect(report.violations[0].code).toBe('tie-unstarted');
  });
});
