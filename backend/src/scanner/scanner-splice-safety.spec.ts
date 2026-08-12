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

/** A three-measure part, so a deletion has bars on both sides of it. */
const threeBars = (first: string, second: string, third: string, divisions = 8) => `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Cello</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1"><attributes><divisions>${divisions}</divisions></attributes>${first}</measure>
    <measure number="2">${second}</measure>
    <measure number="3">${third}</measure>
  </part>
</score-partwise>`;

/** A two-measure part, so an edge has a neighbour to meet. */
const twoBars = (first: string, second: string, divisions = 8) => `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Cello</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1"><attributes><divisions>${divisions}</divisions></attributes>${first}</measure>
    <measure number="2">${second}</measure>
  </part>
</score-partwise>`;

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
  options: {
    voice?: string;
    staff?: string;
    tie?: string;
    slur?: string;
    chord?: boolean;
    step?: string;
  } = {}
) => `
  <note>
    ${options.chord ? '<chord/>' : ''}
    <pitch><step>${options.step || 'C'}</step><octave>4</octave></pitch>
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
    expect(assess(base, candidate)).toEqual({ safe: true, refusals: [], repairs: [] });
  });

  it('allows differing divisions when the conversion is exact', () => {
    // The real Bach pair: HOMR reads in divisions 4, Transcoda in 10080, and
    // the bars are the same four quarter notes. Refusing this — as a literal
    // reading of "refuse anything needing transformation" does — refuses every
    // cross-engine decision on the corpus this feature exists for. Measured
    // against the retained page before it was changed.
    const base = score(note(4) + note(4), 4);
    const candidate = score(note(10080) + note(10080), 10080);
    expect(assess(base, candidate)).toEqual({ safe: true, refusals: [], repairs: [] });
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
    expect(assess(base, candidate)).toEqual({ safe: true, refusals: [], repairs: [] });
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

  it('lets a tie through when the replacement continues the same note', () => {
    // A tie says two noteheads are one sounding note. If the bar being spliced
    // in ends on the pitch the next bar continues, nothing is severed and there
    // is nothing to repair.
    const withTie = twoBars(note(8) + note(8, { tie: 'start' }), note(8, { tie: 'stop' }) + note(8));
    const result = assess(withTie, withTie, [0]);

    expect(result.safe).toBe(true);
    expect(result.repairs).toEqual([]);
  });

  it('refuses when the replacement does not carry the tied note across', () => {
    const base = twoBars(note(8) + note(8, { tie: 'start' }), note(8, { tie: 'stop' }) + note(8));
    // The candidate's first bar ends untied, so the base's second bar is left
    // with a tie stop that has nothing to join.
    const candidate = twoBars(note(8) + note(8), note(8, { tie: 'stop' }) + note(8));
    const result = assess(base, candidate, [0]);

    expect(codesOf(result)).toContain('tie-crosses-boundary');
    expect(result.refusals[0].detail).toMatch(/one sounding note/);
  });

  it('refuses when the tie would join two different pitches', () => {
    // The check is by pitch, not by count: a tie between C4 and G4 is not a
    // tie, and repairing it would mean changing a note.
    const base = twoBars(note(8) + note(8, { tie: 'start' }), note(8, { tie: 'stop' }) + note(8));
    const candidate = twoBars(
      note(8) + note(8, { tie: 'start', step: 'G' }),
      note(8, { tie: 'stop', step: 'G' }) + note(8)
    );
    const result = assess(base, candidate, [0]);

    expect(codesOf(result)).toContain('tie-crosses-boundary');
  });

  it('allows a tie that opens and closes inside the passage', () => {
    // Self-contained: nothing outside the span depends on it.
    const contained = note(4, { tie: 'start' }) + note(4, { tie: 'stop' });
    expect(assess(score(contained, 4), score(contained, 4))).toEqual({
      safe: true,
      refusals: [],
      repairs: []
    });
  });

  it('repairs a severed slur rather than refusing it', () => {
    // A slur is a marking about the notes, not part of what a note is, so the
    // cost of severing one is a lost phrase mark — and OMR slur detection is
    // the least reliable thing either engine produces.
    const base = twoBars(note(8) + note(8, { slur: 'start' }), note(8, { slur: 'stop' }) + note(8));
    const candidate = twoBars(note(8) + note(8), note(8, { slur: 'stop' }) + note(8));
    const result = assess(base, candidate, [0]);

    expect(result.safe).toBe(true);
    expect(result.refusals).toEqual([]);
    expect(result.repairs.map((repair) => repair.code)).toEqual(['drop-dangling-slur']);
    expect(result.repairs[0].detail).toMatch(/no note changes/);
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

  it('allows a deletion when the bars it joins agree', () => {
    // Two of the three blocks on the real Bach page are this shape — measures
    // only one engine read. A deletion converts nothing, so length and
    // divisions are irrelevant to it; what matters is the join it creates.
    const three = threeBars(note(8) + note(8), note(8) + note(8), note(8) + note(8));
    const result = assessScannerSplice({
      base: factsFor(three),
      candidate: factsFor(three),
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: [1],
      candidateMeasureIndexes: []
    });

    expect(result).toEqual({ safe: true, refusals: [], repairs: [] });
  });

  it('refuses a deletion that would strand a tie across the new join', () => {
    // Bar 1 ties into bar 2. Removing bar 2 puts bar 1 next to bar 3, which
    // expects nothing — the tie would have one end.
    const three = threeBars(
      note(8) + note(8, { tie: 'start' }),
      note(8, { tie: 'stop' }) + note(8),
      note(8) + note(8)
    );
    const result = assessScannerSplice({
      base: factsFor(three),
      candidate: factsFor(three),
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: [1],
      candidateMeasureIndexes: []
    });

    expect(codesOf(result)).toContain('joins-severed-tie');
  });

  it('allows an insertion, and repairs a slur the join breaks', () => {
    const base = threeBars(
      note(8) + note(8, { slur: 'start' }),
      note(8, { slur: 'stop' }) + note(8),
      note(8) + note(8)
    );
    const candidate = threeBars(note(8) + note(8), note(8) + note(8), note(8) + note(8));
    const result = assessScannerSplice({
      base: factsFor(base),
      candidate: factsFor(candidate),
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: [],
      candidateMeasureIndexes: [1],
      // Between the base's first and second bars — where the slur runs.
      baseAnchorIndex: 0
    });

    expect(result.safe).toBe(true);
    expect(result.repairs.map((repair) => repair.code)).toEqual(['drop-dangling-slur']);
  });

  it('does not judge a structural change on length or divisions', () => {
    // The first version of this refused every one-sided block outright, which
    // refused two of the three real ones for reasons that do not apply: nothing
    // is being converted, so nothing has to convert exactly.
    const base = threeBars(note(8) + note(8), note(8) + note(8), note(8) + note(8));
    const candidate = threeBars(
      note(10080) + note(10080) + note(10080),
      note(10080),
      note(10080),
      10080
    );
    const result = assessScannerSplice({
      base: factsFor(base),
      candidate: factsFor(candidate),
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: [],
      candidateMeasureIndexes: [1],
      baseAnchorIndex: 0
    });

    expect(codesOf(result)).not.toContain('divisions-incommensurable');
    expect(codesOf(result)).not.toContain('duration-differs');
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
    // A reviewer told "the lengths differ", who fixes that, should not then be
    // told about the tie. Refusals are information, so give all of it.
    const base = twoBars(note(8) + note(8, { tie: 'start' }), note(8, { tie: 'stop' }) + note(8));
    const candidate = twoBars(note(8) + note(8) + note(8), note(8) + note(8));
    const result = assess(base, candidate, [0]);

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
