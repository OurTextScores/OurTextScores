import { musicXmlParser, parseValidMusicXml } from './scanner-musicxml';
import {
  attrs,
  contents,
  directEntries,
  directText,
  type OrderedEntry
} from './scanner-musicxml-tree';

export const SCANNER_MUSICXML_SEMANTICS_VERSION = 'scanner-musicxml-semantics-v1';

/**
 * Invariants `parseValidMusicXml` cannot see.
 *
 * That function checks XML shape, root element and resource limits: a document
 * can pass it and still have a tie that goes nowhere, a voice that runs past
 * the bar line, or a measure that does not add up. §11.3 asks for semantic
 * invariants on top of the MuseScore render/load gate, and this is them —
 * cheaper than a render, and able to say *what* is wrong rather than only that
 * the engine refused to load it.
 *
 * Severity is the caller's decision, not this module's. A spliced document that
 * violates any of these should not be stored; the *same* violations in raw
 * engine output are a description of the page, and refusing to show them would
 * leave the reviewer nothing to review.
 */
export type ScannerSemanticViolationCode =
  | 'tie-unresolved'
  | 'tie-unstarted'
  | 'voice-underruns-bar'
  | 'voice-overruns-bar'
  | 'backup-before-bar-start';

export interface ScannerSemanticViolation {
  code: ScannerSemanticViolationCode;
  detail: string;
  partIndex: number;
  measureIndex: number;
  measureNumber?: string;
}

export interface ScannerSemanticReport {
  valid: boolean;
  violations: ScannerSemanticViolation[];
}

const integerOr = (value: string, fallback: bigint): bigint =>
  /^-?\d+$/.test(value) ? BigInt(value) : fallback;

/** `C#4`, `rest` or `unpitched`; a tie is only valid between equal pitches. */
function pitchOf(noteChildren: OrderedEntry[]): string {
  const pitch = directEntries(noteChildren, 'pitch')[0];
  if (!pitch) return directEntries(noteChildren, 'rest').length > 0 ? 'rest' : 'unpitched';
  const inner = contents(pitch, 'pitch');
  return `${directText(inner, 'step')}${
    directText(inner, 'alter') ? `(${directText(inner, 'alter')})` : ''
  }${directText(inner, 'octave')}`;
}

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

/**
 * Check a document against the invariants a splice can break.
 *
 * Ties are matched per part, per voice and per pitch across the whole part —
 * a tie legitimately spans a bar line, so it can only be resolved by walking
 * the part rather than a measure at a time.
 */
export function validateScannerMusicXmlSemantics(musicXml: Buffer): ScannerSemanticReport {
  const { rootName } = parseValidMusicXml(musicXml);
  if (rootName !== 'score-partwise') {
    throw new Error('Scanner semantic validation requires score-partwise MusicXML');
  }
  const ordered = musicXmlParser({ preserveOrder: true }).parse(musicXml.toString('utf8'));
  const rootEntry = Array.isArray(ordered)
    ? ordered.find((entry) => Object.prototype.hasOwnProperty.call(entry, 'score-partwise'))
    : undefined;
  const root = rootEntry?.['score-partwise'];
  if (!Array.isArray(root)) throw new Error('Scanner semantic validation could not read MusicXML');

  const violations: ScannerSemanticViolation[] = [];

  directEntries(root, 'part').forEach((part, partIndex) => {
    let divisions = BigInt(1);
    let beats = BigInt(0);
    let beatType = BigInt(0);
    /** Ties waiting for a stop, keyed `voice|pitch`, with where they began. */
    const openTies = new Map<string, { measureIndex: number; measureNumber?: string }>();

    directEntries(contents(part, 'part'), 'measure').forEach((measure, measureIndex) => {
      const children = contents(measure, 'measure');
      const measureNumber = String(attrs(measure)['@_number'] || '') || undefined;
      const at = { partIndex, measureIndex, measureNumber };
      // A pickup or a mid-page split bar declares itself; it is not expected to
      // fill the time signature and flagging it would be noise.
      const implicit = String(attrs(measure)['@_implicit'] || '') === 'yes';

      for (const attributes of directEntries(children, 'attributes')) {
        const inner = contents(attributes, 'attributes');
        const declared = directText(inner, 'divisions');
        if (declared) divisions = integerOr(declared, divisions);
        for (const time of directEntries(inner, 'time')) {
          const timeInner = contents(time, 'time');
          beats = integerOr(directText(timeInner, 'beats'), beats);
          beatType = integerOr(directText(timeInner, 'beat-type'), beatType);
        }
      }

      const voiceEnds = new Map<string, bigint>();
      let cursor = BigInt(0);
      let sawBackupBeforeStart = false;

      for (const child of children) {
        const [tag] = Object.keys(child).filter((key) => key !== ':@');
        const inner = contents(child, tag);
        if (tag === 'backup' || tag === 'forward') {
          const amount = integerOr(directText(inner, 'duration'), BigInt(0));
          cursor = tag === 'backup' ? cursor - amount : cursor + amount;
          if (cursor < BigInt(0)) {
            sawBackupBeforeStart = true;
            cursor = BigInt(0);
          }
          continue;
        }
        if (tag !== 'note') continue;

        const voice = directText(inner, 'voice') || '1';
        const pitch = pitchOf(inner);
        const isChord = directEntries(inner, 'chord').length > 0;
        if (!isChord) {
          cursor += integerOr(directText(inner, 'duration'), BigInt(0));
          voiceEnds.set(voice, cursor);
        }

        const key = `${voice}|${pitch}`;
        for (const type of tieTypesOf(inner)) {
          if (type === 'start') openTies.set(key, { measureIndex, measureNumber });
          else if (type === 'stop') {
            if (openTies.has(key)) openTies.delete(key);
            else {
              violations.push({
                ...at,
                code: 'tie-unstarted',
                detail: `A tie ends on ${pitch} in voice ${voice} without having begun anywhere before it.`
              });
            }
          }
        }
      }

      if (sawBackupBeforeStart) {
        violations.push({
          ...at,
          code: 'backup-before-bar-start',
          detail: 'A <backup> moves before the start of the bar, so the voices do not line up.'
        });
      }

      // A bar's expected length is `beats * divisions * 4 / beat-type`; the
      // multiplication happens before the division so a 6/8 bar in divisions
      // that do not divide by 8 is still exact.
      if (!implicit && beats > BigInt(0) && beatType > BigInt(0)) {
        const expectedNumerator = beats * divisions * BigInt(4);
        if (expectedNumerator % beatType === BigInt(0)) {
          const expected = expectedNumerator / beatType;
          for (const [voice, end] of voiceEnds) {
            if (end === expected) continue;
            violations.push({
              ...at,
              code: end < expected ? 'voice-underruns-bar' : 'voice-overruns-bar',
              detail:
                `Voice ${voice} ${end < expected ? 'falls short of' : 'runs past'} the bar: ` +
                `${end} against the ${expected} the time signature calls for.`
            });
          }
        }
      }
    });

    for (const [key, origin] of openTies) {
      const [voice, pitch] = key.split('|');
      violations.push({
        partIndex,
        measureIndex: origin.measureIndex,
        measureNumber: origin.measureNumber,
        code: 'tie-unresolved',
        detail: `A tie begins on ${pitch} in voice ${voice} and never ends.`
      });
    }
  });

  return { valid: violations.length === 0, violations };
}
