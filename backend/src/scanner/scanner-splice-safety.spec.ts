import {
  assessScannerSplice,
  readScannerSpliceFacts,
  type ScannerSpliceAssessment,
  type ScannerSplicePartFacts
} from './scanner-splice-safety';

/**
 * §11.3's gate. A block decision is a merge, not a selection, and these are the
 * ways music makes that merge unsafe in a way a text merge never is. The
 * contract is refusal, not repair: the design offers a canonical event
 * representation or "refuse any cross-engine measure that would require
 * transformation", and this is the second.
 */

const score = (measures: string, divisions = 4, partId = 'P1') => `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="${partId}"><part-name>Cello</part-name></score-part></part-list>
  <part id="${partId}">
    <measure number="1">
      <attributes><divisions>${divisions}</divisions></attributes>
      ${measures}
    </measure>
  </part>
</score-partwise>`;

/** One quarter note in `divisions`, optionally carrying tie/slur markup. */
const note = (
  divisions: number,
  options: { voice?: string; staff?: string; tie?: string; slur?: string; chord?: boolean } = {}
) => `
  <note>
    ${options.chord ? '<chord/>' : ''}
    <pitch><step>C</step><octave>4</octave></pitch>
    <duration>${divisions}</duration>
    <voice>${options.voice || '1'}</voice>
    <staff>${options.staff || '1'}</staff>
    ${options.tie ? `<tie type="${options.tie}"/>` : ''}
    ${
      options.tie || options.slur
        ? `<notations>${options.tie ? `<tied type="${options.tie}"/>` : ''}${
              options.slur ? `<slur number="1" type="${options.slur}"/>` : ''
          }</notations>`
        : ''
    }
  </note>`;

const factsFor = (xml: string): ScannerSplicePartFacts[] =>
  readScannerSpliceFacts(Buffer.from(xml));

const codesOf = (result: ScannerSpliceAssessment): string[] =>
  result.refusals.map((refusal) => refusal.code);

const assess = (baseXml: string, candidateXml: string, indexes = [0]) =>
  assessScannerSplice({
    base: factsFor(baseXml),
    candidate: factsFor(candidateXml),
    basePartIndex: 0,
    candidatePartIndex: 0,
    baseMeasureIndexes: indexes,
    candidateMeasureIndexes: indexes
  });

describe('scanner splice safety', () => {
  it('allows a splice when the two readings agree on shape', () => {
    const base = score(note(4) + note(4), 4);
    const candidate = score(note(4) + note(4), 4);
    expect(assess(base, candidate)).toEqual({ safe: true, refusals: [] });
  });

  it('allows differing divisions when the conversion is exact', () => {
    // The real Bach pair: HOMR reads in divisions 4, Transcoda in 10080, and
    // the bars are the same four quarter notes. Refusing this — as a literal
    // reading of "refuse anything needing transformation" does — refuses every
    // cross-engine decision on the corpus this feature exists for. Measured
    // against the retained page before it was changed.
    const base = score(note(4) + note(4), 4);
    const candidate = score(note(10080) + note(10080), 10080);
    expect(assess(base, candidate)).toEqual({ safe: true, refusals: [] });
  });

  it('refuses when the conversion would have to round', () => {
    // A demisemiquaver at divisions 10080 is 630, and 630 * 4 / 10080 is not a
    // whole number: the base document literally cannot express it. This is the
    // case §5.2 was protecting against, and it still refuses.
    const base = score(note(4) + note(4), 4);
    const candidate = score(
      note(630) + note(630) + note(630) + note(630) +
      note(630) + note(630) + note(630) + note(630) +
      note(10080) + note(10080) + note(10080),
      10080
    );
    const result = assess(base, candidate);

    expect(codesOf(result)).toContain('divisions-incommensurable');
    expect(result.refusals[0].detail).toMatch(/rounding/);
  });

  it('refuses when the replacement is a different length', () => {
    const base = score(note(4) + note(4), 4);
    const candidate = score(note(4) + note(4) + note(4), 4);
    const result = assess(base, candidate);

    expect(codesOf(result)).toContain('duration-differs');
  });

  it('does not count a chord member twice', () => {
    // A chord sounds with the note before it. Counting it would make the bar
    // look longer than it is and refuse a splice that is perfectly safe.
    const base = score(note(4) + note(4, { chord: true }) + note(4), 4);
    const candidate = score(note(4) + note(4), 4);
    expect(assess(base, candidate)).toEqual({ safe: true, refusals: [] });
  });

  it('measures parallel voices by the longest, not the sum', () => {
    // Two voices each filling the bar is one bar long, not two. Summing them
    // would refuse every multi-voice passage in the corpus.
    const twoVoices =
      note(4, { voice: '1' }) +
      note(4, { voice: '1' }) +
      '<backup><duration>8</duration></backup>' +
      note(4, { voice: '2' }) +
      note(4, { voice: '2' });
    const facts = factsFor(score(twoVoices, 4));
    expect(facts[0].measures[0].duration).toBe('8');
    expect(facts[0].measures[0].voices).toEqual(['1', '2']);
  });

  it('refuses when a tie runs out of the passage', () => {
    // A measure is not independent of its neighbours. Severing a tie emits a
    // document that looks plausible and is wrong.
    const base = score(note(4) + note(4, { tie: 'start' }), 4);
    const candidate = score(note(4) + note(4), 4);
    const result = assess(base, candidate);

    expect(codesOf(result)).toContain('tie-crosses-boundary');
  });

  it('refuses when a tie runs into the passage from before it', () => {
    const base = score(note(4, { tie: 'stop' }) + note(4), 4);
    const candidate = score(note(4) + note(4), 4);
    const result = assess(base, candidate);

    expect(codesOf(result)).toContain('tie-crosses-boundary');
  });

  it('allows a tie that opens and closes inside the passage', () => {
    // Self-contained: nothing outside the span depends on it.
    const contained = note(4, { tie: 'start' }) + note(4, { tie: 'stop' });
    expect(assess(score(contained, 4), score(contained, 4))).toEqual({ safe: true, refusals: [] });
  });

  it('refuses a slur that crosses the boundary, like a tie', () => {
    const base = score(note(4) + note(4, { slur: 'start' }), 4);
    const candidate = score(note(4) + note(4), 4);
    const result = assess(base, candidate);

    expect(codesOf(result)).toContain('slur-crosses-boundary');
  });

  it('refuses when the passage does not have the same voices on both sides', () => {
    const base = score(
      note(4, { voice: '1' }) +
        note(4, { voice: '1' }) +
        '<backup><duration>8</duration></backup>' +
        note(8, { voice: '2' }),
      4
    );
    const candidate = score(note(4, { voice: '1' }) + note(4, { voice: '1' }), 4);
    const result = assess(base, candidate);

    expect(codesOf(result)).toContain('voices-differ');
  });

  it('refuses a decision that names measures one reading does not have', () => {
    const base = score(note(4) + note(4), 4);
    const result = assess(base, base, [0, 1]);

    expect(result.refusals[0].code).toBe('span-missing');
  });

  it('refuses a one-sided block, which is an insertion, not a replacement', () => {
    // The Bach page has two of these: measures only one engine read. Taking
    // them changes how many bars the part has, and every later bar with it —
    // a different decision from taking a bar, and not one offered yet.
    const base = score(note(4) + note(4), 4);
    const result = assessScannerSplice({
      base: factsFor(base),
      candidate: factsFor(base),
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: [0],
      candidateMeasureIndexes: []
    });

    expect(result.refusals[0].code).toBe('span-empty');
    expect(result.refusals[0].detail).toMatch(/insertion or a deletion/);
  });

  it('compares lengths in a shared unit, not raw counts', () => {
    // Two bars against three, in different divisions: without normalising, the
    // raw totals would happen to disagree for the wrong reason, or agree for it.
    const base = score(note(4) + note(4), 4);
    const candidate = score(note(10080) + note(10080) + note(10080), 10080);
    const result = assess(base, candidate);

    expect(codesOf(result)).toContain('duration-differs');
    // Exactly convertible, so that is not the complaint.
    expect(codesOf(result)).not.toContain('divisions-incommensurable');
  });

  it('reports every reason at once rather than the first', () => {
    // A reviewer told "the divisions differ", who fixes that, should not then
    // be told about the tie. Refusals are information, so give all of it.
    const base = score(note(4) + note(4, { tie: 'start' }), 4);
    const candidate = score(note(10080) + note(10080) + note(10080), 10080);
    const result = assess(base, candidate);

    const codes = codesOf(result);
    expect(codes).toContain('duration-differs');
    expect(codes).toContain('tie-crosses-boundary');
  });

  it('carries divisions forward between measures, as MusicXML does', () => {
    const twoMeasures = `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Cello</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1"><attributes><divisions>8</divisions></attributes>${note(8)}</measure>
    <measure number="2">${note(8)}</measure>
  </part>
</score-partwise>`;
    const facts = factsFor(twoMeasures);
    // The second measure declares nothing; it is still in eighths.
    expect(facts[0].measures.map((measure) => measure.divisions)).toEqual(['8', '8']);
  });
});
