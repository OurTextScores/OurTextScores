import {
  SCANNER_MEASURE_GEOMETRY_VERSION,
  type ScannerMeasureGeometryManifest
} from './scanner-comparison-geometry';
import {
  alignScannerMeasures,
  SCANNER_MEASURE_ALIGNMENT_VERSION,
  type ScannerDescribedPart
} from './scanner-measure-analysis';
import { SCANNER_PART_MATCH_VERSION, type ScannerPartMatchResult } from './scanner-part-matching';
import type { ScannerEngineId, ScannerMeasureRef, ScannerPartMatch } from './scanner-dual-engine';
import type { ScannerRasterIdentity } from './schemas/scanner-job.schema';

export const SCANNER_ALIGNED_MEASURE_GEOMETRY_PRODUCER_ID = 'scanner-aligned-measure-geometry';
export const SCANNER_ALIGNED_MEASURE_GEOMETRY_PRODUCER_VERSION =
  'scanner-aligned-measure-geometry-v1';

export type ScannerAlignedGeometryRefusalCode =
  | 'part-match-unavailable'
  | 'reference-engine-mismatch'
  | 'recognition-raster-mismatch'
  | 'reference-geometry-invalid'
  | 'measure-analysis-mismatch';

export interface ScannerAlignedGeometryRefusal {
  code: ScannerAlignedGeometryRefusalCode;
  detail: string;
  stablePartKey?: string;
  measureIndex?: number;
}

export type ScannerAlignedMeasureGeometryResult =
  | { status: 'succeeded'; geometry: ScannerMeasureGeometryManifest }
  | { status: 'refused'; refusalReasons: ScannerAlignedGeometryRefusal[] };

type MatchedPart = Extract<ScannerPartMatch, { outcome: 'matched' }>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function sameRaster(left: ScannerRasterIdentity, right: ScannerRasterIdentity): boolean {
  return (
    left.checksumSha256.toLowerCase() === right.checksumSha256.toLowerCase() &&
    left.width === right.width &&
    left.height === right.height
  );
}

function endpointFor(match: MatchedPart, engineId: ScannerEngineId) {
  if (match.base.engineId === engineId) return match.base;
  if (match.candidate.engineId === engineId) return match.candidate;
  return undefined;
}

function describedPart(
  parts: ScannerDescribedPart[],
  documentPartId: string
): ScannerDescribedPart | undefined {
  const matches = parts.filter((part) => part.documentPartId === documentPartId);
  return matches.length === 1 ? matches[0] : undefined;
}

function validDescribedPart(part: ScannerDescribedPart | undefined): part is ScannerDescribedPart {
  return Boolean(
    part &&
      part.measures.length > 0 &&
      part.measures.every((measure, index) => measure.measureIndex === index)
  );
}

function refKey(ref: ScannerMeasureRef): string {
  return JSON.stringify([
    ref.engine,
    ref.artifactChecksumSha256.toLowerCase(),
    ref.stablePartKey,
    ref.documentPartId,
    ref.measureIndex
  ]);
}

function validReferenceRef(
  ref: ScannerMeasureRef,
  geometry: ScannerMeasureGeometryManifest
): boolean {
  return (
    SHA256_PATTERN.test(ref.artifactChecksumSha256) &&
    Number.isInteger(ref.measureIndex) &&
    ref.measureIndex >= 0 &&
    Array.isArray(ref.cropRegions) &&
    ref.cropRegions.length > 0 &&
    ref.cropRegions.every((crop) => {
      if (
        !Array.isArray(crop.region) ||
        crop.region.length !== 4 ||
        crop.region.some((coordinate) => !Number.isInteger(coordinate))
      ) {
        return false;
      }
      const [left, top, right, bottom] = crop.region;
      return (
        Number.isInteger(crop.systemIndex) &&
        crop.systemIndex >= 0 &&
        Array.isArray(crop.staffIndices) &&
        crop.staffIndices.length > 0 &&
        crop.staffIndices.every((staffIndex) => Number.isInteger(staffIndex) && staffIndex >= 0) &&
        left >= 0 &&
        top >= 0 &&
        right > left &&
        bottom > top &&
        right <= geometry.sourceImage.width &&
        bottom <= geometry.sourceImage.height
      );
    })
  );
}

/**
 * Transfer physical measure crops from one geometry-capable engine to another
 * only for one-to-one correspondences accepted by the pinned measure aligner.
 * Added, removed, and ambiguous measures intentionally receive no geometry.
 */
export function buildScannerAlignedMeasureGeometry(input: {
  referenceEngineId: ScannerEngineId;
  referenceGeometry: ScannerMeasureGeometryManifest;
  baseRecognitionRaster: ScannerRasterIdentity;
  candidateRecognitionRaster: ScannerRasterIdentity;
  partMatchResult: ScannerPartMatchResult;
  baseParts: ScannerDescribedPart[];
  candidateParts: ScannerDescribedPart[];
}): ScannerAlignedMeasureGeometryResult {
  const { referenceGeometry, partMatchResult } = input;
  if (
    partMatchResult.version !== SCANNER_PART_MATCH_VERSION ||
    !partMatchResult.comparisonAllowed ||
    partMatchResult.matches.length === 0 ||
    partMatchResult.matches.some((match) => match.outcome !== 'matched')
  ) {
    return {
      status: 'refused',
      refusalReasons: [
        {
          code: 'part-match-unavailable',
          detail: 'All parts must have unique cross-engine matches before geometry is aligned'
        }
      ]
    };
  }
  if (
    input.referenceEngineId !== partMatchResult.pair.baseEngineId &&
    input.referenceEngineId !== partMatchResult.pair.candidateEngineId
  ) {
    return {
      status: 'refused',
      refusalReasons: [
        {
          code: 'reference-engine-mismatch',
          detail: 'The geometry reference engine is not a member of the comparison pair'
        }
      ]
    };
  }
  const referenceRaster =
    input.referenceEngineId === partMatchResult.pair.baseEngineId
      ? input.baseRecognitionRaster
      : input.candidateRecognitionRaster;
  if (
    !sameRaster(input.baseRecognitionRaster, input.candidateRecognitionRaster) ||
    !sameRaster(referenceRaster, referenceGeometry.sourceImage)
  ) {
    return {
      status: 'refused',
      refusalReasons: [
        {
          code: 'recognition-raster-mismatch',
          detail: 'Both engine runs and reference geometry must use the same recognition raster'
        }
      ]
    };
  }
  if (
    referenceGeometry.version !== SCANNER_MEASURE_GEOMETRY_VERSION ||
    !SHA256_PATTERN.test(referenceGeometry.sourceImage?.checksumSha256 || '') ||
    !Number.isInteger(referenceGeometry.sourceImage?.width) ||
    referenceGeometry.sourceImage.width <= 0 ||
    !Number.isInteger(referenceGeometry.sourceImage?.height) ||
    referenceGeometry.sourceImage.height <= 0 ||
    referenceGeometry.measureRefs.length === 0 ||
    referenceGeometry.measureRefs.some((ref) => !validReferenceRef(ref, referenceGeometry)) ||
    new Set(referenceGeometry.measureRefs.map(refKey)).size !== referenceGeometry.measureRefs.length
  ) {
    return {
      status: 'refused',
      refusalReasons: [
        {
          code: 'reference-geometry-invalid',
          detail: 'Reference geometry is missing, duplicated, or outside the recognition raster'
        }
      ]
    };
  }

  const matches = partMatchResult.matches as MatchedPart[];
  const referenceRefs = new Map(referenceGeometry.measureRefs.map((ref) => [refKey(ref), ref]));
  const derivedRefs: ScannerMeasureRef[] = [];
  const refusalReasons: ScannerAlignedGeometryRefusal[] = [];

  for (const match of matches) {
    const referenceEndpoint = endpointFor(match, input.referenceEngineId);
    const targetEndpoint =
      input.referenceEngineId === match.base.engineId ? match.candidate : match.base;
    const basePart = describedPart(input.baseParts, match.base.documentPartId);
    const candidatePart = describedPart(input.candidateParts, match.candidate.documentPartId);
    if (!referenceEndpoint || !validDescribedPart(basePart) || !validDescribedPart(candidatePart)) {
      refusalReasons.push({
        code: 'measure-analysis-mismatch',
        detail: 'Matched part endpoints do not have one ordered measure analysis',
        stablePartKey: match.stablePartKey
      });
      continue;
    }
    const referencePart =
      input.referenceEngineId === match.base.engineId ? basePart : candidatePart;
    const targetPart = input.referenceEngineId === match.base.engineId ? candidatePart : basePart;
    const refsByMeasure = new Map<number, ScannerMeasureRef>();
    for (const measure of referencePart.measures) {
      const key = refKey({
        engine: referenceEndpoint.engineId,
        artifactChecksumSha256: referenceEndpoint.artifactChecksumSha256,
        stablePartKey: match.stablePartKey,
        documentPartId: referenceEndpoint.documentPartId,
        measureIndex: measure.measureIndex,
        cropRegions: []
      });
      const ref = referenceRefs.get(key);
      if (!ref) {
        refusalReasons.push({
          code: 'reference-geometry-invalid',
          detail: 'Reference geometry does not cover every analyzed reference measure',
          stablePartKey: match.stablePartKey,
          measureIndex: measure.measureIndex
        });
        continue;
      }
      refsByMeasure.set(measure.measureIndex, ref);
    }
    if (refsByMeasure.size !== referencePart.measures.length) continue;

    for (const op of alignScannerMeasures(basePart.measures, candidatePart.measures)) {
      if (op.type !== 'equal' && op.type !== 'aligned') continue;
      const referenceIndex =
        input.referenceEngineId === match.base.engineId ? op.baseIndex : op.candidateIndex;
      const targetIndex =
        input.referenceEngineId === match.base.engineId ? op.candidateIndex : op.baseIndex;
      const source = refsByMeasure.get(referenceIndex);
      const target = targetPart.measures[targetIndex];
      if (!source || !target) continue;
      derivedRefs.push({
        engine: targetEndpoint.engineId,
        artifactChecksumSha256: targetEndpoint.artifactChecksumSha256.toLowerCase(),
        stablePartKey: match.stablePartKey,
        documentPartId: targetEndpoint.documentPartId,
        measureIndex: target.measureIndex,
        measureNumber: target.measureNumber,
        cropRegions: source.cropRegions.map((crop) => ({
          ...crop,
          staffIndices: [...crop.staffIndices],
          region: [...crop.region]
        }))
      });
    }
  }

  if (refusalReasons.length > 0) return { status: 'refused', refusalReasons };
  const allowedReferenceKeys = new Set<string>();
  for (const match of matches) {
    const endpoint = endpointFor(match, input.referenceEngineId);
    if (!endpoint) continue;
    const part =
      input.referenceEngineId === match.base.engineId
        ? describedPart(input.baseParts, endpoint.documentPartId)
        : describedPart(input.candidateParts, endpoint.documentPartId);
    for (const measure of part?.measures || []) {
      allowedReferenceKeys.add(
        refKey({
          engine: endpoint.engineId,
          artifactChecksumSha256: endpoint.artifactChecksumSha256,
          stablePartKey: match.stablePartKey,
          documentPartId: endpoint.documentPartId,
          measureIndex: measure.measureIndex,
          cropRegions: []
        })
      );
    }
  }
  if (
    referenceGeometry.measureRefs.some(
      (ref) => ref.engine !== input.referenceEngineId || !allowedReferenceKeys.has(refKey(ref))
    )
  ) {
    return {
      status: 'refused',
      refusalReasons: [
        {
          code: 'reference-geometry-invalid',
          detail: 'Reference geometry contains measures outside the matched comparison document'
        }
      ]
    };
  }

  return {
    status: 'succeeded',
    geometry: {
      version: SCANNER_MEASURE_GEOMETRY_VERSION,
      producerId: SCANNER_ALIGNED_MEASURE_GEOMETRY_PRODUCER_ID,
      producerRevision: `${SCANNER_ALIGNED_MEASURE_GEOMETRY_PRODUCER_VERSION}+${SCANNER_MEASURE_ALIGNMENT_VERSION}`,
      sourceImage: { ...referenceGeometry.sourceImage },
      measureRefs: [...referenceGeometry.measureRefs, ...derivedRefs]
    }
  };
}
