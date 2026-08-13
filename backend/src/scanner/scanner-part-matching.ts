import { createHash } from 'node:crypto';
import { parseValidMusicXml } from './scanner-musicxml';
import type {
  ScannerComparisonPair,
  ScannerPartEndpoint,
  ScannerPartMatch,
  ScannerPartMatchEvidence
} from './scanner-dual-engine';
import { isScannerEngineId } from './scanner-dual-engine';

export const SCANNER_PART_MATCH_VERSION = 'scanner-part-match-v1';
export const MAX_SCANNER_COMPARISON_PARTS = 256;

export interface ScannerPartDocumentInput {
  engineId: string;
  /** The stored artifact this reading came from; what every record names. */
  artifactChecksumSha256: string;
  musicXml: Buffer;
  /**
   * Checksum of `musicXml` when it is not the artifact byte for byte.
   *
   * Set only by a recorded, deterministic rewrite of the artifact — currently
   * part-layout reconciliation. The integrity check still runs, against this
   * instead, so bytes are never accepted unverified; what changes is which of
   * the two hashes is the document's identity and which is its content.
   */
  contentChecksumSha256?: string;
}

export interface ScannerPartMatchResult {
  version: typeof SCANNER_PART_MATCH_VERSION;
  pair: ScannerComparisonPair;
  matches: ScannerPartMatch[];
  comparisonAllowed: boolean;
  refusalReasons: string[];
}

interface PartStructure {
  measureCount: number;
  noteCount: number;
  voiceCount: number;
  restRatio: number;
}

interface ParsedPart {
  endpoint: ScannerPartEndpoint;
  structure: PartStructure;
}

interface CandidateEdge {
  base: ParsedPart;
  candidate: ParsedPart;
  evidence: ScannerPartMatchEvidence;
  eligible: boolean;
}

const asArray = (value: unknown): any[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

const text = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return String((value as any)['#text'] ?? '').trim();
  return String(value).trim();
};

/** Names are evidence, not identity: normalize spelling without inventing aliases. */
export function normalizeScannerPartName(value: unknown): string | undefined {
  const normalized = text(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || undefined;
}

const ratioSimilarity = (left: number, right: number): number => {
  if (left === 0 && right === 0) return 1;
  if (left <= 0 || right <= 0) return 0;
  return Math.min(left, right) / Math.max(left, right);
};

function structureAgreement(left: PartStructure, right: PartStructure): number {
  return Number(
    (
      ratioSimilarity(left.measureCount, right.measureCount) * 0.45 +
      ratioSimilarity(left.noteCount, right.noteCount) * 0.35 +
      ratioSimilarity(left.voiceCount, right.voiceCount) * 0.1 +
      (1 - Math.abs(left.restRatio - right.restRatio)) * 0.1
    ).toFixed(6)
  );
}

function readParts(input: ScannerPartDocumentInput): ParsedPart[] {
  if (!isScannerEngineId(input.engineId) || !/^[a-f0-9]{64}$/i.test(input.artifactChecksumSha256)) {
    throw new Error('Invalid scanner part-matching document identity');
  }
  const expected = (input.contentChecksumSha256 || input.artifactChecksumSha256).toLowerCase();
  if (!/^[a-f0-9]{64}$/i.test(expected)) {
    throw new Error('Invalid scanner part-matching document identity');
  }
  const actualChecksum = createHash('sha256').update(input.musicXml).digest('hex');
  if (actualChecksum !== expected) {
    throw new Error('Scanner part-matching artifact checksum does not match its MusicXML');
  }
  const { root, rootName } = parseValidMusicXml(input.musicXml);
  if (rootName !== 'score-partwise') {
    throw new Error('Scanner part matching requires score-partwise MusicXML');
  }
  const parts = asArray(root.part);
  if (parts.length === 0 || parts.length > MAX_SCANNER_COMPARISON_PARTS) {
    throw new Error(
      `Scanner part matching supports between 1 and ${MAX_SCANNER_COMPARISON_PARTS} parts`
    );
  }
  const scoreParts = new Map(
    asArray(root['part-list']?.['score-part']).map((part) => [String(part?.['@_id'] || ''), part])
  );
  const seenIds = new Set<string>();

  return parts.map((part, ordinal) => {
    const documentPartId = String(part?.['@_id'] || '');
    if (!documentPartId || seenIds.has(documentPartId)) {
      throw new Error('MusicXML parts must have unique non-empty document IDs');
    }
    seenIds.add(documentPartId);
    const measures = asArray(part.measure);
    if (measures.length === 0) throw new Error(`MusicXML part ${documentPartId} has no measures`);
    const notes = measures.flatMap((measure) => asArray(measure?.note));
    const declaredStaves = measures.flatMap((measure) =>
      asArray(measure?.attributes).map((attributes) => Number(text(attributes?.staves)))
    );
    const referencedStaves = notes.map((note) => Number(text(note?.staff)));
    const staffCount = Math.max(
      1,
      ...declaredStaves.filter((value) => Number.isInteger(value) && value > 0),
      ...referencedStaves.filter((value) => Number.isInteger(value) && value > 0)
    );
    const voices = new Set(notes.map((note) => text(note?.voice)).filter(Boolean));
    const restCount = notes.filter((note) => note?.rest !== undefined).length;
    const scorePart = scoreParts.get(documentPartId);
    return {
      endpoint: {
        engineId: input.engineId,
        artifactChecksumSha256: input.artifactChecksumSha256.toLowerCase(),
        documentPartId,
        ordinal,
        normalizedName: normalizeScannerPartName(scorePart?.['part-name']),
        staffCount
      },
      structure: {
        measureCount: measures.length,
        noteCount: notes.length,
        voiceCount: Math.max(voices.size, notes.length > 0 ? 1 : 0),
        restRatio: notes.length > 0 ? restCount / notes.length : 0
      }
    };
  });
}

function edge(base: ParsedPart, candidate: ParsedPart): CandidateEdge {
  const normalizedNameEqual = Boolean(
    base.endpoint.normalizedName &&
      candidate.endpoint.normalizedName &&
      base.endpoint.normalizedName === candidate.endpoint.normalizedName
  );
  const ordinalEqual = base.endpoint.ordinal === candidate.endpoint.ordinal;
  const staffCountEqual = base.endpoint.staffCount === candidate.endpoint.staffCount;
  const agreement = structureAgreement(base.structure, candidate.structure);
  const matchScore = Number(
    ((normalizedNameEqual ? 0.5 : 0) + (ordinalEqual ? 0.2 : 0) + agreement * 0.3).toFixed(6)
  );
  return {
    base,
    candidate,
    evidence: {
      normalizedNameEqual,
      ordinalEqual,
      staffCountEqual,
      structureAgreement: agreement,
      matchScore
    },
    eligible: staffCountEqual && agreement >= 0.7 && (normalizedNameEqual || ordinalEqual)
  };
}

function stablePartKey(pair: ScannerComparisonPair, selected: CandidateEdge): string {
  return `scanner-part-v1:${createHash('sha256')
    .update(
      JSON.stringify({
        version: SCANNER_PART_MATCH_VERSION,
        pair,
        base: selected.base.endpoint,
        candidate: selected.candidate.endpoint
      })
    )
    .digest('hex')}`;
}

function indistinguishableEdges(edges: CandidateEdge[]): boolean {
  if (edges.length < 2) return false;
  const [best, second] = edges;
  const bestName = best.evidence.normalizedNameEqual;
  const secondName = second.evidence.normalizedNameEqual;
  if (bestName && secondName) {
    return (
      Math.abs(
        (best.evidence.structureAgreement || 0) - (second.evidence.structureAgreement || 0)
      ) < 0.1
    );
  }
  if (!bestName) {
    const structurallyCompatible = edges.filter(
      (item) => item.evidence.staffCountEqual && (item.evidence.structureAgreement || 0) >= 0.7
    );
    return (
      structurallyCompatible.length > 1 &&
      Math.abs(
        (structurallyCompatible[0].evidence.structureAgreement || 0) -
          (structurallyCompatible[1].evidence.structureAgreement || 0)
      ) < 0.1
    );
  }
  return (best.evidence.matchScore || 0) - (second.evidence.matchScore || 0) < 0.1;
}

/**
 * Establish pair-scoped part identity before measure alignment.
 *
 * The matcher is intentionally conservative. Document IDs are ignored, and
 * ordinal position cannot break a near-tie between indistinguishable parts.
 */
export function matchScannerMusicXmlParts(
  baseInput: ScannerPartDocumentInput,
  candidateInput: ScannerPartDocumentInput
): ScannerPartMatchResult {
  if (baseInput.engineId === candidateInput.engineId) {
    throw new Error('Scanner comparison requires two distinct engines');
  }
  const pair: ScannerComparisonPair = {
    baseEngineId: baseInput.engineId,
    candidateEngineId: candidateInput.engineId
  };
  const baseParts = readParts(baseInput);
  const candidateParts = readParts(candidateInput);
  const allEdges = baseParts.flatMap((base) =>
    candidateParts.map((candidate) => edge(base, candidate))
  );
  const selectedByBase = new Map<ParsedPart, CandidateEdge>();
  const bestByBase = new Map<ParsedPart, CandidateEdge>();
  const bestByCandidate = new Map<ParsedPart, CandidateEdge>();
  const ambiguousBases = new Set<ParsedPart>();
  const ambiguousCandidates = new Set<ParsedPart>();

  for (const base of baseParts) {
    const ranked = allEdges
      .filter((item) => item.base === base)
      .sort((left, right) => (right.evidence.matchScore || 0) - (left.evidence.matchScore || 0));
    if (ranked[0]) bestByBase.set(base, ranked[0]);
    const eligible = ranked.filter((item) => item.eligible);
    if (indistinguishableEdges(eligible)) ambiguousBases.add(base);
    else if (eligible[0]) selectedByBase.set(base, eligible[0]);
  }

  for (const candidate of candidateParts) {
    const ranked = allEdges
      .filter((item) => item.candidate === candidate)
      .sort((left, right) => (right.evidence.matchScore || 0) - (left.evidence.matchScore || 0));
    if (ranked[0]) bestByCandidate.set(candidate, ranked[0]);
    if (indistinguishableEdges(ranked.filter((item) => item.eligible))) {
      ambiguousCandidates.add(candidate);
    }
  }

  const basesByCandidate = new Map<ParsedPart, ParsedPart[]>();
  for (const [base, selected] of selectedByBase) {
    const bases = basesByCandidate.get(selected.candidate) || [];
    bases.push(base);
    basesByCandidate.set(selected.candidate, bases);
  }
  for (const bases of basesByCandidate.values()) {
    if (bases.length > 1) bases.forEach((base) => ambiguousBases.add(base));
  }
  for (const [base, selected] of selectedByBase) {
    if (ambiguousCandidates.has(selected.candidate)) ambiguousBases.add(base);
  }

  const matches: ScannerPartMatch[] = [];
  const matchedCandidates = new Set<ParsedPart>();
  for (const base of baseParts) {
    const selected = selectedByBase.get(base);
    const closest = selected || bestByBase.get(base);
    if (ambiguousBases.has(base)) {
      matches.push({
        outcome: 'ambiguous',
        base: base.endpoint,
        candidate: closest?.candidate.endpoint,
        evidence: closest?.evidence || {},
        refusalReason: `Part ${base.endpoint.ordinal! + 1} has no unique cross-engine match`
      });
    } else if (!selected) {
      matches.push({
        outcome: 'unmatched',
        base: base.endpoint,
        candidate: closest?.candidate.endpoint,
        evidence: closest?.evidence || {},
        refusalReason: `Part ${base.endpoint.ordinal! + 1} has no compatible candidate part`
      });
    } else {
      matchedCandidates.add(selected.candidate);
      matches.push({
        outcome: 'matched',
        stablePartKey: stablePartKey(pair, selected),
        base: base.endpoint,
        candidate: selected.candidate.endpoint,
        evidence: selected.evidence
      });
    }
  }
  for (const candidate of candidateParts) {
    if (matchedCandidates.has(candidate)) continue;
    const closest = bestByCandidate.get(candidate);
    const contested = allEdges.some(
      (item) => item.candidate === candidate && item.eligible && ambiguousBases.has(item.base)
    );
    matches.push({
      outcome: contested || ambiguousCandidates.has(candidate) ? 'ambiguous' : 'unmatched',
      base: closest?.base.endpoint,
      candidate: candidate.endpoint,
      evidence: closest?.evidence || {},
      refusalReason:
        contested || ambiguousCandidates.has(candidate)
          ? `Candidate part ${candidate.endpoint.ordinal! + 1} has no unique base-engine match`
          : `Candidate part ${candidate.endpoint.ordinal! + 1} has no compatible base part`
    });
  }

  const refusalReasons = matches.flatMap((match) =>
    match.outcome === 'matched' ? [] : [match.refusalReason]
  );
  const matchedCount = matches.filter((match) => match.outcome === 'matched').length;
  return {
    version: SCANNER_PART_MATCH_VERSION,
    pair,
    matches,
    comparisonAllowed:
      refusalReasons.length === 0 &&
      matchedCount === baseParts.length &&
      matchedCount === candidateParts.length,
    refusalReasons
  };
}
