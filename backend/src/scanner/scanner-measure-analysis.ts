import { createHash } from 'node:crypto';
import { alignSequenceLcs } from '../common/sequence-alignment';
import { musicXmlParser, parseValidMusicXml } from './scanner-musicxml';

export const SCANNER_COARSE_MEASURE_KEY_VERSION = 'scanner-measure-coarse-v1';
export const SCANNER_MEASURE_DESCRIPTOR_VERSION = 'scanner-measure-descriptor-v1';
export const SCANNER_MEASURE_ALIGNMENT_VERSION = 'scanner-measure-alignment-v2';
export const MAX_SCANNER_MEASURES_PER_PART = 1024;
export const MAX_SCANNER_FUZZY_EVENTS_PER_MEASURE = 512;
export const MAX_SCANNER_FUZZY_LCS_CELLS = 2_000_000;

const MIN_SCANNER_FUZZY_COUNT_RATIO = 0.55;
const MIN_SCANNER_FUZZY_PITCH_COVERAGE = 0.55;
const MIN_SCANNER_FUZZY_SIMILARITY = 0.62;
const SCANNER_FUZZY_UNIQUE_MARGIN = 0.08;
const SCANNER_FUZZY_BOUNDED_UNIQUE_MARGIN = 0.04;
const MAX_SCANNER_FUZZY_POSITION_DISTANCE = 0.18;
const SCANNER_FUZZY_POSITION_PENALTY = 0.3;

export type ScannerMeasureDifferenceClass =
  | 'notation'
  | 'voice'
  | 'staff'
  | 'attributes'
  | 'lyrics'
  | 'dynamics'
  | 'directions'
  | 'notations';

export interface ScannerMeasureComponentHashes {
  notation: string;
  voice: string;
  staff: string;
  attributes: string;
  lyrics: string;
  dynamics: string;
  directions: string;
  notations: string;
}

export interface ScannerMeasureDescriptor {
  measureIndex: number;
  measureNumber?: string;
  coarseKey: string;
  richHash: string;
  componentHashes: ScannerMeasureComponentHashes;
  eventCount: number;
  /** Hashed, notation-only event sketches used to locate non-identical measures. */
  alignment?: {
    events: string[];
    pitches: string[];
    durations: string[];
  };
}

export interface ScannerDescribedPart {
  documentPartId: string;
  measures: ScannerMeasureDescriptor[];
}

export type ScannerMeasureAlignmentOp =
  | { type: 'equal'; baseIndex: number; candidateIndex: number }
  | { type: 'aligned'; baseIndex: number; candidateIndex: number; similarity: number }
  | { type: 'removed'; baseIndex: number }
  | { type: 'added'; candidateIndex: number };

type OrderedEntry = Record<string, any>;
type Fraction = readonly [bigint, bigint];

interface SemanticNote {
  onset: string;
  duration: string;
  pitch: string;
  ties: string[];
  voice: string;
  staff: string;
  chord: boolean;
  grace: boolean;
  notations: unknown[];
  lyrics: unknown[];
}

interface CoarseEvent {
  members: Array<{ pitch: string; duration: string; ties: string[] }>;
}

const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const zero: Fraction = [BIGINT_ZERO, BIGINT_ONE];

const gcd = (left: bigint, right: bigint): bigint => {
  let a = left < BIGINT_ZERO ? -left : left;
  let b = right < BIGINT_ZERO ? -right : right;
  while (b !== BIGINT_ZERO) [a, b] = [b, a % b];
  return a || BIGINT_ONE;
};

const fraction = (numerator: bigint, denominator: bigint): Fraction => {
  if (denominator <= BIGINT_ZERO) {
    throw new Error('MusicXML divisions must be a positive integer');
  }
  const divisor = gcd(numerator, denominator);
  return [numerator / divisor, denominator / divisor];
};

const add = (left: Fraction, right: Fraction): Fraction =>
  fraction(left[0] * right[1] + right[0] * left[1], left[1] * right[1]);

const subtract = (left: Fraction, right: Fraction): Fraction =>
  fraction(left[0] * right[1] - right[0] * left[1], left[1] * right[1]);

const formatFraction = (value: Fraction): string =>
  value[1] === BIGINT_ONE ? String(value[0]) : `${value[0]}/${value[1]}`;

const parsePositiveInteger = (value: string, label: string): bigint => {
  if (!/^\d+$/.test(value) || BigInt(value) <= BIGINT_ZERO) {
    throw new Error(`MusicXML ${label} must be a positive integer`);
  }
  return BigInt(value);
};

const parseInteger = (value: string, label: string): bigint => {
  if (!/^-?\d+$/.test(value)) throw new Error(`MusicXML ${label} must be an integer`);
  return BigInt(value);
};

const attrs = (entry: OrderedEntry): Record<string, string> => entry?.[':@'] || {};

const contents = (entry: OrderedEntry, tag: string): OrderedEntry[] =>
  Array.isArray(entry?.[tag]) ? entry[tag] : [];

const directEntries = (children: OrderedEntry[], tag: string): OrderedEntry[] =>
  children.filter((entry) => Object.prototype.hasOwnProperty.call(entry, tag));

const firstEntry = (children: OrderedEntry[], tag: string): OrderedEntry | undefined =>
  directEntries(children, tag)[0];

const entryText = (entry: OrderedEntry | undefined, tag: string): string => {
  const child = entry ? contents(entry, tag) : [];
  const textEntry = child.find((item) => Object.prototype.hasOwnProperty.call(item, '#text'));
  return String(textEntry?.['#text'] ?? '').trim();
};

const directText = (children: OrderedEntry[], tag: string): string =>
  entryText(firstEntry(children, tag), tag);

const canonicalNumber = (value: string): string => {
  if (!value) return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : value;
};

const semanticAttributes = (entry: OrderedEntry): Record<string, string> =>
  Object.fromEntries(
    Object.entries(attrs(entry))
      .filter(
        ([key, value]) =>
          ![
            '@_default-x',
            '@_default-y',
            '@_relative-x',
            '@_relative-y',
            '@_font-family',
            '@_font-size',
            '@_font-style',
            '@_font-weight',
            '@_color',
            '@_placement',
            '@_print-object'
          ].includes(key) && !(key === '@_number' && String(value) === '1')
      )
      .sort(([left], [right]) => left.localeCompare(right))
  );

function canonicalOrdered(children: OrderedEntry[], omittedTags = new Set<string>()): unknown[] {
  const result: unknown[] = [];
  for (const entry of children) {
    if (Object.prototype.hasOwnProperty.call(entry, '#text')) {
      const value = String(entry['#text'] ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (value) result.push(value);
      continue;
    }
    result.push(
      ...Object.keys(entry)
        .filter((tag) => tag !== ':@' && !omittedTags.has(tag))
        .sort()
        .map((tag) => ({
          tag,
          attributes: semanticAttributes(entry),
          children: canonicalOrdered(contents(entry, tag), omittedTags)
        }))
    );
  }
  return result;
}

const signature = (version: string, value: unknown): string =>
  `${version}:${createHash('sha256')
    .update(JSON.stringify([version, value]))
    .digest('hex')}`;

function notePitch(children: OrderedEntry[]): string {
  if (firstEntry(children, 'rest')) return 'R';
  const pitch = firstEntry(children, 'pitch');
  if (pitch) {
    const pitchChildren = contents(pitch, 'pitch');
    const step = directText(pitchChildren, 'step').toUpperCase();
    const alter = canonicalNumber(directText(pitchChildren, 'alter') || '0');
    const octave = canonicalNumber(directText(pitchChildren, 'octave'));
    if (!/^[A-G]$/.test(step) || !octave) throw new Error('MusicXML note has an invalid pitch');
    return `${step}:${alter}:${octave}`;
  }
  const unpitched = firstEntry(children, 'unpitched');
  if (unpitched) {
    const display = contents(unpitched, 'unpitched');
    return `U:${directText(display, 'display-step').toUpperCase()}:${canonicalNumber(
      directText(display, 'display-octave')
    )}`;
  }
  throw new Error('MusicXML note is neither pitched, unpitched, nor a rest');
}

function tieTypes(children: OrderedEntry[]): string[] {
  const types = new Set<string>();
  for (const tie of directEntries(children, 'tie')) {
    const type = attrs(tie)['@_type'];
    if (type) types.add(String(type));
  }
  for (const notations of directEntries(children, 'notations')) {
    for (const tied of directEntries(contents(notations, 'notations'), 'tied')) {
      const type = attrs(tied)['@_type'];
      if (type) types.add(String(type));
    }
  }
  return [...types].sort();
}

function noteNotations(children: OrderedEntry[]): unknown[] {
  return directEntries(children, 'notations').flatMap((notations) =>
    canonicalOrdered(contents(notations, 'notations'), new Set(['tied', 'dynamics']))
  );
}

function noteDynamics(children: OrderedEntry[]): unknown[] {
  return directEntries(children, 'notations').flatMap((notations) =>
    directEntries(contents(notations, 'notations'), 'dynamics').flatMap((dynamics) =>
      canonicalOrdered(contents(dynamics, 'dynamics'))
    )
  );
}

function noteLyrics(children: OrderedEntry[]): unknown[] {
  return directEntries(children, 'lyric').map((lyric) => ({
    number: String(attrs(lyric)['@_number'] || ''),
    value: canonicalOrdered(contents(lyric, 'lyric'))
  }));
}

function attributeChanges(entry: OrderedEntry, state: Map<string, string>): unknown[] {
  const children = contents(entry, 'attributes');
  const changes: unknown[] = [];
  for (const child of children) {
    const tag = Object.keys(child).find((key) => key !== ':@');
    if (!tag || tag === 'divisions') continue;
    const canonical = canonicalOrdered([child]);
    const identity = `${tag}:${String(attrs(child)['@_number'] || '1')}`;
    const serialized = JSON.stringify(canonical);
    if (state.get(identity) === serialized) continue;
    state.set(identity, serialized);
    changes.push(...canonical);
  }
  return changes;
}

function compareFractionStrings(left: string, right: string): number {
  const parse = (value: string): Fraction => {
    const [numerator, denominator = '1'] = value.split('/');
    return [BigInt(numerator), BigInt(denominator)];
  };
  const a = parse(left);
  const b = parse(right);
  const difference = a[0] * b[1] - b[0] * a[1];
  return difference < BIGINT_ZERO ? -1 : difference > BIGINT_ZERO ? 1 : 0;
}

function describeMeasure(
  measure: OrderedEntry,
  measureIndex: number,
  initialDivisions: bigint,
  attributeState: Map<string, string>
): { descriptor: ScannerMeasureDescriptor; divisions: bigint } {
  const measureChildren = contents(measure, 'measure');
  let divisions = initialDivisions;
  let cursor = zero;
  let previousNoteOnset = zero;
  const notes: SemanticNote[] = [];
  const coarseEvents: CoarseEvent[] = [];
  const attributes: unknown[] = [];
  const dynamics: unknown[] = [];
  const directions: unknown[] = [];

  for (const child of measureChildren) {
    if (Object.prototype.hasOwnProperty.call(child, 'attributes')) {
      const declared = directText(contents(child, 'attributes'), 'divisions');
      if (declared) divisions = parsePositiveInteger(declared, 'divisions');
      attributes.push(...attributeChanges(child, attributeState));
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(child, 'backup')) {
      const raw = directText(contents(child, 'backup'), 'duration');
      cursor = subtract(cursor, fraction(parsePositiveInteger(raw, 'backup duration'), divisions));
      if (cursor[0] < BIGINT_ZERO) throw new Error('MusicXML backup moves before the measure');
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(child, 'forward')) {
      const raw = directText(contents(child, 'forward'), 'duration');
      cursor = add(cursor, fraction(parsePositiveInteger(raw, 'forward duration'), divisions));
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(child, 'direction')) {
      const directionChildren = contents(child, 'direction');
      const rawOffset = directText(directionChildren, 'offset');
      const directionOnset = rawOffset
        ? add(cursor, fraction(parseInteger(rawOffset, 'direction offset'), divisions))
        : cursor;
      const context = {
        onset: formatFraction(directionOnset),
        voice: canonicalNumber(directText(directionChildren, 'voice')) || undefined,
        staff: canonicalNumber(directText(directionChildren, 'staff')) || undefined
      };
      const directionTypes = directEntries(directionChildren, 'direction-type');
      for (const directionType of directionTypes) {
        const typeChildren = contents(directionType, 'direction-type');
        dynamics.push(
          ...directEntries(typeChildren, 'dynamics').flatMap((item) =>
            canonicalOrdered(contents(item, 'dynamics')).map((value) => ({ context, value }))
          )
        );
        directions.push(
          ...canonicalOrdered(typeChildren, new Set(['dynamics'])).map((value) => ({
            context,
            value
          }))
        );
      }
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(child, 'note')) continue;

    const noteChildren = contents(child, 'note');
    const chord = Boolean(firstEntry(noteChildren, 'chord'));
    const grace = Boolean(firstEntry(noteChildren, 'grace'));
    const rawDuration = directText(noteChildren, 'duration');
    const duration = grace
      ? zero
      : fraction(parsePositiveInteger(rawDuration, 'note duration'), divisions);
    const onset = chord ? previousNoteOnset : cursor;
    const pitch = notePitch(noteChildren);
    const ties = tieTypes(noteChildren);
    const semantic: SemanticNote = {
      onset: formatFraction(onset),
      duration: formatFraction(duration),
      pitch,
      ties,
      voice: canonicalNumber(directText(noteChildren, 'voice')) || '1',
      staff: canonicalNumber(directText(noteChildren, 'staff')) || '1',
      chord,
      grace,
      notations: noteNotations(noteChildren),
      lyrics: noteLyrics(noteChildren)
    };
    notes.push(semantic);
    dynamics.push(
      ...noteDynamics(noteChildren).map((value) => ({
        onset: semantic.onset,
        pitch: semantic.pitch,
        value
      }))
    );

    const member = { pitch, duration: semantic.duration, ties };
    if (chord) {
      const previous = coarseEvents[coarseEvents.length - 1];
      if (!previous) throw new Error('MusicXML chord member has no preceding note');
      previous.members.push(member);
    } else {
      coarseEvents.push({ members: [member] });
      previousNoteOnset = onset;
      if (!grace) cursor = add(cursor, duration);
    }
  }

  const sortedNotes = [...notes].sort(
    (left, right) =>
      compareFractionStrings(left.onset, right.onset) ||
      left.pitch.localeCompare(right.pitch) ||
      compareFractionStrings(left.duration, right.duration) ||
      left.ties.join(',').localeCompare(right.ties.join(','))
  );
  const sortedCoarse = coarseEvents.map((event) => ({
    members: [...event.members].sort((left, right) => left.pitch.localeCompare(right.pitch))
  }));
  const alignment = {
    events: sortedCoarse.map((event) =>
      signature(`${SCANNER_MEASURE_ALIGNMENT_VERSION}:event`, event)
    ),
    pitches: sortedCoarse.map((event) =>
      signature(
        `${SCANNER_MEASURE_ALIGNMENT_VERSION}:pitch`,
        event.members.map((member) => member.pitch)
      )
    ),
    durations: sortedCoarse.map((event) =>
      signature(
        `${SCANNER_MEASURE_ALIGNMENT_VERSION}:duration`,
        event.members.map((member) => member.duration)
      )
    )
  };
  const stableSort = <T>(values: T[]): T[] =>
    values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const notation = sortedNotes.map(
    ({
      voice: _voice,
      staff: _staff,
      chord: _chord,
      lyrics: _lyrics,
      notations: _notations,
      ...note
    }) => note
  );
  const voices = sortedNotes.map((note) => note.voice);
  const staves = sortedNotes.map((note) => note.staff);
  const lyrics = stableSort(
    sortedNotes.flatMap((note, eventIndex) => note.lyrics.map((lyric) => ({ eventIndex, lyric })))
  );
  const notations = stableSort(
    sortedNotes.flatMap((note, eventIndex) =>
      note.notations.map((value) => ({ eventIndex, value }))
    )
  );
  const components = {
    notation,
    voices,
    staves,
    attributes,
    lyrics,
    dynamics,
    directions,
    notations
  };
  const componentHashes: ScannerMeasureComponentHashes = {
    notation: signature(`${SCANNER_MEASURE_DESCRIPTOR_VERSION}:notation`, notation),
    voice: signature(`${SCANNER_MEASURE_DESCRIPTOR_VERSION}:voice`, voices),
    staff: signature(`${SCANNER_MEASURE_DESCRIPTOR_VERSION}:staff`, staves),
    attributes: signature(`${SCANNER_MEASURE_DESCRIPTOR_VERSION}:attributes`, attributes),
    lyrics: signature(`${SCANNER_MEASURE_DESCRIPTOR_VERSION}:lyrics`, lyrics),
    dynamics: signature(`${SCANNER_MEASURE_DESCRIPTOR_VERSION}:dynamics`, dynamics),
    directions: signature(`${SCANNER_MEASURE_DESCRIPTOR_VERSION}:directions`, directions),
    notations: signature(`${SCANNER_MEASURE_DESCRIPTOR_VERSION}:notations`, notations)
  };
  return {
    descriptor: {
      measureIndex,
      measureNumber: String(attrs(measure)['@_number'] || '') || undefined,
      coarseKey: signature(SCANNER_COARSE_MEASURE_KEY_VERSION, sortedCoarse),
      richHash: signature(SCANNER_MEASURE_DESCRIPTOR_VERSION, components),
      componentHashes,
      eventCount: notes.length,
      alignment
    },
    divisions
  };
}

/** Parse validated MusicXML into per-part alignment keys and rich equality descriptors. */
export function describeScannerMusicXmlMeasures(musicXml: Buffer): ScannerDescribedPart[] {
  const { rootName } = parseValidMusicXml(musicXml);
  if (rootName !== 'score-partwise') {
    throw new Error('Scanner measure analysis requires score-partwise MusicXML');
  }
  const ordered = musicXmlParser({ preserveOrder: true }).parse(musicXml.toString('utf8'));
  const rootEntry = Array.isArray(ordered)
    ? ordered.find((entry) => Object.prototype.hasOwnProperty.call(entry, 'score-partwise'))
    : undefined;
  const root = rootEntry?.['score-partwise'];
  if (!Array.isArray(root)) throw new Error('Scanner measure analysis could not read MusicXML');
  const seenPartIds = new Set<string>();
  return directEntries(root, 'part').map((part) => {
    const documentPartId = String(attrs(part)['@_id'] || '');
    if (!documentPartId || seenPartIds.has(documentPartId)) {
      throw new Error('MusicXML parts must have unique non-empty document IDs');
    }
    seenPartIds.add(documentPartId);
    const measures = directEntries(contents(part, 'part'), 'measure');
    if (measures.length === 0 || measures.length > MAX_SCANNER_MEASURES_PER_PART) {
      throw new Error(
        `Scanner measure analysis supports between 1 and ${MAX_SCANNER_MEASURES_PER_PART} measures per part`
      );
    }
    let divisions = BIGINT_ONE;
    const attributeState = new Map<string, string>();
    const descriptors = measures.map((measure, measureIndex) => {
      const described = describeMeasure(measure, measureIndex, divisions, attributeState);
      divisions = described.divisions;
      return described.descriptor;
    });
    return { documentPartId, measures: descriptors };
  });
}

/** Rich equality classes; the coarse key is never used to claim equality. */
export function classifyScannerMeasureDifference(
  base: ScannerMeasureDescriptor,
  candidate: ScannerMeasureDescriptor
): ScannerMeasureDifferenceClass[] {
  const classes: ScannerMeasureDifferenceClass[] = [];
  for (const key of Object.keys(base.componentHashes) as Array<
    keyof ScannerMeasureComponentHashes
  >) {
    if (base.componentHashes[key] !== candidate.componentHashes[key]) classes.push(key);
  }
  return classes;
}

/** Reusable LCS over coarse keys; insertions do not shift every later measure. */
export function alignScannerMeasureKeys(
  baseKeys: readonly string[],
  candidateKeys: readonly string[]
): ScannerMeasureAlignmentOp[] {
  if (
    baseKeys.length > MAX_SCANNER_MEASURES_PER_PART ||
    candidateKeys.length > MAX_SCANNER_MEASURES_PER_PART
  ) {
    throw new Error(
      `Scanner measure alignment is limited to ${MAX_SCANNER_MEASURES_PER_PART} keys`
    );
  }
  return alignSequenceLcs(baseKeys, candidateKeys);
}

function lcsMatchCount(left: readonly string[], right: readonly string[]): number {
  return alignSequenceLcs(left, right).filter((op) => op.type === 'equal').length;
}

function scannerMeasureSimilarity(
  base: ScannerMeasureDescriptor,
  candidate: ScannerMeasureDescriptor
): number | undefined {
  const left = base.alignment;
  const right = candidate.alignment;
  if (!left || !right || left.events.length < 3 || right.events.length < 3) return undefined;
  if (
    left.events.length > MAX_SCANNER_FUZZY_EVENTS_PER_MEASURE ||
    right.events.length > MAX_SCANNER_FUZZY_EVENTS_PER_MEASURE
  ) {
    return undefined;
  }
  const longerCount = Math.max(left.events.length, right.events.length);
  const shorterCount = Math.min(left.events.length, right.events.length);
  const countRatio = shorterCount / longerCount;
  if (countRatio < MIN_SCANNER_FUZZY_COUNT_RATIO) return undefined;

  const pitchCoverage = lcsMatchCount(left.pitches, right.pitches) / longerCount;
  if (pitchCoverage < MIN_SCANNER_FUZZY_PITCH_COVERAGE) return undefined;
  const eventCoverage = lcsMatchCount(left.events, right.events) / longerCount;
  const durationCoverage = lcsMatchCount(left.durations, right.durations) / longerCount;
  const score =
    0.65 * pitchCoverage + 0.2 * eventCoverage + 0.1 * durationCoverage + 0.05 * countRatio;
  return score >= MIN_SCANNER_FUZZY_SIMILARITY ? score : undefined;
}

function alignScannerMeasureSpan(
  base: readonly ScannerMeasureDescriptor[],
  candidate: readonly ScannerMeasureDescriptor[],
  baseOffset: number,
  candidateOffset: number,
  boundedByExactAnchors: boolean
): ScannerMeasureAlignmentOp[] {
  if (base.length === 0) {
    return candidate.map((_measure, index) => ({
      type: 'added' as const,
      candidateIndex: candidateOffset + index
    }));
  }
  if (candidate.length === 0) {
    return base.map((_measure, index) => ({
      type: 'removed' as const,
      baseIndex: baseOffset + index
    }));
  }

  const baseEventCount = base.reduce(
    (total, measure) => total + (measure.alignment?.events.length || 0),
    0
  );
  const candidateEventCount = candidate.reduce(
    (total, measure) => total + (measure.alignment?.events.length || 0),
    0
  );
  if (baseEventCount * candidateEventCount * 3 > MAX_SCANNER_FUZZY_LCS_CELLS) {
    return [
      ...base.map((_measure, index) => ({
        type: 'removed' as const,
        baseIndex: baseOffset + index
      })),
      ...candidate.map((_measure, index) => ({
        type: 'added' as const,
        candidateIndex: candidateOffset + index
      }))
    ];
  }

  const scores = base.map((baseMeasure, baseIndex) =>
    candidate.map((candidateMeasure, candidateIndex) => {
      const similarity = scannerMeasureSimilarity(baseMeasure, candidateMeasure);
      if (similarity === undefined) return undefined;
      if (!boundedByExactAnchors) return { similarity, rank: similarity };
      const basePosition = baseIndex / Math.max(1, base.length - 1);
      const candidatePosition = candidateIndex / Math.max(1, candidate.length - 1);
      const distance = Math.abs(basePosition - candidatePosition);
      if (distance > MAX_SCANNER_FUZZY_POSITION_DISTANCE) return undefined;
      return { similarity, rank: similarity - SCANNER_FUZZY_POSITION_PENALTY * distance };
    })
  );
  const ranked = (values: Array<number | undefined>): number[] =>
    values
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => right - left);
  const rowRanks = scores.map((row) => ranked(row.map((score) => score?.rank)));
  const columnRanks = candidate.map((_measure, candidateIndex) =>
    ranked(base.map((_baseMeasure, baseIndex) => scores[baseIndex][candidateIndex]?.rank))
  );
  const accepted = new Map<string, number>();
  for (let baseIndex = 0; baseIndex < base.length; baseIndex += 1) {
    for (let candidateIndex = 0; candidateIndex < candidate.length; candidateIndex += 1) {
      const score = scores[baseIndex][candidateIndex];
      if (score === undefined) continue;
      const row = rowRanks[baseIndex];
      const column = columnRanks[candidateIndex];
      const requiredMargin = boundedByExactAnchors
        ? SCANNER_FUZZY_BOUNDED_UNIQUE_MARGIN
        : SCANNER_FUZZY_UNIQUE_MARGIN;
      const rowUnique =
        score.rank === row[0] && (row.length === 1 || score.rank - row[1] >= requiredMargin);
      const columnUnique =
        score.rank === column[0] &&
        (column.length === 1 || score.rank - column[1] >= requiredMargin);
      if (rowUnique && columnUnique) {
        accepted.set(`${baseIndex}:${candidateIndex}`, score.similarity);
      }
    }
  }

  const baseItems = base.map((_measure, index) => index);
  const candidateItems = candidate.map((_measure, index) => index);
  const localOps = alignSequenceLcs(baseItems, candidateItems, (left, right) =>
    accepted.has(`${left}:${right}`)
  );
  return localOps.map((op): ScannerMeasureAlignmentOp => {
    if (op.type === 'removed') return { type: 'removed', baseIndex: baseOffset + op.baseIndex };
    if (op.type === 'added') {
      return { type: 'added', candidateIndex: candidateOffset + op.candidateIndex };
    }
    const similarity = accepted.get(`${op.baseIndex}:${op.candidateIndex}`);
    if (similarity === undefined) throw new Error('Scanner fuzzy alignment lost its match score');
    return {
      type: 'aligned',
      baseIndex: baseOffset + op.baseIndex,
      candidateIndex: candidateOffset + op.candidateIndex,
      similarity: Number(similarity.toFixed(6))
    };
  });
}

/**
 * Preserve exact LCS anchors, then conservatively locate similar measures only
 * inside each unmatched span. Fuzzy pairs must be mutual, unique best matches;
 * similarity locates correspondence and never claims rich equality.
 */
export function alignScannerMeasures(
  base: readonly ScannerMeasureDescriptor[],
  candidate: readonly ScannerMeasureDescriptor[]
): ScannerMeasureAlignmentOp[] {
  const exact = alignScannerMeasureKeys(
    base.map((measure) => measure.coarseKey),
    candidate.map((measure) => measure.coarseKey)
  );
  const result: ScannerMeasureAlignmentOp[] = [];
  let baseStart = 0;
  let candidateStart = 0;
  for (const op of exact) {
    if (op.type !== 'equal') continue;
    result.push(
      ...alignScannerMeasureSpan(
        base.slice(baseStart, op.baseIndex),
        candidate.slice(candidateStart, op.candidateIndex),
        baseStart,
        candidateStart,
        baseStart > 0
      ),
      op
    );
    baseStart = op.baseIndex + 1;
    candidateStart = op.candidateIndex + 1;
  }
  result.push(
    ...alignScannerMeasureSpan(
      base.slice(baseStart),
      candidate.slice(candidateStart),
      baseStart,
      candidateStart,
      false
    )
  );
  return result;
}
