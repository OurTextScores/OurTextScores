import { createHash } from 'node:crypto';
import { XMLBuilder } from 'fast-xml-parser';
import { musicXmlParser, parseValidMusicXml } from './scanner-musicxml';
import {
  attrs,
  contents,
  directEntries,
  directText,
  type OrderedEntry
} from './scanner-musicxml-tree';

export const SCANNER_PART_LAYOUT_VERSION = 'scanner-part-layout-v1';

/**
 * The most staves this will fold into one part.
 *
 * A grand staff is two and an organ part is three; beyond that the reading is
 * far more likely to be a genuine ensemble that one engine ran together than a
 * keyboard written two ways, and guessing wrong merges unrelated instruments.
 */
export const SCANNER_MAX_RECONCILED_STAVES = 4;

export interface ScannerPartLayoutRefusal {
  code: string;
  detail: string;
}

export interface ScannerPartLayoutResult {
  /** True when `musicXml` differs from the candidate that was passed in. */
  applied: boolean;
  /** The candidate rewritten to the base's part layout, or the original. */
  musicXml: Buffer;
  /** Checksum of `musicXml`; equal to the artifact's when nothing was applied. */
  contentChecksumSha256: string;
  /** What was folded together, for the reviewer. Absent when nothing was. */
  note?: string;
  /**
   * Why a layout difference that looked reconcilable was left alone.
   *
   * Empty both when the layouts already agreed and when they are not the same
   * music at all — this says "we tried and stopped", not "we saw nothing".
   */
  refusals: ScannerPartLayoutRefusal[];
}

const orderedBuilder = () =>
  new XMLBuilder({
    ignoreAttributes: false,
    processEntities: false,
    format: true,
    suppressEmptyNode: true,
    preserveOrder: true
  });

const tagOf = (entry: OrderedEntry): string => Object.keys(entry).filter((key) => key !== ':@')[0];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

function rootOf(tree: any): OrderedEntry[] | undefined {
  const entry = Array.isArray(tree)
    ? tree.find((item: OrderedEntry) =>
        Object.prototype.hasOwnProperty.call(item, 'score-partwise')
      )
    : undefined;
  const root = entry?.['score-partwise'];
  return Array.isArray(root) ? root : undefined;
}

/** Staves a part occupies: what it declares, or the highest staff its notes name. */
function partStaffCount(partChildren: OrderedEntry[]): number {
  let highest = 1;
  for (const measure of directEntries(partChildren, 'measure')) {
    for (const child of contents(measure, 'measure')) {
      const tag = tagOf(child);
      if (tag === 'attributes') {
        const declared = Number(directText(contents(child, 'attributes'), 'staves'));
        if (Number.isInteger(declared) && declared > highest) highest = declared;
      } else if (tag === 'note' || tag === 'forward') {
        const staff = Number(directText(contents(child, tag), 'staff'));
        if (Number.isInteger(staff) && staff > highest) highest = staff;
      }
    }
  }
  return highest;
}

/** Divisions in force at each measure, carried forward as MusicXML defines them. */
function divisionsByMeasure(partChildren: OrderedEntry[]): string[] {
  let current = '1';
  return directEntries(partChildren, 'measure').map((measure) => {
    for (const child of contents(measure, 'measure')) {
      if (tagOf(child) !== 'attributes') continue;
      const declared = directText(contents(child, 'attributes'), 'divisions');
      if (declared) current = declared;
    }
    return current;
  });
}

/**
 * Where a measure's content leaves the clock, in that measure's divisions.
 *
 * This is what the `<backup>` before the next staff has to undo. The final
 * position rather than the furthest point reached, because a part that already
 * backs up inside the bar for a second voice ends where it ends, and backing
 * up by the bar's full length from there would start the next staff early.
 */
function measureEndPosition(measureChildren: OrderedEntry[]): bigint {
  let position = BigInt(0);
  for (const child of measureChildren) {
    const tag = tagOf(child);
    if (tag === 'note') {
      const noteChildren = contents(child, 'note');
      // A chord note sounds with the one before it, and a grace note takes no
      // time at all; neither moves the clock.
      if (directEntries(noteChildren, 'chord').length > 0) continue;
      if (directEntries(noteChildren, 'grace').length > 0) continue;
      position += BigInt(directText(noteChildren, 'duration') || '0');
    } else if (tag === 'forward' || tag === 'backup') {
      const moved = BigInt(directText(contents(child, tag), 'duration') || '0');
      position += tag === 'forward' ? moved : -moved;
    }
  }
  return position;
}

/** Insert `child` before the first of `before`, or append it. */
function insertBefore(children: OrderedEntry[], child: OrderedEntry, before: string[]): void {
  const index = children.findIndex((entry) => before.includes(tagOf(entry)));
  if (index < 0) children.push(child);
  else children.splice(index, 0, child);
}

/**
 * Put a note on a staff and in a voice of its own.
 *
 * Voices are offset a block of four per staff — the convention MuseScore and
 * HOMR both use — because the parts being folded together each numbered their
 * voices from 1, and leaving that alone would put the right hand and the left
 * hand in the same voice.
 */
function assignNoteToStaff(noteChildren: OrderedEntry[], staff: number): void {
  const existing = Number(directText(noteChildren, 'voice') || '1');
  const voice = String(
    (staff - 1) * 4 + (Number.isInteger(existing) && existing >= 1 && existing <= 4 ? existing : 1)
  );
  for (let index = noteChildren.length - 1; index >= 0; index -= 1) {
    const tag = tagOf(noteChildren[index]);
    if (tag === 'voice' || tag === 'staff') noteChildren.splice(index, 1);
  }
  insertBefore(noteChildren, { voice: [{ '#text': voice }] }, [
    'type',
    'dot',
    'accidental',
    'time-modification',
    'stem',
    'notehead',
    'staff',
    'beam',
    'notations',
    'lyric',
    'play'
  ]);
  insertBefore(noteChildren, { staff: [{ '#text': String(staff) }] }, [
    'beam',
    'notations',
    'lyric',
    'play'
  ]);
}

/** Number a clef, staff-details or transpose so it names the staff it belongs to. */
function numberStaffScoped(entries: OrderedEntry[], staff: number): OrderedEntry[] {
  return entries.map((entry) => ({
    ...entry,
    ':@': { ...(entry[':@'] || {}), '@_number': String(staff) }
  }));
}

const ATTRIBUTE_ORDER = [
  'divisions',
  'key',
  'time',
  'staves',
  'part-symbol',
  'instruments',
  'clef',
  'staff-details',
  'transpose',
  'directive',
  'measure-style'
];

/**
 * One `<attributes>` describing every staff, built from each part's own.
 *
 * Divisions, key and time come from the first part because they are properties
 * of the bar rather than of a staff — and the caller has already established
 * that the parts agree about divisions. Clefs are the opposite: each staff has
 * its own, and folding them together without numbering them would leave every
 * staff reading in treble.
 */
function mergedAttributes(perPart: OrderedEntry[][], staves: number): OrderedEntry | undefined {
  const first = perPart[0] || [];
  if (perPart.every((entries) => entries.length === 0)) return undefined;
  const merged: OrderedEntry[] = [];
  const take = (source: OrderedEntry[], tag: string) =>
    source.filter((entry) => tagOf(entry) === tag);

  merged.push(...take(first, 'divisions'));
  merged.push(...take(first, 'key'));
  merged.push(...take(first, 'time'));
  merged.push({ staves: [{ '#text': String(staves) }] });
  merged.push({ 'part-symbol': [{ '#text': 'brace' }] });
  perPart.forEach((entries, index) => {
    merged.push(...numberStaffScoped(take(entries, 'clef'), index + 1));
  });
  perPart.forEach((entries, index) => {
    merged.push(...numberStaffScoped(take(entries, 'staff-details'), index + 1));
  });
  perPart.forEach((entries, index) => {
    merged.push(...numberStaffScoped(take(entries, 'transpose'), index + 1));
  });
  const named = new Set(ATTRIBUTE_ORDER);
  merged.push(...first.filter((entry) => !named.has(tagOf(entry))));
  return { attributes: merged };
}

/** Content that belongs to the bar rather than to a staff, taken once. */
const BAR_SCOPED = new Set(['print', 'barline', 'sound']);

function foldMeasure(
  perPartMeasures: OrderedEntry[],
  staves: number
): OrderedEntry {
  const leadingAttributes: OrderedEntry[][] = [];
  const bodies: OrderedEntry[][] = [];
  for (const measure of perPartMeasures) {
    const children = clone(contents(measure, 'measure')) as OrderedEntry[];
    let split = 0;
    while (split < children.length && tagOf(children[split]) === 'attributes') split += 1;
    leadingAttributes.push(
      children.slice(0, split).flatMap((entry) => contents(entry, 'attributes'))
    );
    bodies.push(children.slice(split));
  }

  const folded: OrderedEntry[] = [];
  const header = mergedAttributes(leadingAttributes, staves);
  if (header) folded.push(header);

  bodies.forEach((body, index) => {
    const staff = index + 1;
    if (index > 0) {
      const back = measureEndPosition(folded);
      if (back > BigInt(0)) {
        folded.push({ backup: [{ duration: [{ '#text': back.toString() }] }] });
      }
    }
    for (const child of body) {
      const tag = tagOf(child);
      // A barline or a page break describes the bar, not one hand of it, so it
      // is carried once instead of once per staff.
      if (BAR_SCOPED.has(tag)) {
        if (index === 0) folded.push(child);
        continue;
      }
      if (tag === 'note') {
        assignNoteToStaff(child.note as OrderedEntry[], staff);
        folded.push(child);
        continue;
      }
      if (tag === 'attributes') {
        // A mid-bar change stays where it stood, scoped to the staff it changes.
        const inner = contents(child, 'attributes');
        const scoped = inner.flatMap((entry) =>
          ['clef', 'staff-details', 'transpose'].includes(tagOf(entry))
            ? numberStaffScoped([entry], staff)
            : [entry]
        );
        folded.push({ attributes: scoped });
        continue;
      }
      if (tag === 'direction' || tag === 'forward' || tag === 'harmony') {
        const inner = child[tag] as OrderedEntry[];
        const withoutStaff = inner.filter((entry) => tagOf(entry) !== 'staff');
        insertBefore(withoutStaff, { staff: [{ '#text': String(staff) }] }, ['sound']);
        folded.push({ ...child, [tag]: withoutStaff });
        continue;
      }
      folded.push(child);
    }
  });

  return { measure: folded, ':@': { ...(perPartMeasures[0][':@'] || {}) } };
}

/**
 * Rewrite the candidate so its parts are laid out the way the base's are.
 *
 * Two engines reading the same piano page can both be right and still not be
 * comparable: HOMR writes one part on a braced pair of staves, Transcoda writes
 * two parts of one staff each. Nothing downstream can align them — part
 * matching pairs a part with a part, and a two-staff part has never had the
 * same content as a one-staff part — so the comparison refused a page a reader
 * could see was the same music.
 *
 * This is the narrow fix: fold consecutive single-staff candidate parts into
 * one multi-staff part when their staff counts add up to a base part's, and
 * only when they agree bar for bar about divisions. Nothing about the base is
 * touched, because the base is what a merged score is built on.
 *
 * It deliberately does not split: turning one part into several would have to
 * decide which staff every note belongs to, and a cross-staff beam has no
 * answer to that. So the reverse arrangement is reported rather than repaired.
 */
export function reconcileScannerPartLayout(input: {
  baseXml: Buffer;
  candidateXml: Buffer;
}): ScannerPartLayoutResult {
  const unchanged = (refusals: ScannerPartLayoutRefusal[] = []): ScannerPartLayoutResult => ({
    applied: false,
    musicXml: input.candidateXml,
    contentChecksumSha256: sha256(input.candidateXml),
    refusals
  });

  parseValidMusicXml(input.baseXml);
  parseValidMusicXml(input.candidateXml);
  const parse = (xml: Buffer) => musicXmlParser({ preserveOrder: true }).parse(xml.toString('utf8'));
  const candidateTree = parse(input.candidateXml);
  const baseRoot = rootOf(parse(input.baseXml));
  const candidateRoot = rootOf(candidateTree);
  if (!baseRoot || !candidateRoot) return unchanged();

  const baseParts = directEntries(baseRoot, 'part');
  const candidateParts = directEntries(candidateRoot, 'part');
  const baseStaves = baseParts.map((part) => partStaffCount(part.part));
  const candidateStaves = candidateParts.map((part) => partStaffCount(part.part));
  if (
    baseStaves.length === candidateStaves.length &&
    baseStaves.every((count, index) => count === candidateStaves[index])
  ) {
    return unchanged();
  }

  // Consecutive candidate parts whose staves add up to each base part's, in
  // order. Anything left over means the readings differ about the music, not
  // about how to write it down.
  const groups: number[][] = [];
  let cursor = 0;
  for (const wanted of baseStaves) {
    const group: number[] = [];
    let total = 0;
    while (cursor < candidateParts.length && total < wanted) {
      total += candidateStaves[cursor];
      group.push(cursor);
      cursor += 1;
    }
    if (total !== wanted) return unchanged();
    groups.push(group);
  }
  if (cursor !== candidateParts.length) return unchanged();
  if (groups.every((group) => group.length === 1)) return unchanged();

  const refusals: ScannerPartLayoutRefusal[] = [];
  for (const group of groups) {
    if (group.length === 1) continue;
    const wanted = group.reduce((sum, index) => sum + candidateStaves[index], 0);
    if (wanted > SCANNER_MAX_RECONCILED_STAVES) {
      refusals.push({
        code: 'too-many-staves',
        detail: `Folding ${wanted} parts into one is more likely to be an ensemble than a keyboard part written two ways`
      });
      continue;
    }
    if (group.some((index) => candidateStaves[index] !== 1)) {
      refusals.push({
        code: 'multi-staff-member',
        detail: 'Only single-staff parts are folded together, so nothing is guessed about which staff a note was on'
      });
      continue;
    }
    const measureCounts = group.map(
      (index) => directEntries(candidateParts[index].part, 'measure').length
    );
    if (measureCounts.some((count) => count !== measureCounts[0])) {
      refusals.push({
        code: 'measure-count-differs',
        detail: `These parts have ${measureCounts.join(' and ')} measures, so they are not two staves of the same music`
      });
      continue;
    }
    const perPartDivisions = group.map((index) => divisionsByMeasure(candidateParts[index].part));
    const divisionsAgree = perPartDivisions[0].every((value, measure) =>
      perPartDivisions.every((series) => series[measure] === value)
    );
    if (!divisionsAgree) {
      refusals.push({
        code: 'divisions-differ',
        detail: 'These parts count time differently bar for bar, and rewriting one into the other’s units is a change to what it says'
      });
    }
  }
  if (refusals.length > 0) return unchanged(refusals);

  const foldedParts = groups.map((group) => {
    const first = candidateParts[group[0]];
    if (group.length === 1) return first;
    const staves = group.length;
    const measureLists = group.map((index) => directEntries(candidateParts[index].part, 'measure'));
    const nonMeasures = contents(first, 'part').filter((entry) => tagOf(entry) !== 'measure');
    const folded = measureLists[0].map((_, measure) =>
      foldMeasure(
        measureLists.map((list) => list[measure]),
        staves
      )
    );
    return { ...first, part: [...nonMeasures, ...folded] };
  });

  // The part list has to lose the same entries the parts did, and each folded
  // part keeps the id of its first member so it still names a part of the
  // document the engine actually produced.
  const keptIds = new Set(groups.map((group) => String(attrs(candidateParts[group[0]])['@_id'])));
  for (const entry of candidateRoot) {
    if (tagOf(entry) !== 'part-list') continue;
    entry['part-list'] = (entry['part-list'] as OrderedEntry[]).filter(
      (item) =>
        tagOf(item) !== 'score-part' || keptIds.has(String(attrs(item)['@_id']))
    );
  }
  let ordinal = 0;
  const rebuilt: OrderedEntry[] = [];
  for (const entry of candidateRoot) {
    if (tagOf(entry) !== 'part') {
      rebuilt.push(entry);
      continue;
    }
    const position = ordinal;
    ordinal += 1;
    const groupIndex = groups.findIndex((group) => group[0] === position);
    // Only the first member of a group survives, carrying the others' staves.
    if (groupIndex >= 0) rebuilt.push(foldedParts[groupIndex]);
  }
  candidateRoot.length = 0;
  candidateRoot.push(...rebuilt);

  const musicXml = Buffer.from(orderedBuilder().build(candidateTree));
  const foldedCount = groups.filter((group) => group.length > 1).length;
  return {
    applied: true,
    musicXml,
    contentChecksumSha256: sha256(musicXml),
    note: `${candidateParts.length} single-staff parts were read as ${foldedParts.length} part${
      foldedParts.length === 1 ? '' : 's'
    } on ${groups.map((group) => group.length).join(' and ')} staves, to match the other reading’s layout. ${
      foldedCount === 1 ? 'This is' : 'These are'
    } the same notes on the same staves, regrouped.`,
    refusals: []
  };
}
