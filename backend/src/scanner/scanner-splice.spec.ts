import { spliceScannerMeasures } from './scanner-splice';
import { readScannerSpliceFacts } from './scanner-splice-safety';
import { validateScannerMusicXmlSemantics } from './scanner-musicxml-semantics';
import {
  identityMeasureMap,
  resolveMergedIndexes,
  withRemovedMeasures
} from './scanner-merged-measure-map';

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
  it('blames a splice for what it broke, not for what it found broken', () => {
    // A recognition engine's reading is often already malformed somewhere, and
    // the merged score starts as a copy of one. Validating only the result
    // refused every take on such a page: on Klengel, bars 1, 19 and 23 do not
    // match the time signature in either reading, and no decision about bar 5
    // could be made because of it.
    const malformed = part(
      bar(note(4) + note(4), { attributes: '<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' }) +
        bar(note(4) + note(4) + note(4) + note(4), { number: '2' })
    );
    const replacement = part(
      bar(note(4) + note(4), { attributes: '<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' }) +
        bar(note(2) + note(2) + note(4) + note(4) + note(4), { number: '2' })
    );

    // Bar 1 is short in both, and that is not this splice's doing.
    expect(validateScannerMusicXmlSemantics(malformed).valid).toBe(false);
    const outcome = spliceScannerMeasures({
      baseXml: malformed,
      candidateXml: replacement,
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: [1],
      candidateMeasureIndexes: [1]
    });

    expect(outcome.refusals).toEqual([]);
    expect(outcome.violations).toEqual([]);
    expect(outcome.musicXml).not.toBeNull();
  });

  it('takes a passage of a different length, and leaves the bar marked', () => {
    // The length difference is a symptom of the bad reading, not a reason to
    // keep it: a reviewer looking at the scan can see that one engine read the
    // notes and the other did not. Shifting everything after it in the part
    // would be worse than the over-full bar, because it moves music nobody
    // asked to move. The bar arrives marked, and the merged pane offers to set
    // it back to its time signature.
    const base = part(bar(note(4) + note(4) + note(4) + note(4), { attributes: '<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' }));
    const longer = part(
      bar(note(4) + note(4) + note(4) + note(4) + note(4), { attributes: '<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' })
    );

    const taken = spliceScannerMeasures({
      baseXml: base,
      candidateXml: longer,
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: [0],
      candidateMeasureIndexes: [0]
    });

    expect(taken.musicXml).not.toBeNull();
    expect(taken.refusals).toEqual([]);
    // What it did is still recorded — the reviewer is told the bar is now a
    // different length, and where to fix it.
    expect(taken.repairs.map((repair) => repair.code)).toContain('taken-anyway');
    expect(taken.repairs.map((repair) => repair.detail).join(' ')).toContain('different lengths');
    expect(taken.repairs.map((repair) => repair.detail).join(' ')).toContain('marked');
    // The fifth note is really there: the notes were taken, not approximated.
    expect(taken.musicXml!.toString('utf8').match(/<note>/g)).toHaveLength(5);
  });

  it('confines the length change to the passage it was asked about', () => {
    // The replaced bar is allowed to be the wrong length; the rest of the part
    // is not. A splice that broke a bar it was not asked to touch still refuses.
    const base = part(bar(note(4) + note(4) + note(4) + note(4), { attributes: '<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' }));
    const longer = part(
      bar(note(4) + note(4) + note(4) + note(4) + note(4), { attributes: '<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' })
    );
    const taken = spliceScannerMeasures({
      baseXml: base,
      candidateXml: longer,
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: [0],
      candidateMeasureIndexes: [0]
    });
    // The one bar it was asked about is allowed to be the wrong length.
    expect(validateScannerMusicXmlSemantics(taken.musicXml!).violations).toHaveLength(1);
    expect(taken.violations).toEqual([]);
  });

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
    // Not a length difference, which is now a bar to correct rather than a
    // refusal. This is a passage whose time units cannot be written in the
    // other reading's without rounding some note to a length it never had.
    const base = part(bar(fullBar(4), { attributes: attributes(4) }));
    // Same musical length, but written in thirds of a quarter: the smallest
    // unit here cannot be expressed in the base reading's quarters.
    const candidate = part(
      bar(Array.from({ length: 12 }, () => note(1, { step: 'G' })).join(''), {
        attributes: attributes(3)
      })
    );
    const result = splice(base, candidate, [0]);

    expect(result.musicXml).toBeNull();
    expect(result.refusals.map((refusal) => refusal.code)).toContain(
      'divisions-incommensurable'
    );
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


  it('lands on the right bar after an earlier decision changed the length', () => {
    // The composition the measure map exists for, and the one a reviewer
    // reaches without being told it is special: delete a bar the other reading
    // does not have, then take a later bar. The engine still calls that bar 2;
    // the merged score now keeps it at 1, and without the map the take would
    // hit the untouched bar beside it and look like it had worked.
    const base = part(
      bar(fullBar(4), { attributes: attributes(4) }) +
        bar(fullBar(4), { number: '2' }) +
        bar(fullBar(4), { number: '3' }) +
        bar(fullBar(4), { number: '4' })
    );
    const candidate = part(
      bar(fullBar(4), { attributes: attributes(4) }) +
        bar(fullBar(4, 'G'), { number: '2' }) +
        bar(fullBar(4), { number: '3' })
    );

    let map = identityMeasureMap(4);
    const deletion = spliceScannerMeasures({
      baseXml: base,
      candidateXml: candidate,
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: resolveMergedIndexes(map, [1])!,
      candidateMeasureIndexes: []
    });
    expect(deletion.musicXml).not.toBeNull();
    map = withRemovedMeasures(map, [1]);
    expect(map).toEqual([0, 2, 3]);

    const positions = resolveMergedIndexes(map, [2])!;
    expect(positions).toEqual([1]);
    const take = spliceScannerMeasures({
      baseXml: deletion.musicXml!,
      candidateXml: candidate,
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: positions,
      candidateMeasureIndexes: [1]
    });

    expect(take.musicXml).not.toBeNull();
    const bars = take.musicXml!.toString('utf8').split('<measure').slice(1);
    expect(bars).toHaveLength(3);
    // The G landed in the second bar, which is where engine bar 2 now lives.
    expect(bars[1]).toContain('<step>G</step>');
    expect(bars[0]).not.toContain('<step>G</step>');
    expect(bars[2]).not.toContain('<step>G</step>');
    expect(validateScannerMusicXmlSemantics(take.musicXml!).valid).toBe(true);
  });
});
