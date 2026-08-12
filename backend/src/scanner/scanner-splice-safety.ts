import { musicXmlParser, parseValidMusicXml } from './scanner-musicxml';
import {
  attrs,
  contents,
  directEntries,
  directText,
  type OrderedEntry
} from './scanner-musicxml-tree';

export const SCANNER_SPLICE_SAFETY_VERSION = 'scanner-splice-safety-v1';

/**
 * Why one engine's measures cannot be dropped into another's document.
 *
 * Design §5.2 and §11.3: a block decision is a *merge*, not a selection, and
 * music has two hazards a text merge does not — attributes live inside
 * measures and can change mid-page, and a measure is not independent of its
 * neighbours. The design offers two ways out: a canonical musical-event
 * intermediate representation, or refusing any cross-engine measure that would
 * need transforming. This module is the second, which is the one the rest of
 * this feature already reaches for: part matching refuses rather than guessing,
 * geometry refuses rather than locating approximately, and assembly declines
 * rather than emitting something plausible but broken.
 */
export type ScannerSpliceRefusalCode =
  | 'divisions-incommensurable'
  | 'span-empty'
  | 'joins-severed-tie'
  | 'tie-crosses-boundary'
  | 'slur-crosses-boundary'
  | 'duration-differs'
  | 'voices-differ'
  | 'staves-differ'
  | 'span-missing'
  | 'unreadable';

export interface ScannerSpliceRefusal {
  code: ScannerSpliceRefusalCode;
  /** Plain enough to show a reviewer; this is what they are told instead. */
  detail: string;
  measureIndex?: number;
}

/**
 * Both fields always present, rather than a discriminated union.
 *
 * This project compiles without `strict`, so `strictNullChecks` is off and
 * TypeScript will not narrow `{safe: true} | {safe: false; refusals}` — every
 * caller would have to cast to read a refusal it had just proven exists. A
 * shape that needs no narrowing is the right one here, and it reads better
 * anyway: a caller that wants to log why can, whatever the verdict.
 */
/**
 * Something the splice will change beyond copying measures across.
 *
 * A repair is not a refusal and not a silent fix: it is work the splice has to
 * do for the result to be well formed, which the reviewer is told about. The
 * same principle as an edited bar not counting as an engine win — anything the
 * system decides on its own has to be visible, or phase E learns from it as
 * though an engine had produced it.
 */
export interface ScannerSpliceRepair {
  code: 'drop-dangling-slur';
  detail: string;
  measureIndex?: number;
}

export interface ScannerSpliceAssessment {
  safe: boolean;
  refusals: ScannerSpliceRefusal[];
  repairs: ScannerSpliceRepair[];
}

/** Everything about one measure that decides whether it can be spliced. */
export interface ScannerSpliceMeasureFacts {
  measureIndex: number;
  measureNumber?: string;
  /** `divisions` in force here, which is carried forward between measures. */
  divisions: string;
  /** Total sounding duration, in divisions, of the longest voice. */
  duration: string;
  /**
   * Greatest common divisor of every duration, backup and forward here.
   *
   * This is what decides whether the measure can be re-expressed in another
   * document's divisions exactly. If `gcd * theirDivisions` divides evenly by
   * `ourDivisions`, then so does every individual duration — the gcd is an
   * integer combination of them — so one test answers for the whole measure.
   */
  durationGcd: string;
  voices: string[];
  staves: string[];
  /**
   * Pitches of ties left open at the end of this measure, and of tie stops that
   * had no start inside it.
   *
   * Pitches rather than counts because a tie is only valid between the same
   * pitch: it says two noteheads are one sounding note. That makes a severed
   * tie checkable — if the bar being spliced in ends on the pitch the next bar
   * continues, the tie survives untouched.
   */
  tieOut: string[];
  tieIn: string[];
  /**
   * Slurs left open, and closed from earlier, as counts.
   *
   * Counts suffice because a slur is a marking *about* the notes rather than
   * part of what a note is, so nothing has to match for it to be well formed.
   */
  slurOut: number;
  slurIn: number;
}

export interface ScannerSplicePartFacts {
  documentPartId: string;
  measures: ScannerSpliceMeasureFacts[];
}

const integerOr = (value: string, fallback: bigint): bigint =>
  /^\d+$/.test(value) ? BigInt(value) : fallback;

const greatestCommonDivisor = (a: bigint, b: bigint): bigint => {
  let [x, y] = [a < BigInt(0) ? -a : a, b < BigInt(0) ? -b : b];
  while (y) [x, y] = [y, x % y];
  return x;
};

/**
 * Read the structural facts a splice decision needs.
 *
 * Deliberately not derived from `ScannerMeasureDescriptor`: those are hashes,
 * built to answer "are these the same?" A splice asks different questions —
 * what divisions is this in, how long is it, does anything cross its edges —
 * and hashes cannot answer any of them.
 */
export function readScannerSpliceFacts(musicXml: Buffer): ScannerSplicePartFacts[] {
  const { rootName } = parseValidMusicXml(musicXml);
  if (rootName !== 'score-partwise') {
    throw new Error('Scanner splice safety requires score-partwise MusicXML');
  }
  const ordered = musicXmlParser({ preserveOrder: true }).parse(musicXml.toString('utf8'));
  const rootEntry = Array.isArray(ordered)
    ? ordered.find((entry) => Object.prototype.hasOwnProperty.call(entry, 'score-partwise'))
    : undefined;
  const root = rootEntry?.['score-partwise'];
  if (!Array.isArray(root)) throw new Error('Scanner splice safety could not read MusicXML');

  return directEntries(root, 'part').map((part) => {
    const documentPartId = String(attrs(part)['@_id'] || '');
    let divisions = BigInt(1);
    const measures = directEntries(contents(part, 'part'), 'measure').map(
      (measure, measureIndex) => {
        const children = contents(measure, 'measure');
        for (const attributes of directEntries(children, 'attributes')) {
          const declared = directText(contents(attributes, 'attributes'), 'divisions');
          if (declared) divisions = integerOr(declared, divisions);
        }
        const facts = readMeasure(children);
        return {
          measureIndex,
          measureNumber: String(attrs(measure)['@_number'] || '') || undefined,
          divisions: divisions.toString(),
          ...facts
        };
      }
    );
    return { documentPartId, measures };
  });
}

function readMeasure(
  children: OrderedEntry[]
): Omit<ScannerSpliceMeasureFacts, 'measureIndex' | 'measureNumber' | 'divisions'> {
  const voices = new Set<string>();
  const staves = new Set<string>();
  // Duration is tracked per voice: voices run in parallel, so the measure's
  // length is the longest of them, not their sum. `<backup>` and `<forward>`
  // move the cursor rather than sounding, so they are applied to the running
  // position and never counted as duration.
  let cursor = BigInt(0);
  let longest = BigInt(0);
  let gcd = BigInt(0);
  const openTies: string[] = [];
  const tieIn: string[] = [];
  let openSlurs = 0;
  let slurIn = 0;

  for (const child of children) {
    const [tag] = Object.keys(child).filter((key) => key !== ':@');
    const inner = contents(child, tag);
    if (tag === 'backup' || tag === 'forward') {
      const amount = integerOr(directText(inner, 'duration'), BigInt(0));
      gcd = greatestCommonDivisor(gcd, amount);
      cursor = tag === 'backup' ? cursor - amount : cursor + amount;
      if (cursor < BigInt(0)) cursor = BigInt(0);
      continue;
    }
    if (tag !== 'note') continue;

    const voice = directText(inner, 'voice') || '1';
    const staff = directText(inner, 'staff') || '1';
    voices.add(voice);
    staves.add(staff);

    // A chord member sounds with the previous note rather than after it, so it
    // must not advance the cursor — counting it would make the measure look
    // longer than it is and refuse a perfectly splice-able bar.
    const isChord = directEntries(inner, 'chord').length > 0;
    const duration = integerOr(directText(inner, 'duration'), BigInt(0));
    gcd = greatestCommonDivisor(gcd, duration);
    if (!isChord) {
      cursor += duration;
      if (cursor > longest) longest = cursor;
    }

    const pitch = pitchOf(inner);
    for (const type of tieTypesOf(inner)) {
      if (type === 'start') openTies.push(pitch);
      else if (type === 'stop') {
        const matching = openTies.indexOf(pitch);
        if (matching >= 0) openTies.splice(matching, 1);
        else tieIn.push(pitch);
      }
    }
    for (const type of slurTypesOf(inner)) {
      if (type === 'start') openSlurs += 1;
      else if (type === 'stop') {
        if (openSlurs > 0) openSlurs -= 1;
        else slurIn += 1;
      }
    }
  }

  return {
    duration: longest.toString(),
    durationGcd: gcd.toString(),
    voices: [...voices].sort(),
    staves: [...staves].sort(),
    tieOut: [...openTies].sort(),
    tieIn: [...tieIn].sort(),
    slurOut: openSlurs,
    slurIn
  };
}

/** `C#4`, `rest`, or `unpitched` — enough to tell whether a tie can survive. */
function pitchOf(noteChildren: OrderedEntry[]): string {
  const pitch = directEntries(noteChildren, 'pitch')[0];
  if (!pitch) return directEntries(noteChildren, 'rest').length > 0 ? 'rest' : 'unpitched';
  const inner = contents(pitch, 'pitch');
  const step = directText(inner, 'step');
  const alter = directText(inner, 'alter');
  const octave = directText(inner, 'octave');
  return `${step}${alter ? `(${alter})` : ''}${octave}`;
}

/**
 * The tie types on one note, deduplicated.
 *
 * `<tie>` is the sounding element and `<tied>` is the notation of the same tie,
 * so a well-formed note carrying one tie has both. Counting them separately
 * reports two ties where there is one, and then no join ever matches.
 */
function tieTypesOf(noteChildren: OrderedEntry[]): string[] {
  const types = new Set<string>();
  for (const tie of directEntries(noteChildren, 'tie')) {
    const type = attrs(tie)['@_type'];
    if (type) types.add(String(type));
  }
  for (const notations of directEntries(noteChildren, 'notations')) {
    for (const tied of directEntries(contents(notations, 'notations'), 'tied')) {
      const type = attrs(tied)['@_type'];
      if (type) types.add(String(type));
    }
  }
  return [...types];
}

function slurTypesOf(noteChildren: OrderedEntry[]): string[] {
  const types: string[] = [];
  for (const notations of directEntries(noteChildren, 'notations')) {
    for (const slur of directEntries(contents(notations, 'notations'), 'slur')) {
      const type = attrs(slur)['@_type'];
      if (type) types.push(String(type));
    }
  }
  return types;
}

/**
 * Assess an insertion or a deletion.
 *
 * A replacement asks whether the new bars can be *expressed* in the old ones'
 * terms. This asks something narrower and different: after the change, which
 * two bars are next to each other, and does anything that used to cross between
 * them still have both ends? Length and divisions are irrelevant — nothing is
 * being converted, only added or removed — so refusing on them, as the first
 * version of this did, refuses two of the three real blocks for no reason.
 */
function assessStructuralChange(input: {
  base: ScannerSplicePartFacts[];
  candidate: ScannerSplicePartFacts[];
  basePartIndex: number;
  candidatePartIndex: number;
  baseMeasureIndexes: readonly number[];
  candidateMeasureIndexes: readonly number[];
  baseAnchorIndex?: number;
}): ScannerSpliceAssessment {
  const refusals: ScannerSpliceRefusal[] = [];
  const repairs: ScannerSpliceRepair[] = [];
  const basePart = input.base[input.basePartIndex];
  const candidatePart = input.candidate[input.candidatePartIndex];
  if (!basePart || !candidatePart) {
    return {
      safe: false,
      refusals: [
        { code: 'span-missing', detail: 'This decision names a part that is not in both readings.' }
      ],
      repairs: []
    };
  }

  const deleting = input.candidateMeasureIndexes.length === 0;
  const removed = deleting ? spanOf(basePart, input.baseMeasureIndexes) : [];
  const added = deleting ? [] : spanOf(candidatePart, input.candidateMeasureIndexes);
  if ((deleting && !removed) || (!deleting && !added)) {
    return {
      safe: false,
      refusals: [
        {
          code: 'span-missing',
          detail: 'The measures this decision refers to are not present in the reading it names.'
        }
      ],
      repairs: []
    };
  }

  // The bars that become neighbours once the change is made.
  const anchor = deleting
    ? Math.min(...input.baseMeasureIndexes) - 1
    : (input.baseAnchorIndex ?? -1);
  const before = basePart.measures[anchor];
  const after = deleting
    ? basePart.measures[Math.max(...input.baseMeasureIndexes) + 1]
    : basePart.measures[anchor + 1];
  const leading = deleting ? after : (added as ScannerSpliceMeasureFacts[])[0];
  const trailing = deleting
    ? before
    : (added as ScannerSpliceMeasureFacts[])[(added as ScannerSpliceMeasureFacts[]).length - 1];

  const sameNotes = (a: string[], b: string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  if (before && leading && !sameNotes(before.tieOut, leading.tieIn)) {
    refusals.push({
      code: 'joins-severed-tie',
      detail:
        `${deleting ? 'Removing' : 'Inserting'} here would put two bars next to each other that do ` +
        'not agree about a tie between them. A tie joins two noteheads into one sounding note, so ' +
        'this cannot be patched without changing either a pitch or how the passage sounds.',
      measureIndex: Math.max(anchor, 0)
    });
  }
  if (!deleting && after && trailing && !sameNotes(trailing.tieOut, after.tieIn)) {
    refusals.push({
      code: 'joins-severed-tie',
      detail:
        'Inserting here would leave a tie between the new bars and the one after them with only ' +
        'one end.',
      measureIndex: Math.max(anchor, 0)
    });
  }

  const slurBreaks =
    (before && leading && before.slurOut !== leading.slurIn) ||
    (!deleting && after && trailing && trailing.slurOut !== after.slurIn);
  if (slurBreaks) {
    repairs.push({
      code: 'drop-dangling-slur',
      detail:
        'A slur across this join will lose one end and is dropped. The phrase mark goes; no note ' +
        'changes.',
      measureIndex: Math.max(anchor, 0)
    });
  }

  return { safe: refusals.length === 0, refusals, repairs };
}

const spanOf = (
  part: ScannerSplicePartFacts | undefined,
  indexes: readonly number[]
): ScannerSpliceMeasureFacts[] | null => {
  if (!part || indexes.length === 0) return null;
  const measures = indexes.map((index) => part.measures[index]);
  return measures.some((measure) => !measure) ? null : measures;
};

const sum = (values: string[]): bigint =>
  values.reduce((total, value) => total + BigInt(value), BigInt(0));

/**
 * Can this candidate span replace this base span without transformation?
 *
 * "Without transformation" is the whole point. Re-expressing a measure in the
 * base's divisions is not a matter of rewriting `<duration>` — `<backup>`,
 * `<forward>`, multi-voice offsets and tuplets all scale with it — so a raw
 * splice across differing divisions is unsafe and this refuses instead
 * (design §5.2).
 */
export function assessScannerSplice(input: {
  base: ScannerSplicePartFacts[];
  candidate: ScannerSplicePartFacts[];
  basePartIndex: number;
  candidatePartIndex: number;
  baseMeasureIndexes: readonly number[];
  candidateMeasureIndexes: readonly number[];
  /**
   * Where an insertion goes: the base measure it follows, `-1` for the start.
   *
   * Required only when `baseMeasureIndexes` is empty, because that is the one
   * case with no position of its own. `ScannerComparisonBlock.baseAnchorIndex`
   * is where this comes from.
   */
  baseAnchorIndex?: number;
}): ScannerSpliceAssessment {
  const refusals: ScannerSpliceRefusal[] = [];
  const repairs: ScannerSpliceRepair[] = [];
  const basePart = input.base[input.basePartIndex];
  const candidatePart = input.candidate[input.candidatePartIndex];
  const baseSpan = spanOf(basePart, input.baseMeasureIndexes);
  const candidateSpan = spanOf(candidatePart, input.candidateMeasureIndexes);

  // An insertion or a deletion, which changes how many bars the part has. It is
  // assessed differently from a replacement: nothing is being converted, so
  // divisions and length do not come into it, but the two bars that end up
  // adjacent afterwards have to meet — the same edge question, asked about a
  // join that does not exist yet.
  if (input.baseMeasureIndexes.length === 0 || input.candidateMeasureIndexes.length === 0) {
    return assessStructuralChange(input);
  }
  if (!baseSpan || !candidateSpan) {
    return {
      safe: false,
      refusals: [
        {
          code: 'span-missing',
          detail:
            'The measures this decision refers to are not present in both readings, so there is nothing to splice.'
        }
      ],
      repairs: []
    };
  }

  const baseDivisions = new Set(baseSpan.map((measure) => measure.divisions));
  const candidateDivisions = new Set(candidateSpan.map((measure) => measure.divisions));
  // Divisions can change mid-page, so a span that changes them part-way through
  // has no single conversion and is refused outright.
  const steady = baseDivisions.size === 1 && candidateDivisions.size === 1;
  const baseUnit = steady ? BigInt([...baseDivisions][0]) : BigInt(0);
  const candidateUnit = steady ? BigInt([...candidateDivisions][0]) : BigInt(0);

  /**
   * Can the candidate span be written in the base's divisions exactly?
   *
   * Measured before deciding: on the retained Bach page HOMR reads in
   * `divisions 4` and Transcoda in `10080`, and the two engines agree on
   * essentially nothing else either — so refusing every differing-divisions
   * splice, as an earlier reading of §11.3 did, refuses *every* cross-engine
   * decision on the corpus this feature exists for. That is a safety net, not
   * a policy.
   *
   * The hazard §5.2 names is real but narrower than "differs": what is unsafe
   * is *inexact* rescaling. `<duration>`, `<backup>` and `<forward>` all scale
   * linearly by the same ratio, and `<time-modification>` is a ratio of note
   * values that divisions do not touch at all. So when every value converts to
   * a whole number the rewrite is exact arithmetic, and when one does not — a
   * demisemiquaver into a document whose divisions cannot express it — this
   * refuses, which is the case the design was actually protecting against.
   */
  const convertsExactly =
    steady &&
    candidateUnit > BigInt(0) &&
    candidateSpan.every((measure) => {
      const unit = BigInt(measure.durationGcd);
      return unit === BigInt(0) || (unit * baseUnit) % candidateUnit === BigInt(0);
    });

  if (!convertsExactly) {
    refusals.push({
      code: 'divisions-incommensurable',
      detail: steady
        ? `This passage cannot be written in the other reading's time units without rounding ` +
          `(${candidateUnit} divisions per quarter note into ${baseUnit}), so some note would have ` +
          'to change length. It is refused rather than approximated.'
        : 'The passage changes how it measures time part-way through, so there is no single exact ' +
          'conversion between the two readings.'
    });
  }

  // Compare lengths in a shared unit, since the two sides may count differently.
  if (steady) {
    const baseDuration = sum(baseSpan.map((measure) => measure.duration)) * candidateUnit;
    const candidateDuration = sum(candidateSpan.map((measure) => measure.duration)) * baseUnit;
    if (baseDuration !== candidateDuration) {
      refusals.push({
        code: 'duration-differs',
        detail:
          'The two readings of this passage are different lengths, so replacing one with the other ' +
          'would shift everything after it in the part.'
      });
    }
  }

  const baseVoices = new Set(baseSpan.flatMap((measure) => measure.voices));
  const candidateVoices = new Set(candidateSpan.flatMap((measure) => measure.voices));
  if (baseVoices.size !== candidateVoices.size) {
    refusals.push({
      code: 'voices-differ',
      detail:
        `This passage has ${baseVoices.size} voice(s) in one reading and ${candidateVoices.size} in ` +
        'the other, so the replacement does not fit the part it would land in.'
    });
  }

  const baseStaves = new Set(baseSpan.flatMap((measure) => measure.staves));
  const candidateStaves = new Set(candidateSpan.flatMap((measure) => measure.staves));
  if (baseStaves.size !== candidateStaves.size) {
    refusals.push({
      code: 'staves-differ',
      detail:
        `This passage spans ${baseStaves.size} stave(s) in one reading and ${candidateStaves.size} in ` +
        'the other.'
    });
  }

  // A measure is not independent of its neighbours, so what the spliced bars
  // must meet is the *base bars on either side of them* — not the base bars
  // they replace. Comparing the span against itself would refuse a passage
  // whose ties happen to be internal, and miss one whose edges do not line up.
  const before = basePart.measures[Math.min(...input.baseMeasureIndexes) - 1];
  const after = basePart.measures[Math.max(...input.baseMeasureIndexes) + 1];
  const incoming = candidateSpan[0];
  const outgoing = candidateSpan[candidateSpan.length - 1];
  const firstIndex = Math.min(...input.baseMeasureIndexes);
  const lastIndex = Math.max(...input.baseMeasureIndexes);

  const sameNotes = (a: string[], b: string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  /**
   * A tie is only valid between the same pitch — it says two noteheads are one
   * sounding note — so a severed tie cannot be repaired without either changing
   * a pitch, which falsifies the reading, or dropping the tie, which changes
   * how the passage sounds rather than how it is marked. When the pitches do
   * meet, nothing needs doing and the tie simply survives.
   */
  if (before && !sameNotes(before.tieOut, incoming.tieIn)) {
    refusals.push({
      code: 'tie-crosses-boundary',
      detail:
        `A tie runs into this passage from the bar before it, and the replacement does not continue ` +
        `the same note${before.tieOut.length ? ` (${before.tieOut.join(', ')})` : ''}. A tie joins two ` +
        'noteheads into one sounding note, so this cannot be patched without changing either a pitch ' +
        'or how the passage sounds.',
      measureIndex: firstIndex
    });
  }
  if (after && !sameNotes(outgoing.tieOut, after.tieIn)) {
    refusals.push({
      code: 'tie-crosses-boundary',
      detail:
        `A tie runs out of this passage into the bar after it, and the replacement does not carry the ` +
        `same note${after.tieIn.length ? ` (${after.tieIn.join(', ')})` : ''} across. A tie joins two ` +
        'noteheads into one sounding note, so this cannot be patched without changing either a pitch ' +
        'or how the passage sounds.',
      measureIndex: lastIndex
    });
  }

  /**
   * A slur is a marking about the notes rather than part of what a note is, so
   * a severed one costs a phrase mark, not a performance — and OMR slur
   * detection is the least reliable thing either engine produces. Dropping the
   * half that no longer has an end is a repair, reported rather than silent.
   */
  if (before && before.slurOut !== incoming.slurIn) {
    repairs.push({
      code: 'drop-dangling-slur',
      detail:
        'A slur reaching into this passage from the bar before it will lose its end. The phrase mark ' +
        'is dropped; no note changes.',
      measureIndex: firstIndex
    });
  }
  if (after && outgoing.slurOut !== after.slurIn) {
    repairs.push({
      code: 'drop-dangling-slur',
      detail:
        'A slur reaching out of this passage into the bar after it will lose its start. The phrase ' +
        'mark is dropped; no note changes.',
      measureIndex: lastIndex
    });
  }

  return { safe: refusals.length === 0, refusals, repairs };
}
