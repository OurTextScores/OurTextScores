import { createHash } from 'node:crypto';
import {
  scannerBlockContentSignature,
  type ScannerComparisonPair,
  type ScannerEngineId,
  type ScannerOutputCompleteness,
  type ScannerPartMatch
} from './scanner-dual-engine';
import {
  alignScannerMeasures,
  classifyScannerMeasureDifference,
  SCANNER_MEASURE_ALIGNMENT_VERSION,
  SCANNER_MEASURE_DESCRIPTOR_VERSION,
  type ScannerMeasureDescriptor,
  type ScannerMeasureDifferenceClass,
  type ScannerDescribedPart
} from './scanner-measure-analysis';
import { SCANNER_PART_MATCH_VERSION, type ScannerPartMatchResult } from './scanner-part-matching';

export const SCANNER_COMPARISON_BLOCK_VERSION = 'scanner-comparison-block-v1';
export const SCANNER_COMPARISON_ANALYSIS_VERSION = 'scanner-comparison-analysis-v1';

export type ScannerComparisonDifferenceClass =
  | ScannerMeasureDifferenceClass
  | 'measure-added'
  | 'measure-removed';

export interface ScannerComparisonMeasureIdentity {
  engine: ScannerEngineId;
  artifactChecksumSha256: string;
  stablePartKey: string;
  documentPartId: string;
  measureIndex: number;
  measureNumber?: string;
}

export interface ScannerComparisonWarning {
  engineId: ScannerEngineId;
  code: 'output-completeness' | 'unsupported-semantic-class';
  detail: string;
  semanticClass?: string;
}

export interface ScannerComparisonSideInput {
  engineId: ScannerEngineId;
  artifactChecksumSha256: string;
  documentPartId: string;
  measures: ScannerMeasureDescriptor[];
  completeness?: ScannerOutputCompleteness;
  unsupportedSemanticClasses?: string[];
}

export interface ScannerComparisonDocumentSideInput {
  engineId: ScannerEngineId;
  artifactChecksumSha256: string;
  parts: ScannerDescribedPart[];
  completeness?: ScannerOutputCompleteness;
  unsupportedSemanticClasses?: string[];
}

export interface ScannerComparisonBlock {
  version: typeof SCANNER_COMPARISON_BLOCK_VERSION;
  blockIndex: number;
  pair: ScannerComparisonPair;
  stablePartKey: string;
  baseMeasureRefs: ScannerComparisonMeasureIdentity[];
  candidateMeasureRefs: ScannerComparisonMeasureIdentity[];
  /**
   * The base measure this block sits after; `-1` means the start of the part.
   *
   * Only a block with base measures of its own knows where it is from those.
   * A block the base does not read at all — a passage only the candidate saw —
   * has no position without this, and "insert these bars" is meaningless
   * without one. Blocks cover differing runs only, so the matched measures
   * between them cannot supply it either; the op walk can, and does.
   */
  baseAnchorIndex: number;
  baseDescriptorHashes: string[];
  candidateDescriptorHashes: string[];
  differenceClasses: ScannerComparisonDifferenceClass[];
  completenessWarnings: ScannerComparisonWarning[];
  contentSignature: string;
}

export type ScannerComparisonAnalysis =
  | {
      version: typeof SCANNER_COMPARISON_ANALYSIS_VERSION;
      status: 'refused';
      pair: ScannerComparisonPair;
      partMatches: ScannerPartMatch[];
      refusalReasons: string[];
    }
  | {
      version: typeof SCANNER_COMPARISON_ANALYSIS_VERSION;
      status: 'succeeded';
      pair: ScannerComparisonPair;
      partMatches: MatchedPart[];
      blocks: ScannerComparisonBlock[];
    };

type MatchedPart = Extract<ScannerPartMatch, { outcome: 'matched' }>;

interface PendingBlock {
  /** Base measure last seen before this block began; -1 at the start of a part. */
  anchorIndex: number;
  baseIndices: number[];
  candidateIndices: number[];
  differenceClasses: Set<ScannerComparisonDifferenceClass>;
  hasCoarseMismatch: boolean;
  contextBeforeHash?: string;
}

const contextHash = (base: ScannerMeasureDescriptor, candidate: ScannerMeasureDescriptor): string =>
  `${SCANNER_COMPARISON_BLOCK_VERSION}:context:${createHash('sha256')
    .update(JSON.stringify([base.richHash, candidate.richHash]))
    .digest('hex')}`;

const newPending = (contextBeforeHash?: string, anchorIndex = -1): PendingBlock => ({
  anchorIndex,
  baseIndices: [],
  candidateIndices: [],
  differenceClasses: new Set(),
  hasCoarseMismatch: false,
  contextBeforeHash
});

const isPending = (pending: PendingBlock): boolean =>
  pending.baseIndices.length > 0 || pending.candidateIndices.length > 0;

function validateSide(side: ScannerComparisonSideInput, endpoint: MatchedPart['base']): void {
  if (!/^[a-f0-9]{64}$/i.test(side.artifactChecksumSha256)) {
    throw new Error('Invalid scanner comparison artifact checksum');
  }
  if (
    side.engineId !== endpoint.engineId ||
    side.artifactChecksumSha256.toLowerCase() !== endpoint.artifactChecksumSha256.toLowerCase() ||
    side.documentPartId !== endpoint.documentPartId
  ) {
    throw new Error('Scanner comparison side does not match the selected part endpoint');
  }
  for (let index = 0; index < side.measures.length; index += 1) {
    if (side.measures[index].measureIndex !== index) {
      throw new Error('Scanner comparison measures must be ordered and contiguous');
    }
  }
}

function measureRef(
  side: ScannerComparisonSideInput,
  stablePartKey: string,
  descriptor: ScannerMeasureDescriptor
): ScannerComparisonMeasureIdentity {
  return {
    engine: side.engineId,
    artifactChecksumSha256: side.artifactChecksumSha256.toLowerCase(),
    stablePartKey,
    documentPartId: side.documentPartId,
    measureIndex: descriptor.measureIndex,
    measureNumber: descriptor.measureNumber
  };
}

function warningsFor(
  side: ScannerComparisonSideInput,
  differences: ReadonlySet<ScannerComparisonDifferenceClass>
): ScannerComparisonWarning[] {
  const warnings: ScannerComparisonWarning[] = [];
  if (side.completeness && side.completeness !== 'complete') {
    warnings.push({
      engineId: side.engineId,
      code: 'output-completeness',
      detail: `Engine output completeness is ${side.completeness}`
    });
  }
  for (const semanticClass of [...new Set(side.unsupportedSemanticClasses || [])].sort()) {
    if (!differences.has(semanticClass as ScannerComparisonDifferenceClass)) continue;
    warnings.push({
      engineId: side.engineId,
      code: 'unsupported-semantic-class',
      semanticClass,
      detail: `Engine does not support ${semanticClass}`
    });
  }
  return warnings;
}

/**
 * Form signed structural blocks for one successfully matched part.
 * Geometry is deliberately not accepted here; a later verified join upgrades
 * these identities to source-image-backed MeasureRefs or refuses the UI.
 */
export function buildScannerComparisonBlocks(input: {
  partMatch: MatchedPart;
  base: ScannerComparisonSideInput;
  candidate: ScannerComparisonSideInput;
}): ScannerComparisonBlock[] {
  const { partMatch, base, candidate } = input;
  if (partMatch.outcome !== 'matched') {
    throw new Error('Scanner comparison blocks require a matched part');
  }
  validateSide(base, partMatch.base);
  validateSide(candidate, partMatch.candidate);
  if (base.engineId === candidate.engineId) {
    throw new Error('Scanner comparison requires two distinct engines');
  }
  const pair: ScannerComparisonPair = {
    baseEngineId: base.engineId,
    candidateEngineId: candidate.engineId
  };
  const ops = alignScannerMeasures(base.measures, candidate.measures);
  const blocks: ScannerComparisonBlock[] = [];
  let pending = newPending();
  let previousPairContextHash: string | undefined;
  /** Last base measure consumed by the walk; anchors a candidate-only block. */
  let lastBaseIndex = -1;

  const flush = (contextAfterHash?: string): void => {
    if (!isPending(pending)) return;
    const baseDescriptors = pending.baseIndices.map((index) => base.measures[index]);
    const candidateDescriptors = pending.candidateIndices.map((index) => candidate.measures[index]);
    const pairCount = Math.min(baseDescriptors.length, candidateDescriptors.length);
    for (let index = 0; index < pairCount; index += 1) {
      for (const difference of classifyScannerMeasureDifference(
        baseDescriptors[index],
        candidateDescriptors[index]
      )) {
        pending.differenceClasses.add(difference);
      }
    }
    if (
      pending.hasCoarseMismatch &&
      baseDescriptors.length > 0 &&
      candidateDescriptors.length > 0
    ) {
      pending.differenceClasses.add('notation');
    }
    if (candidateDescriptors.length > baseDescriptors.length) {
      pending.differenceClasses.add('measure-added');
    }
    if (baseDescriptors.length > candidateDescriptors.length) {
      pending.differenceClasses.add('measure-removed');
    }
    if (baseDescriptors.length === 0) pending.differenceClasses.add('measure-added');
    if (candidateDescriptors.length === 0) pending.differenceClasses.add('measure-removed');

    const differenceClasses = [...pending.differenceClasses].sort();
    const baseDescriptorHashes = baseDescriptors.map((descriptor) => descriptor.richHash);
    const candidateDescriptorHashes = candidateDescriptors.map((descriptor) => descriptor.richHash);
    blocks.push({
      version: SCANNER_COMPARISON_BLOCK_VERSION,
      blockIndex: blocks.length,
      pair,
      stablePartKey: partMatch.stablePartKey,
      baseMeasureRefs: baseDescriptors.map((descriptor) =>
        measureRef(base, partMatch.stablePartKey, descriptor)
      ),
      candidateMeasureRefs: candidateDescriptors.map((descriptor) =>
        measureRef(candidate, partMatch.stablePartKey, descriptor)
      ),
      baseDescriptorHashes,
      candidateDescriptorHashes,
      // A block with base measures is anchored by its own first one; one
      // without is anchored by the last base measure seen before it.
      baseAnchorIndex:
        pending.baseIndices.length > 0 ? Math.min(...pending.baseIndices) - 1 : pending.anchorIndex,
      differenceClasses,
      completenessWarnings: [
        ...warningsFor(base, pending.differenceClasses),
        ...warningsFor(candidate, pending.differenceClasses)
      ],
      contentSignature: scannerBlockContentSignature({
        sides: [
          {
            role: 'base',
            engineId: base.engineId,
            artifactChecksumSha256: base.artifactChecksumSha256.toLowerCase(),
            descriptorHashes: baseDescriptorHashes
          },
          {
            role: 'candidate',
            engineId: candidate.engineId,
            artifactChecksumSha256: candidate.artifactChecksumSha256.toLowerCase(),
            descriptorHashes: candidateDescriptorHashes
          }
        ],
        partMatchVersion: SCANNER_PART_MATCH_VERSION,
        alignmentVersion: SCANNER_MEASURE_ALIGNMENT_VERSION,
        descriptorVersion: SCANNER_MEASURE_DESCRIPTOR_VERSION,
        stablePartKey: partMatch.stablePartKey,
        contextBeforeHash: pending.contextBeforeHash,
        contextAfterHash
      })
    });
    pending = newPending(contextAfterHash, lastBaseIndex);
  };

  const pairContextFor = (op: (typeof ops)[number]): string | undefined => {
    if (op.type !== 'equal' && op.type !== 'aligned') return undefined;
    return contextHash(base.measures[op.baseIndex], candidate.measures[op.candidateIndex]);
  };

  for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
    const op = ops[opIndex];
    if (op.type === 'equal' || op.type === 'aligned') {
      const baseDescriptor = base.measures[op.baseIndex];
      const candidateDescriptor = candidate.measures[op.candidateIndex];
      const pairContextHash = contextHash(baseDescriptor, candidateDescriptor);
      const differences = classifyScannerMeasureDifference(baseDescriptor, candidateDescriptor);
      if (op.type === 'aligned') {
        flush(pairContextHash);
        pending = newPending(previousPairContextHash, lastBaseIndex);
        pending.baseIndices.push(op.baseIndex);
        pending.candidateIndices.push(op.candidateIndex);
        pending.hasCoarseMismatch = true;
        differences.forEach((difference) => pending.differenceClasses.add(difference));
        const nextPairContextHash = ops
          .slice(opIndex + 1)
          .map(pairContextFor)
          .find(Boolean);
        lastBaseIndex = op.baseIndex;
        flush(nextPairContextHash);
        previousPairContextHash = pairContextHash;
        pending = newPending(pairContextHash, lastBaseIndex);
        continue;
      }
      if (differences.length === 0) {
        lastBaseIndex = op.baseIndex;
        flush(pairContextHash);
        pending = newPending(pairContextHash, lastBaseIndex);
        previousPairContextHash = pairContextHash;
        continue;
      }
      pending.baseIndices.push(op.baseIndex);
      pending.candidateIndices.push(op.candidateIndex);
      differences.forEach((difference) => pending.differenceClasses.add(difference));
      previousPairContextHash = pairContextHash;
      lastBaseIndex = op.baseIndex;
      continue;
    }
    pending.hasCoarseMismatch = true;
    if (op.type === 'removed') {
      pending.baseIndices.push(op.baseIndex);
      lastBaseIndex = op.baseIndex;
    } else pending.candidateIndices.push(op.candidateIndex);
  }
  flush();
  return blocks;
}

function partsByDocumentId(
  side: ScannerComparisonDocumentSideInput
): Map<string, ScannerDescribedPart> {
  const result = new Map<string, ScannerDescribedPart>();
  for (const part of side.parts) {
    if (!part.documentPartId || result.has(part.documentPartId)) {
      throw new Error('Scanner comparison described parts require unique document IDs');
    }
    result.set(part.documentPartId, part);
  }
  return result;
}

/**
 * Enforce the page-wide part identity gate before any measure comparison runs.
 * A partial set of plausible matches is evidence for a refusal, not permission
 * to compare only the convenient parts.
 */
export function buildScannerComparisonAnalysis(input: {
  partMatchResult: ScannerPartMatchResult;
  base: ScannerComparisonDocumentSideInput;
  candidate: ScannerComparisonDocumentSideInput;
}): ScannerComparisonAnalysis {
  const { partMatchResult, base, candidate } = input;
  if (partMatchResult.version !== SCANNER_PART_MATCH_VERSION) {
    throw new Error('Scanner comparison part-match version is stale');
  }
  if (
    partMatchResult.pair.baseEngineId !== base.engineId ||
    partMatchResult.pair.candidateEngineId !== candidate.engineId
  ) {
    throw new Error('Scanner comparison documents do not match the selected engine pair');
  }

  const nonMatches = partMatchResult.matches.filter(
    (match): match is Exclude<ScannerPartMatch, MatchedPart> => match.outcome !== 'matched'
  );
  if (!partMatchResult.comparisonAllowed || nonMatches.length > 0) {
    const refusalReasons = [
      ...new Set([
        ...partMatchResult.refusalReasons,
        ...nonMatches.map((match) => match.refusalReason),
        ...(partMatchResult.matches.length === 0
          ? ['No cross-engine part matches were available']
          : [])
      ])
    ];
    return {
      version: SCANNER_COMPARISON_ANALYSIS_VERSION,
      status: 'refused',
      pair: partMatchResult.pair,
      partMatches: partMatchResult.matches,
      refusalReasons:
        refusalReasons.length > 0
          ? refusalReasons
          : ['Part matching did not authorize measure comparison']
    };
  }

  const matchedParts = partMatchResult.matches as MatchedPart[];
  if (matchedParts.length === 0) {
    throw new Error('Scanner comparison requires at least one matched part');
  }
  if (
    new Set(matchedParts.map((match) => match.stablePartKey)).size !== matchedParts.length ||
    new Set(matchedParts.map((match) => match.base.documentPartId)).size !== matchedParts.length ||
    new Set(matchedParts.map((match) => match.candidate.documentPartId)).size !==
      matchedParts.length
  ) {
    throw new Error('Scanner comparison part matches must be one-to-one');
  }
  const baseParts = partsByDocumentId(base);
  const candidateParts = partsByDocumentId(candidate);
  if (baseParts.size !== matchedParts.length || candidateParts.size !== matchedParts.length) {
    throw new Error('Scanner comparison descriptors do not cover exactly the matched parts');
  }

  const blocks = matchedParts.flatMap((partMatch) => {
    const basePart = baseParts.get(partMatch.base.documentPartId);
    const candidatePart = candidateParts.get(partMatch.candidate.documentPartId);
    if (!basePart || !candidatePart) {
      throw new Error('Scanner comparison descriptors are missing a matched part');
    }
    return buildScannerComparisonBlocks({
      partMatch,
      base: {
        ...base,
        documentPartId: basePart.documentPartId,
        measures: basePart.measures
      },
      candidate: {
        ...candidate,
        documentPartId: candidatePart.documentPartId,
        measures: candidatePart.measures
      }
    });
  });

  return {
    version: SCANNER_COMPARISON_ANALYSIS_VERSION,
    status: 'succeeded',
    pair: partMatchResult.pair,
    partMatches: matchedParts,
    blocks: blocks.map((block, blockIndex) => ({ ...block, blockIndex }))
  };
}
