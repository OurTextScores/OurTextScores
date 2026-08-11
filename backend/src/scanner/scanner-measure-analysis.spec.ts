import {
  alignScannerMeasureKeys,
  alignScannerMeasures,
  classifyScannerMeasureDifference,
  describeScannerMusicXmlMeasures,
  MAX_SCANNER_MEASURES_PER_PART,
  SCANNER_COARSE_MEASURE_KEY_VERSION,
  SCANNER_MEASURE_DESCRIPTOR_VERSION
} from './scanner-measure-analysis';

function score(measures: string, partId = 'P1'): Buffer {
  return Buffer.from(
    `<score-partwise><part-list><score-part id="${partId}"><part-name>Music</part-name></score-part></part-list><part id="${partId}">${measures}</part></score-partwise>`
  );
}

const measure = (body: string, number = '1') => `<measure number="${number}">${body}</measure>`;

const pitch = (step: string, octave = 4) =>
  `<pitch><step>${step}</step><octave>${octave}</octave></pitch>`;

const note = (options: {
  step?: string;
  duration?: number;
  voice?: number;
  staff?: number;
  chord?: boolean;
  extra?: string;
}) =>
  `<note>${options.chord ? '<chord/>' : ''}${
    options.step ? pitch(options.step) : '<rest/>'
  }<duration>${options.duration ?? 1}</duration><voice>${options.voice ?? 1}</voice><staff>${
    options.staff ?? 1
  }</staff>${options.extra || ''}</note>`;

const noteSequence = (steps: string[]) => steps.map((step) => note({ step })).join('');

function firstDescriptor(musicXml: Buffer) {
  return describeScannerMusicXmlMeasures(musicXml)[0].measures[0];
}

describe('scanner measure analysis', () => {
  it('normalizes divisions, layout, tie spelling, and chord-member order', () => {
    const base = firstDescriptor(
      score(
        measure(
          '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef default-x="12"><sign>G</sign><line>2</line></clef></attributes>' +
            note({ step: 'C', duration: 1, extra: '<tie type="start"/>' }) +
            note({ step: 'E', duration: 1, chord: true })
        )
      )
    );
    const candidate = firstDescriptor(
      score(
        measure(
          '<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef number="1" relative-x="99"><sign>G</sign><line>2</line></clef></attributes>' +
            note({ step: 'E', duration: 4 }) +
            note({
              step: 'C',
              duration: 4,
              chord: true,
              extra: '<notations><tied type="start"/></notations>'
            })
        )
      )
    );

    expect(base.coarseKey).toMatch(new RegExp(`^${SCANNER_COARSE_MEASURE_KEY_VERSION}:`));
    expect(base.richHash).toMatch(new RegExp(`^${SCANNER_MEASURE_DESCRIPTOR_VERSION}:`));
    expect(candidate.coarseKey).toBe(base.coarseKey);
    expect(candidate.richHash).toBe(base.richHash);
    expect(classifyScannerMeasureDifference(base, candidate)).toEqual([]);
  });

  it('uses coarse content only for alignment but retains voice and staff differences', () => {
    const base = firstDescriptor(
      score(measure('<attributes><divisions>1</divisions></attributes>' + note({ step: 'C' })))
    );
    const candidate = firstDescriptor(
      score(
        measure(
          '<attributes><divisions>8</divisions></attributes>' +
            note({ step: 'C', duration: 8, voice: 2, staff: 2 })
        )
      )
    );

    expect(candidate.coarseKey).toBe(base.coarseKey);
    expect(candidate.richHash).not.toBe(base.richHash);
    expect(classifyScannerMeasureDifference(base, candidate)).toEqual(['voice', 'staff']);
  });

  it('keeps measure-local attributes and marking classes out of the coarse key', () => {
    const base = firstDescriptor(
      score(
        measure(
          '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' +
            note({ step: 'C' })
        )
      )
    );
    const candidate = firstDescriptor(
      score(
        measure(
          '<attributes><divisions>1</divisions><key><fifths>2</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time><clef><sign>F</sign><line>4</line></clef></attributes>' +
            '<direction><direction-type><dynamics><f/></dynamics></direction-type></direction>' +
            note({
              step: 'C',
              extra:
                '<lyric number="1"><syllabic>single</syllabic><text>la</text></lyric><notations><articulations><staccato/></articulations></notations>'
            })
        )
      )
    );

    expect(candidate.coarseKey).toBe(base.coarseKey);
    expect(classifyScannerMeasureDifference(base, candidate)).toEqual([
      'attributes',
      'lyrics',
      'dynamics',
      'notations'
    ]);
  });

  it('detects notation changes even when role and marking components stay equal', () => {
    const base = firstDescriptor(score(measure(note({ step: 'C', duration: 1 }))));
    const candidate = firstDescriptor(score(measure(note({ step: 'D', duration: 2 }))));

    expect(candidate.coarseKey).not.toBe(base.coarseKey);
    expect(classifyScannerMeasureDifference(base, candidate)).toEqual(['notation']);
  });

  it('uses ordered backup/forward cursor movement to retain semantic onset', () => {
    const simultaneous = firstDescriptor(
      score(
        measure(
          '<attributes><divisions>2</divisions></attributes>' +
            note({ step: 'C', duration: 2, voice: 1 }) +
            '<backup><duration>2</duration></backup>' +
            note({ step: 'E', duration: 2, voice: 2 })
        )
      )
    );
    const sequential = firstDescriptor(
      score(
        measure(
          '<attributes><divisions>2</divisions></attributes>' +
            note({ step: 'C', duration: 2, voice: 1 }) +
            note({ step: 'E', duration: 2, voice: 2 })
        )
      )
    );

    expect(sequential.coarseKey).toBe(simultaneous.coarseKey);
    expect(classifyScannerMeasureDifference(simultaneous, sequential)).toEqual(['notation']);
  });

  it('accepts an XML declaration and carries divisions into later measures', () => {
    const base = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><score-partwise><part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list><part id="P1">${measure(
        '<attributes><divisions>2</divisions></attributes>' + note({ step: 'C', duration: 2 }),
        '1'
      )}${measure(note({ step: 'D', duration: 1 }), '2')}</part></score-partwise>`
    );
    const candidate = score(
      measure(
        '<attributes><divisions>4</divisions></attributes>' + note({ step: 'C', duration: 4 }),
        '1'
      ) + measure(note({ step: 'D', duration: 2 }), '2')
    );

    const baseMeasures = describeScannerMusicXmlMeasures(base)[0].measures;
    const candidateMeasures = describeScannerMusicXmlMeasures(candidate)[0].measures;
    expect(baseMeasures.map((item) => item.coarseKey)).toEqual(
      candidateMeasures.map((item) => item.coarseKey)
    );
    expect(baseMeasures.map((item) => item.richHash)).toEqual(
      candidateMeasures.map((item) => item.richHash)
    );
  });

  it('treats repeated attributes as carried state while retaining real changes', () => {
    const repeated = describeScannerMusicXmlMeasures(
      score(
        measure(
          '<attributes><key><fifths>0</fifths></key><clef><sign>G</sign><line>2</line></clef></attributes>' +
            note({ step: 'C' }),
          '1'
        ) +
          measure(
            '<attributes><key><fifths>0</fifths></key><clef><sign>G</sign><line>2</line></clef></attributes>' +
              note({ step: 'D' }),
            '2'
          )
      )
    )[0].measures;
    const carried = describeScannerMusicXmlMeasures(
      score(
        measure(
          '<attributes><key><fifths>0</fifths></key><clef><sign>G</sign><line>2</line></clef></attributes>' +
            note({ step: 'C' }),
          '1'
        ) + measure(note({ step: 'D' }), '2')
      )
    )[0].measures;
    const changed = describeScannerMusicXmlMeasures(
      score(
        measure(
          '<attributes><key><fifths>0</fifths></key><clef><sign>G</sign><line>2</line></clef></attributes>' +
            note({ step: 'C' }),
          '1'
        ) +
          measure(
            '<attributes><key><fifths>2</fifths></key></attributes>' + note({ step: 'D' }),
            '2'
          )
      )
    )[0].measures;

    expect(repeated[1].richHash).toBe(carried[1].richHash);
    expect(classifyScannerMeasureDifference(carried[1], changed[1])).toEqual(['attributes']);
  });

  it('retains direction onset while discarding direction layout', () => {
    const base = firstDescriptor(
      score(
        measure(
          '<direction placement="above"><direction-type><words default-x="10" font-style="italic">dolce</words></direction-type></direction>' +
            note({ step: 'C' })
        )
      )
    );
    const layoutOnly = firstDescriptor(
      score(
        measure(
          '<direction placement="below"><direction-type><words relative-x="50" color="#000000">dolce</words></direction-type></direction>' +
            note({ step: 'C' })
        )
      )
    );
    const moved = firstDescriptor(
      score(
        measure(
          '<direction><direction-type><words>dolce</words></direction-type><offset>1</offset></direction>' +
            note({ step: 'C' })
        )
      )
    );

    expect(layoutOnly.richHash).toBe(base.richHash);
    expect(classifyScannerMeasureDifference(base, moved)).toEqual(['directions']);
  });

  it('localizes inserted measures with the reusable LCS core', () => {
    expect(alignScannerMeasureKeys(['a', 'b', 'c'], ['a', 'inserted', 'b', 'c'])).toEqual([
      { type: 'equal', baseIndex: 0, candidateIndex: 0 },
      { type: 'added', candidateIndex: 1 },
      { type: 'equal', baseIndex: 1, candidateIndex: 2 },
      { type: 'equal', baseIndex: 2, candidateIndex: 3 }
    ]);
    expect(alignScannerMeasureKeys(['a', 'removed', 'b'], ['a', 'b'])).toEqual([
      { type: 'equal', baseIndex: 0, candidateIndex: 0 },
      { type: 'removed', baseIndex: 1 },
      { type: 'equal', baseIndex: 2, candidateIndex: 1 }
    ]);
  });

  it('locates a uniquely similar measure without promoting it to equality', () => {
    const base = describeScannerMusicXmlMeasures(
      score(
        measure(noteSequence(['C', 'D', 'E']), '1') +
          measure(noteSequence(['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C']), '2') +
          measure(noteSequence(['G', 'F', 'E']), '3')
      )
    )[0].measures;
    const candidate = describeScannerMusicXmlMeasures(
      score(
        measure(noteSequence(['C', 'D', 'E']), '1') +
          measure(noteSequence(['C', 'D', 'E', 'F', 'G', 'A', 'A', 'C']), '2') +
          measure(noteSequence(['G', 'F', 'E']), '3')
      )
    )[0].measures;

    expect(alignScannerMeasures(base, candidate)).toEqual([
      { type: 'equal', baseIndex: 0, candidateIndex: 0 },
      { type: 'aligned', baseIndex: 1, candidateIndex: 1, similarity: 0.89375 },
      { type: 'equal', baseIndex: 2, candidateIndex: 2 }
    ]);
    expect(classifyScannerMeasureDifference(base[1], candidate[1])).toContain('notation');
  });

  it('leaves repeated fuzzy passages unmatched when no pair is uniquely best', () => {
    const repeated = measure(noteSequence(['C', 'D', 'E', 'F', 'G', 'A']), '1');
    const nearRepeated = measure(noteSequence(['C', 'D', 'E', 'F', 'G', 'B']), '1');
    const base = describeScannerMusicXmlMeasures(score(repeated + repeated))[0].measures;
    const candidate = describeScannerMusicXmlMeasures(score(nearRepeated + nearRepeated))[0]
      .measures;

    expect(alignScannerMeasures(base, candidate)).toEqual([
      { type: 'removed', baseIndex: 0 },
      { type: 'removed', baseIndex: 1 },
      { type: 'added', candidateIndex: 0 },
      { type: 'added', candidateIndex: 1 }
    ]);
  });

  it('fails closed when fuzzy event comparison would exceed its work budget', () => {
    const base = firstDescriptor(score(measure(noteSequence(['C', 'D', 'E']))));
    const candidate = firstDescriptor(score(measure(noteSequence(['C', 'D', 'F']))));
    const oversized = Array.from({ length: 900 }, (_value, index) => `event-${index}`);

    expect(
      alignScannerMeasures(
        [{ ...base, alignment: { events: oversized, pitches: oversized, durations: oversized } }],
        [
          {
            ...candidate,
            alignment: { events: oversized, pitches: oversized, durations: oversized }
          }
        ]
      )
    ).toEqual([
      { type: 'removed', baseIndex: 0 },
      { type: 'added', candidateIndex: 0 }
    ]);
  });

  it('caps the quadratic alignment table', () => {
    const tooMany = Array.from({ length: MAX_SCANNER_MEASURES_PER_PART + 1 }, () => 'x');
    expect(() => alignScannerMeasureKeys(tooMany, [])).toThrow(/limited to 1024 keys/);
  });
});
