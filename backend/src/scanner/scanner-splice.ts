import { XMLBuilder } from 'fast-xml-parser';
import { musicXmlParser, parseValidMusicXml } from './scanner-musicxml';
import { attrs, contents, directEntries, type OrderedEntry } from './scanner-musicxml-tree';
import {
  assessScannerSplice,
  readScannerSpliceFacts,
  type ScannerSpliceRefusal,
  type ScannerSpliceRepair
} from './scanner-splice-safety';
import {
  validateScannerMusicXmlSemantics,
  type ScannerSemanticViolation
} from './scanner-musicxml-semantics';

export const SCANNER_SPLICE_VERSION = 'scanner-splice-v1';

export interface ScannerSpliceOutcome {
  /** The spliced document, or null when nothing was produced. */
  musicXml: Buffer | null;
  /** Why it was not produced; empty on success. */
  refusals: ScannerSpliceRefusal[];
  /** What the splice changed beyond copying measures. Reported, never silent. */
  repairs: ScannerSpliceRepair[];
  /** Invariants the result broke. Non-empty means `musicXml` is null. */
  violations: ScannerSemanticViolation[];
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

/**
 * Rewrite every duration in a subtree by `× numerator ÷ denominator`.
 *
 * Exactness is the caller's guarantee: `assessScannerSplice` has already
 * established that every duration here converts to a whole number, so this
 * never rounds. `<time-modification>` is deliberately untouched — it is a ratio
 * of note values, and divisions do not enter into it.
 */
function rescaleDurations(entries: OrderedEntry[], numerator: bigint, denominator: bigint): void {
  if (numerator === denominator) return;
  for (const entry of entries) {
    const tag = tagOf(entry);
    if (!tag) continue;
    const children: OrderedEntry[] = entry[tag];
    if (!Array.isArray(children)) continue;
    if (tag === 'duration') {
      const text = children.find((child) => Object.prototype.hasOwnProperty.call(child, '#text'));
      if (text && /^\d+$/.test(String(text['#text']))) {
        text['#text'] = ((BigInt(String(text['#text'])) * numerator) / denominator).toString();
      }
      continue;
    }
    rescaleDurations(children, numerator, denominator);
  }
}

/** MusicXML's order for `<attributes>` children; the schema is a sequence. */
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

const attributeChildren = (measureChildren: OrderedEntry[]): OrderedEntry[] =>
  directEntries(measureChildren, 'attributes').flatMap((entry) =>
    Array.isArray(entry.attributes) ? (entry.attributes as OrderedEntry[]) : []
  );

/**
 * Reconcile the attributes of the bar being replaced with the one replacing it.
 *
 * This is design §5.2's hazard in its most literal form, and a fixture would
 * never have found it: attributes live *inside* measures, so HOMR declaring
 * `divisions` once in bar 1 means replacing bar 1 deletes that declaration for
 * the whole part. Every following bar then measures against MusicXML's default
 * of 1, and the document silently becomes nonsense. Found by splicing the real
 * pair rather than a made-up one.
 *
 * So: a splice must never remove context the rest of the document depends on.
 * `divisions` always comes from the base — the measures have just been rewritten
 * into its time units, so any other value is a lie. Everything else prefers the
 * candidate, because a key or clef change *is* the candidate's reading of the
 * page and taking the bar means taking it, but falls back to the base's rather
 * than vanishing.
 */
function reconcileAttributes(
  baseMeasureChildren: OrderedEntry[],
  candidateMeasureChildren: OrderedEntry[]
): void {
  const fromBase = attributeChildren(baseMeasureChildren);
  const fromCandidate = attributeChildren(candidateMeasureChildren).filter(
    (entry) => tagOf(entry) !== 'divisions'
  );
  const pick = (tag: string): OrderedEntry[] => {
    if (tag === 'divisions') return fromBase.filter((entry) => tagOf(entry) === tag);
    const candidate = fromCandidate.filter((entry) => tagOf(entry) === tag);
    return candidate.length > 0 ? candidate : fromBase.filter((entry) => tagOf(entry) === tag);
  };
  const merged = ATTRIBUTE_ORDER.flatMap(pick);
  // Anything this list does not name is carried through from the candidate
  // rather than dropped; the schema's order only constrains what it names.
  const named = new Set(ATTRIBUTE_ORDER);
  merged.push(...fromCandidate.filter((entry) => !named.has(tagOf(entry))));

  for (let index = candidateMeasureChildren.length - 1; index >= 0; index -= 1) {
    if (tagOf(candidateMeasureChildren[index]) === 'attributes') {
      candidateMeasureChildren.splice(index, 1);
    }
  }
  if (merged.length > 0) {
    candidateMeasureChildren.unshift({ attributes: merged });
  }
}

/**
 * Renumber a part's measures after its length changed.
 *
 * An insertion or a deletion leaves the labels wrong — bars 1..19 then 21 — and
 * measure numbers are what a reader and every later reference count by. The
 * numbering restarts from whatever the first bar already claimed, so a part
 * beginning at 5 keeps doing so, and a pickup marked `implicit` is skipped
 * because it is conventionally unnumbered.
 */
function renumberMeasures(partChildren: OrderedEntry[]): void {
  const measures = directEntries(partChildren, 'measure');
  const first = Number(attrs(measures[0] || {})['@_number']);
  let next = Number.isFinite(first) && first > 0 ? first : 1;
  for (const measure of measures) {
    const isImplicit = String(attrs(measure)['@_implicit'] || '') === 'yes';
    measure[':@'] = { ...(measure[':@'] || {}), '@_number': String(next) };
    if (!isImplicit) next += 1;
  }
}

/** Every `<slur>` in a part, in document order, with the note that carries it. */
function slurElements(partChildren: OrderedEntry[]): OrderedEntry[] {
  const found: OrderedEntry[] = [];
  for (const measure of directEntries(partChildren, 'measure')) {
    for (const child of contents(measure, 'measure')) {
      if (tagOf(child) !== 'note') continue;
      for (const notations of directEntries(contents(child, 'note'), 'notations')) {
        for (const slur of directEntries(contents(notations, 'notations'), 'slur')) {
          found.push(slur);
        }
      }
    }
  }
  return found;
}

/**
 * Remove slur ends that no longer have a partner.
 *
 * A splice can orphan one in either direction, and the orphan is not always in
 * a bar that was replaced: taking a bar whose slur started there leaves the
 * *untouched* next bar holding a stop that goes nowhere. So this resolves over
 * the whole part rather than the spliced span, which handles both.
 *
 * A dangling slur is a lost phrase mark and no changed note, which is why this
 * is a repair rather than a refusal — but it is still reported.
 */
function dropDanglingSlurs(partChildren: OrderedEntry[]): number {
  const open = new Map<string, OrderedEntry[]>();
  const orphans: OrderedEntry[] = [];
  for (const slur of slurElements(partChildren)) {
    const number = String(attrs(slur)['@_number'] || '1');
    const type = String(attrs(slur)['@_type'] || '');
    const stack = open.get(number) || [];
    if (type === 'start') {
      stack.push(slur);
      open.set(number, stack);
    } else if (type === 'stop') {
      if (stack.length > 0) stack.pop();
      else orphans.push(slur);
    }
  }
  for (const stack of open.values()) orphans.push(...stack);
  if (orphans.length === 0) return 0;

  const doomed = new Set(orphans);
  for (const measure of directEntries(partChildren, 'measure')) {
    for (const child of contents(measure, 'measure')) {
      if (tagOf(child) !== 'note') continue;
      const noteChildren: OrderedEntry[] = child.note;
      for (const notations of directEntries(noteChildren, 'notations')) {
        const inner: OrderedEntry[] = notations.notations;
        notations.notations = inner.filter((entry) => !doomed.has(entry));
      }
      // A `<notations>` emptied by the removal has nothing left to say.
      child.note = noteChildren.filter(
        (entry) => tagOf(entry) !== 'notations' || (entry.notations as OrderedEntry[]).length > 0
      );
    }
  }
  return orphans.length;
}

/**
 * The violations this splice caused, as opposed to the ones it inherited.
 *
 * A recognition engine's reading is often already malformed somewhere — a
 * pickup bar it did not mark implicit, a bar it read a beat long — and the
 * merged score starts as a copy of one. Validating only the result therefore
 * blamed every splice for damage that was in the document before it ran, and
 * refused every take on such a page. Klengel is one: bars 1, 19 and 23 do not
 * match the time signature in *either* reading, and no decision about bar 5
 * could be made because of it.
 *
 * So the question is what changed. When the splice did not alter the bar count,
 * a violation is matched by its position and code; when it did, positions have
 * moved and the honest comparison is how many of each code there are — an
 * increase is this splice's doing, and no increase is not.
 */
function introducedViolations(
  before: readonly ScannerSemanticViolation[],
  after: readonly ScannerSemanticViolation[],
  positionsHeld: boolean
): ScannerSemanticViolation[] {
  if (positionsHeld) {
    const inherited = new Set(
      before.map(
        (violation) => `${violation.partIndex}:${violation.measureIndex}:${violation.code}`
      )
    );
    return after.filter(
      (violation) =>
        !inherited.has(`${violation.partIndex}:${violation.measureIndex}:${violation.code}`)
    );
  }
  const countBefore = new Map<string, number>();
  for (const violation of before) {
    const key = `${violation.partIndex}:${violation.code}`;
    countBefore.set(key, (countBefore.get(key) || 0) + 1);
  }
  const introduced: ScannerSemanticViolation[] = [];
  const seen = new Map<string, number>();
  for (const violation of after) {
    const key = `${violation.partIndex}:${violation.code}`;
    const index = (seen.get(key) || 0) + 1;
    seen.set(key, index);
    if (index > (countBefore.get(key) || 0)) introduced.push(violation);
  }
  return introduced;
}

/**
 * Replace one span of the base document with the corresponding span of the
 * candidate's, in the base's time units.
 *
 * §5.2 recommends rebuilding from the aligned measure sequence rather than
 * inventing a patch format, and this is the single-block form of that: the
 * alignment has already decided which measures correspond, so the splice only
 * has to carry them across without changing what they say.
 *
 * Refuses before it acts and validates after: `assessScannerSplice` decides
 * whether the passage *can* move, and `validateScannerMusicXmlSemantics` checks
 * that what came out is a document rather than something that merely parses.
 */
export function spliceScannerMeasures(input: {
  baseXml: Buffer;
  candidateXml: Buffer;
  basePartIndex: number;
  candidatePartIndex: number;
  baseMeasureIndexes: readonly number[];
  candidateMeasureIndexes: readonly number[];
  /** Where an insertion goes; see `ScannerComparisonBlock.baseAnchorIndex`. */
  baseAnchorIndex?: number;
}): ScannerSpliceOutcome {
  const base = readScannerSpliceFacts(input.baseXml);
  const candidate = readScannerSpliceFacts(input.candidateXml);
  const assessment = assessScannerSplice({
    base,
    candidate,
    basePartIndex: input.basePartIndex,
    candidatePartIndex: input.candidatePartIndex,
    baseMeasureIndexes: input.baseMeasureIndexes,
    candidateMeasureIndexes: input.candidateMeasureIndexes,
    baseAnchorIndex: input.baseAnchorIndex
  });
  /*
   * A length difference is a bar to correct, not a reason to refuse.
   *
   * This used to refuse because the alternative was worse: the passage would
   * land holding more than its time signature allows and nothing could be done
   * about it afterwards. There is now a control for exactly that — the merged
   * pane marks every bar whose contents do not match its time signature and
   * offers to set it back — so the honest behaviour is to take the notes the
   * reviewer asked for and leave the bar marked.
   *
   * The alternative, shifting everything after it in the part, is worse than an
   * over-full bar: it moves music the reviewer did not ask to move, and the
   * only sign is that the rest of the page is subtly wrong.
   */
  const overruled = assessment.refusals.filter((refusal) => refusal.code === 'duration-differs');
  const blocking = assessment.refusals.filter((refusal) => !overruled.includes(refusal));
  if (blocking.length > 0) {
    return {
      musicXml: null,
      refusals: blocking,
      repairs: assessment.repairs,
      violations: []
    };
  }

  parseValidMusicXml(input.baseXml);
  parseValidMusicXml(input.candidateXml);
  const parse = (xml: Buffer) =>
    musicXmlParser({ preserveOrder: true }).parse(xml.toString('utf8'));
  const baseTree = parse(input.baseXml);
  const candidateTree = parse(input.candidateXml);
  const rootOf = (tree: any) =>
    (Array.isArray(tree)
      ? tree.find((entry: OrderedEntry) =>
          Object.prototype.hasOwnProperty.call(entry, 'score-partwise')
        )
      : undefined)?.['score-partwise'];
  const baseRoot = rootOf(baseTree);
  const candidateRoot = rootOf(candidateTree);
  if (!Array.isArray(baseRoot) || !Array.isArray(candidateRoot)) {
    throw new Error('Scanner splice could not read one of the documents');
  }

  const basePartEntry = directEntries(baseRoot, 'part')[input.basePartIndex];
  const candidatePartEntry = directEntries(candidateRoot, 'part')[input.candidatePartIndex];
  const basePartChildren: OrderedEntry[] = basePartEntry.part;
  const baseMeasures = directEntries(basePartChildren, 'measure');
  const candidateMeasures = directEntries(candidatePartEntry.part, 'measure');

  const deleting = input.candidateMeasureIndexes.length === 0;
  const inserting = input.baseMeasureIndexes.length === 0;
  // Divisions in force at the join, which is what an inserted bar has to be
  // written in. For a replacement that is the bar being replaced; for an
  // insertion it is whatever the bar before it established, or the first bar's
  // if it is going at the very start.
  const anchorIndex = inserting ? (input.baseAnchorIndex ?? -1) : input.baseMeasureIndexes[0];
  const baseMeasureFacts = base[input.basePartIndex].measures;
  const baseUnit = BigInt(
    (baseMeasureFacts[anchorIndex] || baseMeasureFacts[0] || { divisions: '1' }).divisions
  );
  const candidateUnit = deleting
    ? baseUnit
    : BigInt(
        candidate[input.candidatePartIndex].measures[input.candidateMeasureIndexes[0]].divisions
      );

  const replacements = input.candidateMeasureIndexes.map((candidateIndex, position) => {
    const candidateMeasure = candidateMeasures[candidateIndex];
    if (!candidateMeasure) {
      throw new Error(
        'Scanner splice could not locate every candidate measure it was asked to take'
      );
    }
    const copy: OrderedEntry = clone(candidateMeasure);
    const children: OrderedEntry[] = copy.measure;
    rescaleDurations(children, baseUnit, candidateUnit);
    const original = baseMeasures[input.baseMeasureIndexes[position]];
    if (original) {
      // Keep the base's numbering: the reviewer is replacing what a bar *says*,
      // not where it sits, and every reference counts from the base.
      reconcileAttributes(contents(original, 'measure'), children);
      copy[':@'] = { ...(copy[':@'] || {}), ...(original[':@'] || {}) };
    } else {
      // An inserted bar has no counterpart to inherit numbering from — the
      // whole part is renumbered afterwards — but it must not carry the
      // candidate's `divisions`, having just been written in the base's.
      reconcileAttributes(
        contents(baseMeasures[Math.max(anchorIndex, 0)] || {}, 'measure'),
        children
      );
    }
    return copy;
  });

  const baseIndexes = [...input.baseMeasureIndexes].sort((left, right) => left - right);
  if (
    baseIndexes.some((index, position) => position > 0 && index !== baseIndexes[position - 1] + 1)
  ) {
    throw new Error('Scanner splice requires one contiguous base passage');
  }
  if (baseIndexes.some((index) => !baseMeasures[index])) {
    throw new Error('Scanner splice could not locate every base measure it was asked to change');
  }

  let insertedReplacement = false;
  const spliced: OrderedEntry[] = [];
  for (const entry of basePartChildren) {
    if (tagOf(entry) !== 'measure') {
      spliced.push(entry);
      continue;
    }
    const index = baseMeasures.indexOf(entry);
    if (input.baseMeasureIndexes.includes(index)) {
      // A block may contain N bars on one side and M on the other. Insert the
      // complete candidate span once, where the base span began, then remove
      // every base bar in that span. Emitting one replacement per base bar
      // silently dropped the tail of a 1->2 take and produced `undefined` for
      // the tail of a 2->1 take.
      if (!insertedReplacement && !deleting) {
        spliced.push(...replacements);
        insertedReplacement = true;
      }
      continue;
    }
    spliced.push(entry);
    if (inserting && index === anchorIndex) {
      spliced.push(...replacements);
      insertedReplacement = true;
    }
  }
  if (inserting && anchorIndex < 0) {
    // Before the first bar; nothing preceded it to insert after.
    const first = spliced.findIndex((entry) => tagOf(entry) === 'measure');
    spliced.splice(first < 0 ? spliced.length : first, 0, ...replacements);
    insertedReplacement = true;
  }
  if (replacements.length > 0 && !insertedReplacement) {
    throw new Error('Scanner splice could not place every candidate measure it was asked to take');
  }
  basePartEntry.part = spliced;
  if (
    inserting ||
    deleting ||
    input.baseMeasureIndexes.length !== input.candidateMeasureIndexes.length
  ) {
    renumberMeasures(basePartEntry.part);
  }

  const dangling = dropDanglingSlurs(basePartEntry.part);
  const repairs: ScannerSpliceRepair[] = [
    ...assessment.repairs,
    ...overruled.map((refusal) => ({
      code: 'taken-anyway' as const,
      detail: `${refusal.detail} The bar is marked; correct it from the merged pane.`,
      measureIndex: input.baseMeasureIndexes[0]
    }))
  ];
  if (dangling > 0 && repairs.length === 0) {
    // The assessment looks at the span's edges; this catches a slur orphaned
    // wholly inside the replaced content, which no edge check would see.
    repairs.push({
      code: 'drop-dangling-slur',
      detail: `${dangling} slur end${dangling === 1 ? '' : 's'} lost ${
        dangling === 1 ? 'its' : 'their'
      } partner in this replacement and ${
        dangling === 1 ? 'was' : 'were'
      } dropped. No note changes.`,
      measureIndex: input.baseMeasureIndexes[0]
    });
  }

  const musicXml = Buffer.from(orderedBuilder().build(baseTree));
  // What this splice broke, not what it found broken. See `introducedViolations`.
  const before = validateScannerMusicXmlSemantics(input.baseXml).violations;
  const report = {
    violations: introducedViolations(
      before,
      validateScannerMusicXmlSemantics(musicXml).violations,
      input.baseMeasureIndexes.length === input.candidateMeasureIndexes.length
    )
  };
  /*
   * A bar that no longer matches its time signature is the *result* of a length
   * change, so it cannot also be what blocks it — but only in the bars that
   * were replaced. A violation anywhere else means the splice broke something
   * it was not asked to touch, and that still refuses.
   */
  // The bars the replacement landed on. For a straight replacement that is
  // where they already were.
  const replacementStart = inserting
    ? (input.baseAnchorIndex ?? -1) + 1
    : Math.min(...input.baseMeasureIndexes);
  const replaced = new Set(
    Array.from(
      { length: input.candidateMeasureIndexes.length },
      (_value, index) => replacementStart + index
    )
  );
  const asked = report.violations.filter(
    (violation) =>
      replaced.has(violation.measureIndex) &&
      (violation.code === 'voice-overruns-bar' || violation.code === 'voice-underruns-bar')
  );
  const violations = report.violations.filter((violation) => !asked.includes(violation));
  if (violations.length > 0) {
    return { musicXml: null, refusals: [], repairs, violations };
  }
  return {
    musicXml,
    refusals: [],
    repairs: [
      ...repairs,
      ...asked.map((violation) => ({
        code: 'taken-anyway' as const,
        detail: `${violation.detail} The bar is marked; correct it from the merged pane.`,
        measureIndex: violation.measureIndex
      }))
    ],
    violations: []
  };
}
