import { spliceScannerMeasures } from './scanner-splice';
import { readScannerSpliceFacts } from './scanner-splice-safety';
import { validateScannerMusicXmlSemantics } from './scanner-musicxml-semantics';

/**
 * S3's take-bar operation. §5.2 recommends rebuilding from the aligned measure
 * sequence rather than inventing a patch format; this is the single-block form
 * of that, and it refuses before acting and validates after.
 */

const part = (measures: string) => Buffer.from(`<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Cello</part-name></score-part></part-list>
  <part id="P1">${measures}</part>
</score-partwise>`);

const bar = (
  contents: string,
  options: { number?: string; attributes?: string } = {}
) => `
  <measure number="${options.number || '1'}">
    ${options.attributes || ''}
    ${contents}
  </measure>`;

const attributes = (divisions: number, extra = '') =>
  `<attributes><divisions>${divisions}</divisions><time><beats>4</beats><beat-type>4</beat-type></time>${extra}</attributes>`;

const note = (duration: number, options: { step?: string; slur?: string } = {}) => `
  <note>
    <pitch><step>${options.step || 'C'}</step><octave>4</octave></pitch>
    <duration>${duration}</duration>
    <voice>1</voice>
    ${options.slur ? `<notations><slur number="1" type="${options.slur}"/></notations>` : ''}
  </note>`;

/** Four quarter notes, in whatever `divisions` the caller is working in. */
const fullBar = (unit: number, step = 'C') =>
  note(unit, { step }) + note(unit, { step }) + note(unit, { step }) + note(unit, { step });

const splice = (
  baseXml: Buffer,
  candidateXml: Buffer,
  baseMeasureIndexes: number[],
  candidateMeasureIndexes = baseMeasureIndexes
) =>
  spliceScannerMeasures({
    baseXml,
    candidateXml,
    basePartIndex: 0,
    candidatePartIndex: 0,
    baseMeasureIndexes,
    candidateMeasureIndexes
  });

describe('scanner splice', () => {
  it('replaces a bar and leaves the rest of the part alone', () => {
    const base = part(
      bar(fullBar(4), { attributes: attributes(4) }) + bar(fullBar(4), { number: '2' })
    );
    const candidate = part(
      bar(fullBar(4, 'G'), { attributes: attributes(4) }) + bar(fullBar(4, 'G'), { number: '2' })
    );
    const result = splice(base, candidate, [0]);

    expect(result.refusals).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.musicXml).not.toBeNull();
    const xml = result.musicXml!.toString('utf8');
    // Bar 1 became the candidate's; bar 2 is untouched.
    expect(xml.split('<measure')[1]).toContain('<step>G</step>');
    expect(xml.split('<measure')[2]).toContain('<step>C</step>');
  });

  it('keeps the base declaration the rest of the document depends on', () => {
    // The bug real data found and a fixture would not have: an engine declares
    // `divisions` once, in bar 1. Replacing bar 1 deleted that declaration for
    // the whole part, every later bar fell back to MusicXML's default of 1, and
    // the document silently became nonsense (design §5.2 — attributes live
    // *inside* measures).
    const base = part(
      bar(fullBar(4), { attributes: attributes(4) }) +
        bar(fullBar(4), { number: '2' }) +
        bar(fullBar(4), { number: '3' })
    );
    const candidate = part(
      bar(fullBar(10080, 'G'), { attributes: attributes(10080) }) +
        bar(fullBar(10080), { number: '2' }) +
        bar(fullBar(10080), { number: '3' })
    );
    const result = splice(base, candidate, [0]);

    expect(result.musicXml).not.toBeNull();
    const xml = result.musicXml!.toString('utf8');
    expect(xml).toContain('<divisions>4</divisions>');
    expect(xml).not.toContain('10080');
    // And every bar still measures against the time signature.
    expect(validateScannerMusicXmlSemantics(result.musicXml!).valid).toBe(true);
    const facts = readScannerSpliceFacts(result.musicXml!)[0].measures;
    expect(facts.map((measure) => `${measure.duration}@${measure.divisions}`)).toEqual([
      '16@4',
      '16@4',
      '16@4'
    ]);
  });

  it('rewrites the replacement into the base time units exactly', () => {
    const base = part(bar(fullBar(4), { attributes: attributes(4) }));
    const candidate = part(bar(fullBar(10080, 'G'), { attributes: attributes(10080) }));
    const result = splice(base, candidate, [0]);

    const facts = readScannerSpliceFacts(result.musicXml!)[0].measures[0];
    expect(facts.duration).toBe('16');
    expect(facts.divisions).toBe('4');
    expect(result.musicXml!.toString('utf8')).toContain('<step>G</step>');
  });

  it('takes a clef or key the replacement declares, since that is its reading', () => {
    const base = part(bar(fullBar(4), { attributes: attributes(4) }));
    const candidate = part(
      bar(fullBar(4, 'G'), {
        attributes: attributes(4, '<clef><sign>F</sign><line>4</line></clef>')
      })
    );
    const result = splice(base, candidate, [0]);

    const xml = result.musicXml!.toString('utf8');
    expect(xml).toContain('<sign>F</sign>');
    // …while divisions still comes from the base.
    expect(xml).toContain('<divisions>4</divisions>');
  });

  it('drops a slur the replacement orphaned, and says so', () => {
    // The orphan is in a bar that was *not* replaced, which is why the repair
    // resolves over the whole part rather than the spliced span.
    const base = part(
      bar(note(4) + note(4) + note(4) + note(4, { slur: 'start' }), {
        attributes: attributes(4)
      }) + bar(note(4, { slur: 'stop' }) + note(4) + note(4) + note(4), { number: '2' })
    );
    const candidate = part(
      bar(fullBar(4, 'G'), { attributes: attributes(4) }) +
        bar(note(4, { slur: 'stop' }) + note(4) + note(4) + note(4), { number: '2' })
    );
    const result = splice(base, candidate, [0]);

    expect(result.musicXml).not.toBeNull();
    expect(result.repairs.map((repair) => repair.code)).toContain('drop-dangling-slur');
    // Nothing is left pointing at a slur that no longer exists.
    expect(result.musicXml!.toString('utf8')).not.toContain('<slur');
  });

  it('produces nothing when the passage cannot be moved', () => {
    const base = part(bar(fullBar(4), { attributes: attributes(4) }));
    const candidate = part(
      bar(fullBar(4, 'G') + note(4, { step: 'G' }), { attributes: attributes(4) })
    );
    const result = splice(base, candidate, [0]);

    expect(result.musicXml).toBeNull();
    expect(result.refusals.map((refusal) => refusal.code)).toContain('duration-differs');
  });

  it('keeps the base numbering, because every reference counts from it', () => {
    const base = part(
      bar(fullBar(4), { number: '5', attributes: attributes(4) }) +
        bar(fullBar(4), { number: '6' })
    );
    const candidate = part(
      bar(fullBar(4, 'G'), { number: '1', attributes: attributes(4) }) +
        bar(fullBar(4, 'G'), { number: '2' })
    );
    const result = splice(base, candidate, [0]);

    const xml = result.musicXml!.toString('utf8');
    expect(xml).toContain('number="5"');
    expect(xml).not.toContain('number="1"');
  });

  it('returns the replacement wholesale when every bar is taken', () => {
    // §5.2's degenerate case: accept everything from one side and you get that
    // side's content back — in the base's time units, which is the part the
    // design had to correct itself about.
    const base = part(
      bar(fullBar(4), { attributes: attributes(4) }) + bar(fullBar(4), { number: '2' })
    );
    const candidate = part(
      bar(fullBar(10080, 'G'), { attributes: attributes(10080) }) +
        bar(fullBar(10080, 'G'), { number: '2' })
    );
    const result = splice(base, candidate, [0, 1]);

    const xml = result.musicXml!.toString('utf8');
    expect(xml).not.toContain('<step>C</step>');
    expect((xml.match(/<step>G<\/step>/g) || []).length).toBe(8);
    expect(validateScannerMusicXmlSemantics(result.musicXml!).valid).toBe(true);
  });

  it('deletes a bar the other reading does not have, and renumbers', () => {
    // Two of the three blocks on the real Bach page are this shape. Bars 1..3
    // become 1..2, and the labels have to follow or a reader counts wrong.
    const base = part(
      bar(fullBar(4), { attributes: attributes(4) }) +
        bar(fullBar(4, 'G'), { number: '2' }) +
        bar(fullBar(4), { number: '3' })
    );
    const result = spliceScannerMeasures({
      baseXml: base,
      candidateXml: base,
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: [1],
      candidateMeasureIndexes: []
    });

    expect(result.musicXml).not.toBeNull();
    const facts = readScannerSpliceFacts(result.musicXml!)[0].measures;
    expect(facts).toHaveLength(2);
    expect(facts.map((measure) => measure.measureNumber)).toEqual(['1', '2']);
    // The G bar is the one that went.
    expect(result.musicXml!.toString('utf8')).not.toContain('<step>G</step>');
    expect(validateScannerMusicXmlSemantics(result.musicXml!).valid).toBe(true);
  });

  it('inserts a bar the base never read, after the bar it belongs behind', () => {
    const base = part(
      bar(fullBar(4), { attributes: attributes(4) }) + bar(fullBar(4), { number: '2' })
    );
    const candidate = part(
      bar(fullBar(10080), { attributes: attributes(10080) }) +
        bar(fullBar(10080, 'G'), { number: '2' }) +
        bar(fullBar(10080), { number: '3' })
    );
    const result = spliceScannerMeasures({
      baseXml: base,
      candidateXml: candidate,
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: [],
      candidateMeasureIndexes: [1],
      baseAnchorIndex: 0
    });

    expect(result.musicXml).not.toBeNull();
    const facts = readScannerSpliceFacts(result.musicXml!)[0].measures;
    expect(facts).toHaveLength(3);
    expect(facts.map((measure) => measure.measureNumber)).toEqual(['1', '2', '3']);
    // Written in the base's time units, not its own.
    expect(facts.map((measure) => `${measure.duration}@${measure.divisions}`)).toEqual([
      '16@4',
      '16@4',
      '16@4'
    ]);
    expect(result.musicXml!.toString('utf8')).not.toContain('10080');
    // It landed second, after the bar it was anchored behind.
    expect(result.musicXml!.toString('utf8').split('<measure')[2]).toContain('<step>G</step>');
    expect(validateScannerMusicXmlSemantics(result.musicXml!).valid).toBe(true);
  });

  it('inserts before the first bar when it belongs at the start', () => {
    const base = part(bar(fullBar(4), { attributes: attributes(4) }));
    const candidate = part(
      bar(fullBar(4, 'G'), { attributes: attributes(4) }) + bar(fullBar(4), { number: '2' })
    );
    const result = spliceScannerMeasures({
      baseXml: base,
      candidateXml: candidate,
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: [],
      candidateMeasureIndexes: [0],
      baseAnchorIndex: -1
    });

    const xml = result.musicXml!.toString('utf8');
    expect(xml.split('<measure')[1]).toContain('<step>G</step>');
    expect(readScannerSpliceFacts(result.musicXml!)[0].measures).toHaveLength(2);
  });

});
