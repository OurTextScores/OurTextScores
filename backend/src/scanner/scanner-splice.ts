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

const tagOf = (entry: OrderedEntry): string =>
  Object.keys(entry).filter((key) => key !== ':@')[0];

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
      const text = children.find((child) =>
        Object.prototype.hasOwnProperty.call(child, '#text')
      );
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
        (entry) =>
          tagOf(entry) !== 'notations' || (entry.notations as OrderedEntry[]).length > 0
      );
    }
  }
  return orphans.length;
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
}): ScannerSpliceOutcome {
  const base = readScannerSpliceFacts(input.baseXml);
  const candidate = readScannerSpliceFacts(input.candidateXml);
  const assessment = assessScannerSplice({
    base,
    candidate,
    basePartIndex: input.basePartIndex,
    candidatePartIndex: input.candidatePartIndex,
    baseMeasureIndexes: input.baseMeasureIndexes,
    candidateMeasureIndexes: input.candidateMeasureIndexes
  });
  if (!assessment.safe) {
    return {
      musicXml: null,
      refusals: assessment.refusals,
      repairs: assessment.repairs,
      violations: []
    };
  }

  parseValidMusicXml(input.baseXml);
  parseValidMusicXml(input.candidateXml);
  const parse = (xml: Buffer) => musicXmlParser({ preserveOrder: true }).parse(xml.toString('utf8'));
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

  const baseUnit = BigInt(base[input.basePartIndex].measures[input.baseMeasureIndexes[0]].divisions);
  const candidateUnit = BigInt(
    candidate[input.candidatePartIndex].measures[input.candidateMeasureIndexes[0]].divisions
  );

  const replacements = input.candidateMeasureIndexes.map((candidateIndex, position) => {
    const copy: OrderedEntry = clone(candidateMeasures[candidateIndex]);
    const children: OrderedEntry[] = copy.measure;
    rescaleDurations(children, baseUnit, candidateUnit);
    // Keep the base's numbering: the reviewer is replacing what a bar *says*,
    // not where it sits, and every reference to this page counts from the base.
    const baseIndex = input.baseMeasureIndexes[position];
    const original = baseMeasures[baseIndex];
    reconcileAttributes(contents(original, 'measure'), children);
    copy[':@'] = { ...(copy[':@'] || {}), ...(original[':@'] || {}) };
    return copy;
  });

  let replaced = 0;
  const spliced = basePartChildren.map((entry) => {
    if (tagOf(entry) !== 'measure') return entry;
    const index = baseMeasures.indexOf(entry);
    const position = input.baseMeasureIndexes.indexOf(index);
    if (position < 0) return entry;
    replaced += 1;
    return replacements[position];
  });
  if (replaced !== input.baseMeasureIndexes.length) {
    throw new Error('Scanner splice could not locate every measure it was asked to replace');
  }
  basePartEntry.part = spliced;

  const dangling = dropDanglingSlurs(basePartEntry.part);
  const repairs: ScannerSpliceRepair[] = [...assessment.repairs];
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
  const report = validateScannerMusicXmlSemantics(musicXml);
  if (!report.valid) {
    return { musicXml: null, refusals: [], repairs, violations: report.violations };
  }
  return { musicXml, refusals: [], repairs, violations: [] };
}
