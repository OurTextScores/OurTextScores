import { XMLBuilder } from 'fast-xml-parser';
import { musicXmlParser, parseValidMusicXml } from './scanner-musicxml';
import { contents, directEntries, directText, type OrderedEntry } from './scanner-musicxml-tree';
import { readScannerSpliceFacts } from './scanner-splice-safety';
import {
  validateScannerMusicXmlSemantics,
  type ScannerSemanticViolation
} from './scanner-musicxml-semantics';

export const SCANNER_MARKING_TRANSFER_VERSION = 'scanner-marking-transfer-v1';

/**
 * Why one reading's markings cannot be laid over another's notes.
 *
 * `notes-differ` is the whole of it in practice. A dynamic sits at a place in
 * the bar and a lyric sits on a note; if the two readings do not agree about
 * what the notes are, there is no such place and no such note, and putting the
 * marking somewhere plausible is guessing about the one thing the reviewer is
 * trying to establish.
 */
export type ScannerMarkingRefusalCode = 'notes-differ' | 'span-mismatch' | 'nothing-to-transfer';

export interface ScannerMarkingRefusal {
  code: ScannerMarkingRefusalCode;
  detail: string;
  measureIndex?: number;
}

export interface ScannerMarkingTransferOutcome {
  musicXml: Buffer | null;
  refusals: ScannerMarkingRefusal[];
  /** What moved, so the reviewer sees the size of what they just did. */
  transferred: { directions: number; lyrics: number };
  violations: ScannerSemanticViolation[];
}

const tagOf = (entry: OrderedEntry): string =>
  Object.keys(entry).filter((key) => key !== ':@')[0];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const orderedBuilder = () =>
  new XMLBuilder({
    ignoreAttributes: false,
    processEntities: false,
    format: true,
    suppressEmptyNode: true,
    preserveOrder: true
  });

/**
 * The rhythm of a measure, as the sequence of `(voice, duration)` its notes
 * make — chord members excluded, since they sound with the note before them.
 *
 * This is what has to match for a marking to have somewhere to go. It is
 * deliberately not the full descriptor: two readings can disagree about pitch,
 * spelling or beaming and still place a dynamic in exactly the same instant.
 */
function rhythmOf(measureChildren: OrderedEntry[], scale: bigint): string[] {
  const shape: string[] = [];
  for (const child of measureChildren) {
    if (tagOf(child) !== 'note') continue;
    const inner = contents(child, 'note');
    if (directEntries(inner, 'chord').length > 0) continue;
    const duration = directText(inner, 'duration');
    const value = /^\d+$/.test(duration) ? BigInt(duration) * scale : BigInt(0);
    shape.push(`${directText(inner, 'voice') || '1'}:${value.toString()}`);
  }
  return shape;
}

/** Notes in document order, chord members included: lyrics attach per note. */
const notesOf = (measureChildren: OrderedEntry[]): OrderedEntry[] =>
  measureChildren.filter((child) => tagOf(child) === 'note');

/** `<direction>` elements with the note index they precede. */
function directionsOf(measureChildren: OrderedEntry[]): Array<{
  before: number;
  element: OrderedEntry;
}> {
  const found: Array<{ before: number; element: OrderedEntry }> = [];
  let noteIndex = 0;
  for (const child of measureChildren) {
    const tag = tagOf(child);
    if (tag === 'note') {
      noteIndex += 1;
      continue;
    }
    if (tag === 'direction') found.push({ before: noteIndex, element: child });
  }
  return found;
}

/** Rewrite `<offset>` values, which are in divisions like a duration is. */
function rescaleOffsets(entries: OrderedEntry[], numerator: bigint, denominator: bigint): void {
  if (numerator === denominator) return;
  for (const entry of entries) {
    const tag = tagOf(entry);
    if (!tag) continue;
    const children: OrderedEntry[] = entry[tag];
    if (!Array.isArray(children)) continue;
    if (tag === 'offset') {
      const text = children.find((child) =>
        Object.prototype.hasOwnProperty.call(child, '#text')
      );
      if (text && /^-?\d+$/.test(String(text['#text']))) {
        const value = BigInt(String(text['#text']));
        text['#text'] = ((value * numerator) / denominator).toString();
      }
      continue;
    }
    rescaleOffsets(children, numerator, denominator);
  }
}

/**
 * Lay one reading's dynamics and lyrics over another's notes.
 *
 * The operation §4 calls the clearest single argument for a purpose-built mode,
 * and it exists because Transcoda declares `lyrics` and `dynamics` unsupported:
 * when its notes are the better reading, everything HOMR heard *about* those
 * notes is still only in HOMR.
 *
 * Markings are placed by where they sit among the notes rather than by their
 * `<offset>`, so nothing has to be recomputed — but that only works if both
 * readings agree about the notes, which is what this refuses without.
 */
export function transferScannerMarkings(input: {
  baseXml: Buffer;
  candidateXml: Buffer;
  basePartIndex: number;
  candidatePartIndex: number;
  baseMeasureIndexes: readonly number[];
  candidateMeasureIndexes: readonly number[];
}): ScannerMarkingTransferOutcome {
  const empty = { directions: 0, lyrics: 0 };
  if (
    input.baseMeasureIndexes.length === 0 ||
    input.baseMeasureIndexes.length !== input.candidateMeasureIndexes.length
  ) {
    return {
      musicXml: null,
      refusals: [
        {
          code: 'span-mismatch',
          detail:
            'Markings are laid over notes bar for bar, so this needs the same number of bars on ' +
            'both sides. A passage one reading does not have has nowhere to put them.'
        }
      ],
      transferred: empty,
      violations: []
    };
  }

  parseValidMusicXml(input.baseXml);
  parseValidMusicXml(input.candidateXml);
  const baseFacts = readScannerSpliceFacts(input.baseXml);
  const candidateFacts = readScannerSpliceFacts(input.candidateXml);
  const parse = (xml: Buffer) => musicXmlParser({ preserveOrder: true }).parse(xml.toString('utf8'));
  const baseTree = parse(input.baseXml);
  const rootOf = (tree: any) =>
    (Array.isArray(tree)
      ? tree.find((entry: OrderedEntry) =>
          Object.prototype.hasOwnProperty.call(entry, 'score-partwise')
        )
      : undefined)?.['score-partwise'];
  const baseRoot = rootOf(baseTree);
  const candidateRoot = rootOf(parse(input.candidateXml));
  if (!Array.isArray(baseRoot) || !Array.isArray(candidateRoot)) {
    throw new Error('Scanner marking transfer could not read one of the documents');
  }

  const basePart = directEntries(baseRoot, 'part')[input.basePartIndex];
  const candidatePart = directEntries(candidateRoot, 'part')[input.candidatePartIndex];
  const baseMeasures = directEntries(basePart.part, 'measure');
  const candidateMeasures = directEntries(candidatePart.part, 'measure');

  const refusals: ScannerMarkingRefusal[] = [];
  const transferred = { directions: 0, lyrics: 0 };
  const pending: Array<() => void> = [];

  input.baseMeasureIndexes.forEach((baseIndex, position) => {
    const candidateIndex = input.candidateMeasureIndexes[position];
    const baseMeasure = baseMeasures[baseIndex];
    const candidateMeasure = candidateMeasures[candidateIndex];
    if (!baseMeasure || !candidateMeasure) {
      refusals.push({
        code: 'span-mismatch',
        detail: 'One of these bars is not present in the reading it was named in.',
        measureIndex: baseIndex
      });
      return;
    }
    const baseChildren: OrderedEntry[] = baseMeasure.measure;
    const candidateChildren: OrderedEntry[] = candidateMeasure.measure;
    const baseUnit = BigInt(baseFacts[input.basePartIndex].measures[baseIndex].divisions);
    const candidateUnit = BigInt(
      candidateFacts[input.candidatePartIndex].measures[candidateIndex].divisions
    );

    // Cross-multiplied into a shared unit, so two readings that agree musically
    // but count differently are not treated as disagreeing — the Bach case,
    // where one reads in divisions 4 and the other in 10080.
    const baseShape = rhythmOf(baseChildren, candidateUnit);
    const candidateShape = rhythmOf(candidateChildren, baseUnit);
    if (
      baseShape.length !== candidateShape.length ||
      baseShape.some((value, index) => value !== candidateShape[index])
    ) {
      refusals.push({
        code: 'notes-differ',
        detail:
          'The two readings do not agree about the notes in this bar, so there is no place to put ' +
          'a dynamic and no note to put a lyric on. Take the bar itself first, then its markings.',
        measureIndex: baseIndex
      });
      return;
    }

    const baseNotes = notesOf(baseChildren);
    const candidateNotes = notesOf(candidateChildren);
    const incomingDirections = directionsOf(candidateChildren);
    const incomingLyrics = candidateNotes.map((note) =>
      directEntries(contents(note, 'note'), 'lyric')
    );
    if (
      incomingDirections.length === 0 &&
      incomingLyrics.every((lyrics) => lyrics.length === 0)
    ) {
      return;
    }

    // Applied only once every bar has been checked, so a refusal anywhere
    // leaves the document untouched rather than half-transferred.
    pending.push(() => {
      // The base's own markings go: this replaces them rather than merging two
      // engines' guesses about the same phrase into one bar.
      const stripped = baseChildren.filter((child) => tagOf(child) !== 'direction');
      for (const note of baseNotes) {
        note.note = (note.note as OrderedEntry[]).filter((entry) => tagOf(entry) !== 'lyric');
      }

      const rebuilt: OrderedEntry[] = [];
      let noteIndex = 0;
      const insertBefore = (index: number) => {
        for (const direction of incomingDirections.filter((entry) => entry.before === index)) {
          const copy = clone(direction.element);
          rescaleOffsets([copy], baseUnit, candidateUnit);
          rebuilt.push(copy);
          transferred.directions += 1;
        }
      };
      for (const child of stripped) {
        if (tagOf(child) !== 'note') {
          rebuilt.push(child);
          continue;
        }
        insertBefore(noteIndex);
        const lyrics = incomingLyrics[noteIndex] || [];
        if (lyrics.length > 0) {
          child.note = [...(child.note as OrderedEntry[]), ...lyrics.map((lyric) => clone(lyric))];
          transferred.lyrics += lyrics.length;
        }
        rebuilt.push(child);
        noteIndex += 1;
      }
      insertBefore(noteIndex);
      baseMeasure.measure = rebuilt;
    });
  });

  if (refusals.length > 0) {
    return { musicXml: null, refusals, transferred: empty, violations: [] };
  }
  if (pending.length === 0) {
    return {
      musicXml: null,
      refusals: [
        {
          code: 'nothing-to-transfer',
          detail: 'That reading has no dynamics or lyrics here, so there is nothing to take.'
        }
      ],
      transferred: empty,
      violations: []
    };
  }
  for (const apply of pending) apply();

  const musicXml = Buffer.from(orderedBuilder().build(baseTree));
  const report = validateScannerMusicXmlSemantics(musicXml);
  if (!report.valid) {
    return { musicXml: null, refusals: [], transferred, violations: report.violations };
  }
  return { musicXml, refusals: [], transferred, violations: [] };
}
