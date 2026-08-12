import { transferScannerMarkings } from './scanner-marking-transfer';
import { validateScannerMusicXmlSemantics } from './scanner-musicxml-semantics';

/**
 * §4's transfer-markings, the operation that exists in no other comparator.
 * Transcoda declares `lyrics` and `dynamics` unsupported, so when its notes are
 * the better reading, everything HOMR heard *about* those notes is only in HOMR.
 */

const part = (measures: string) => Buffer.from(`<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
  <part id="P1">${measures}</part>
</score-partwise>`);

const bar = (contents: string, divisions = 4, number = '1') => `
  <measure number="${number}">
    <attributes><divisions>${divisions}</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
    ${contents}
  </measure>`;

const note = (
  duration: number,
  options: { step?: string; lyric?: string; voice?: string } = {}
) => `
  <note>
    <pitch><step>${options.step || 'C'}</step><octave>4</octave></pitch>
    <duration>${duration}</duration>
    <voice>${options.voice || '1'}</voice>
    ${options.lyric ? `<lyric number="1"><syllabic>single</syllabic><text>${options.lyric}</text></lyric>` : ''}
  </note>`;

const dynamic = (mark: string, offset?: number) => `
  <direction placement="below">
    <direction-type><dynamics><${mark}/></dynamics></direction-type>
    ${offset === undefined ? '' : `<offset>${offset}</offset>`}
  </direction>`;

const transfer = (
  base: Buffer,
  candidate: Buffer,
  indexes = [0],
  kind: 'dynamics' | 'lyrics' = 'dynamics'
) =>
  transferScannerMarkings({
    baseXml: base,
    candidateXml: candidate,
    basePartIndex: 0,
    candidatePartIndex: 0,
    baseMeasureIndexes: indexes,
    candidateMeasureIndexes: indexes,
    kind
  });

describe('scanner marking transfer', () => {
  it('lays dynamics and lyrics over notes the two readings agree about', () => {
    const withoutMarkings = part(bar(note(4) + note(4) + note(4) + note(4)));
    const withMarkings = part(
      bar(
        dynamic('p') +
          note(4, { lyric: 'A' }) +
          note(4, { lyric: 'men' }) +
          dynamic('f') +
          note(4) +
          note(4)
      )
    );
    const dynamicsOnly = transfer(withoutMarkings, withMarkings, [0], 'dynamics');
    expect(dynamicsOnly.refusals).toEqual([]);
    expect(dynamicsOnly.transferred).toEqual({ directions: 2, lyrics: 0 });
    expect(dynamicsOnly.musicXml!.toString('utf8')).not.toContain('<text>men</text>');

    const result = transfer(withoutMarkings, withMarkings, [0], 'lyrics');
    expect(result.refusals).toEqual([]);
    expect(result.musicXml).not.toBeNull();
    expect(result.transferred).toEqual({ directions: 0, lyrics: 2 });
    const xml = result.musicXml!.toString('utf8');
    expect(xml).toContain('<text>men</text>');
    // Taking lyrics left the dynamics alone.
    expect(xml).not.toContain('<p/>');
    expect(validateScannerMusicXmlSemantics(result.musicXml!).valid).toBe(true);
  });

  it('puts a dynamic back where it stood among the notes', () => {
    // Placement is by position among the notes rather than by <offset>, so
    // nothing has to be recomputed — but it does have to land in the same gap.
    const bare = part(bar(note(4) + note(4) + note(4) + note(4)));
    const marked = part(bar(note(4) + note(4) + dynamic('f') + note(4) + note(4)));
    const result = transfer(bare, marked);

    const xml = result.musicXml!.toString('utf8');
    const beforeDynamic = xml.slice(0, xml.indexOf('<f/>'));
    // Two notes precede it, as in the reading it came from.
    expect((beforeDynamic.match(/<note>/g) || []).length).toBe(2);
  });

  it('refuses when the readings do not agree about the notes', () => {
    // A dynamic sits at a place in the bar and a lyric sits on a note. If there
    // is no agreement about the notes there is no such place and no such note,
    // and putting the marking somewhere plausible guesses at exactly the thing
    // the reviewer is trying to establish.
    const base = part(bar(note(4) + note(4) + note(4) + note(4)));
    const candidate = part(bar(dynamic('p') + note(8) + note(8)));
    const result = transfer(base, candidate);

    expect(result.musicXml).toBeNull();
    expect(result.refusals[0].code).toBe('notes-differ');
    expect(result.refusals[0].detail).toMatch(/Take the bar itself first/);
  });

  it('agrees about notes across different divisions', () => {
    // The Bach case: one reading counts in 4, the other in 10080, and they are
    // the same four quarter notes. Refusing here would refuse the transfer on
    // every real page.
    const base = part(bar(note(4) + note(4) + note(4) + note(4), 4));
    const candidate = part(
      bar(dynamic('p') + note(10080) + note(10080) + note(10080) + note(10080), 10080)
    );
    const result = transfer(base, candidate);

    expect(result.refusals).toEqual([]);
    expect(result.transferred.directions).toBe(1);
  });

  it('rescales an offset into the target time units', () => {
    const base = part(bar(note(4) + note(4) + note(4) + note(4), 4));
    const candidate = part(
      bar(dynamic('p', 5040) + note(10080) + note(10080) + note(10080) + note(10080), 10080)
    );
    const result = transfer(base, candidate);

    // Half a quarter note: 5040 of 10080 becomes 2 of 4.
    expect(result.musicXml!.toString('utf8')).toContain('<offset>2</offset>');
  });

  it('replaces the markings already there rather than doubling them', () => {
    // Two engines' guesses about the same phrase merged into one bar would be
    // neither reading, and nobody asked for that.
    const base = part(bar(dynamic('ff') + note(4, { lyric: 'old' }) + note(4) + note(4) + note(4)));
    const candidate = part(bar(dynamic('p') + note(4, { lyric: 'new' }) + note(4) + note(4) + note(4)));
    const result = transfer(base, candidate, [0], 'dynamics');

    const xml = result.musicXml!.toString('utf8');
    expect(xml).toContain('<p/>');
    expect(xml).not.toContain('<ff/>');
    // Taking dynamics replaced the dynamics and left the lyric where it was.
    expect(xml).toContain('<text>old</text>');
    expect(xml).not.toContain('<text>new</text>');
  });

  it('says when there is nothing to take', () => {
    const bare = part(bar(note(4) + note(4) + note(4) + note(4)));
    const result = transfer(bare, bare);

    expect(result.musicXml).toBeNull();
    expect(result.refusals[0].code).toBe('nothing-to-transfer');
  });

  it('leaves the document untouched when any bar in the span refuses', () => {
    // Half a transfer is worse than none: the reviewer would have to work out
    // which bars had moved and which had not.
    const base = part(
      bar(note(4) + note(4) + note(4) + note(4)) +
        bar(note(4) + note(4) + note(4) + note(4), 4, '2')
    );
    const candidate = part(
      bar(dynamic('p') + note(4) + note(4) + note(4) + note(4)) + bar(note(8) + note(8), 4, '2')
    );
    const result = transfer(base, candidate, [0, 1]);

    expect(result.musicXml).toBeNull();
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(['notes-differ']);
    expect(result.transferred).toEqual({ directions: 0, lyrics: 0 });
  });

  it('needs the same number of bars on both sides', () => {
    const base = part(bar(note(4) + note(4) + note(4) + note(4)));
    const result = transferScannerMarkings({
      baseXml: base,
      candidateXml: base,
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: [0],
      candidateMeasureIndexes: [],
      kind: 'dynamics'
    });

    expect(result.refusals[0].code).toBe('span-mismatch');
  });
});
