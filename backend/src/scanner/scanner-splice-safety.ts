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
export interface ScannerSpliceAssessment {
  safe: boolean;
  refusals: ScannerSpliceRefusal[];
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
  /** A tie or slur that begins here and is not closed before the measure ends. */
  opensTie: boolean;
  opensSlur: boolean;
  /** A tie or slur that closes here but was opened in an earlier measure. */
  closesTie: boolean;
  closesSlur: boolean;
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
  let openTies = 0;
  let openSlurs = 0;
  let closedTiesFromEarlier = 0;
  let closedSlursFromEarlier = 0;

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

    for (const type of tieTypesOf(inner)) {
      if (type === 'start') openTies += 1;
      else if (type === 'stop') {
        if (openTies > 0) openTies -= 1;
        else closedTiesFromEarlier += 1;
      }
    }
    for (const type of slurTypesOf(inner)) {
      if (type === 'start') openSlurs += 1;
      else if (type === 'stop') {
        if (openSlurs > 0) openSlurs -= 1;
        else closedSlursFromEarlier += 1;
      }
    }
  }

  return {
    duration: longest.toString(),
    durationGcd: gcd.toString(),
    voices: [...voices].sort(),
    staves: [...staves].sort(),
    opensTie: openTies > 0,
    opensSlur: openSlurs > 0,
    closesTie: closedTiesFromEarlier > 0,
    closesSlur: closedSlursFromEarlier > 0
  };
}

function tieTypesOf(noteChildren: OrderedEntry[]): string[] {
  const types: string[] = [];
  for (const tie of directEntries(noteChildren, 'tie')) {
    const type = attrs(tie)['@_type'];
    if (type) types.push(String(type));
  }
  for (const notations of directEntries(noteChildren, 'notations')) {
    for (const tied of directEntries(contents(notations, 'notations'), 'tied')) {
      const type = attrs(tied)['@_type'];
      if (type) types.push(String(type));
    }
  }
  return types;
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
}): ScannerSpliceAssessment {
  const refusals: ScannerSpliceRefusal[] = [];
  const basePart = input.base[input.basePartIndex];
  const candidatePart = input.candidate[input.candidatePartIndex];
  const baseSpan = spanOf(basePart, input.baseMeasureIndexes);
  const candidateSpan = spanOf(candidatePart, input.candidateMeasureIndexes);

  if (input.baseMeasureIndexes.length === 0 || input.candidateMeasureIndexes.length === 0) {
    return {
      safe: false,
      refusals: [
        {
          code: 'span-empty',
          detail:
            'One reading has no measure here, so this is an insertion or a deletion rather than a ' +
            'replacement — it changes how many bars the part has, and every later bar with it. That ' +
            'is a different decision from taking a bar, and is not offered yet.'
        }
      ]
    };
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
      ]
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

  // A measure is not independent of its neighbours. Ties, slurs and beams cross
  // boundaries, and a splice that severs one emits a document that looks
  // plausible and is wrong — exactly what assembly already declines to do.
  const first = 0;
  const last = baseSpan.length - 1;
  const crossings: Array<[boolean, ScannerSpliceRefusalCode, string]> = [
    [
      baseSpan[first].closesTie || candidateSpan[first].closesTie,
      'tie-crosses-boundary',
      'A tie begins before this passage and ends inside it'
    ],
    [
      baseSpan[last].opensTie || candidateSpan[candidateSpan.length - 1].opensTie,
      'tie-crosses-boundary',
      'A tie begins inside this passage and ends after it'
    ],
    [
      baseSpan[first].closesSlur || candidateSpan[first].closesSlur,
      'slur-crosses-boundary',
      'A slur begins before this passage and ends inside it'
    ],
    [
      baseSpan[last].opensSlur || candidateSpan[candidateSpan.length - 1].opensSlur,
      'slur-crosses-boundary',
      'A slur begins inside this passage and ends after it'
    ]
  ];
  for (const [crosses, code, description] of crossings) {
    if (!crosses) continue;
    refusals.push({
      code,
      detail: `${description}, so replacing it would leave the other end unresolved.`,
      measureIndex: input.baseMeasureIndexes[first]
    });
  }

  return { safe: refusals.length === 0, refusals };
}
