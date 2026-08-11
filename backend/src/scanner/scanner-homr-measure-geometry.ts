import {
  SCANNER_MEASURE_GEOMETRY_VERSION,
  type ScannerMeasureGeometryManifest,
  type ScannerSourceImageIdentity
} from './scanner-comparison-geometry';
import type { ScannerDescribedPart } from './scanner-measure-analysis';
import { SCANNER_PART_MATCH_VERSION, type ScannerPartMatchResult } from './scanner-part-matching';
import type { ReviewStaff } from './scanner-review';
import type {
  ScannerEngineId,
  ScannerMeasureCropRegion,
  ScannerMeasureRef,
  ScannerPartMatch
} from './scanner-dual-engine';

export const SCANNER_HOMR_MEASURE_GEOMETRY_PRODUCER_ID = 'scanner-homr-measure-geometry';
export const SCANNER_HOMR_MEASURE_GEOMETRY_PRODUCER_VERSION = 'scanner-homr-measure-geometry-v1';

export type ScannerHomrGeometryRefusalCode =
  | 'part-match-unavailable'
  | 'artifact-identity-mismatch'
  | 'unsupported-part-layout'
  | 'invalid-staff-geometry'
  | 'measure-count-mismatch'
  | 'barline-count-mismatch';

export interface ScannerHomrGeometryRefusal {
  code: ScannerHomrGeometryRefusalCode;
  detail: string;
  documentPartId?: string;
  staffIndex?: number;
}

export type ScannerHomrMeasureGeometryResult =
  | { status: 'succeeded'; geometry: ScannerMeasureGeometryManifest }
  | { status: 'refused'; refusalReasons: ScannerHomrGeometryRefusal[] };

type MatchedPart = Extract<ScannerPartMatch, { outcome: 'matched' }>;

interface MeasureSystems {
  systems: Set<number>;
  hasContent: boolean;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function endpointFor(
  match: MatchedPart,
  engineId: ScannerEngineId
): MatchedPart['base'] | undefined {
  if (match.base.engineId === engineId) return match.base;
  if (match.candidate.engineId === engineId) return match.candidate;
  return undefined;
}

function closesMeasureAfter(rhythm: string): boolean {
  return rhythm.includes('barline') || rhythm === 'repeatEnd' || rhythm === 'repeatEndStart';
}

function addsMeasureContent(rhythm: string): boolean {
  return (
    rhythm.startsWith('note') ||
    rhythm.startsWith('rest') ||
    rhythm.startsWith('clef') ||
    rhythm.startsWith('keySignature') ||
    rhythm.startsWith('timeSignature') ||
    rhythm.startsWith('voltaStart') ||
    rhythm.startsWith('voltaStop') ||
    rhythm.startsWith('voltaDiscontinue')
  );
}

/** Mirror the pinned HOMR generator's measure/newline lifecycle. */
function mapMeasuresToSystems(staves: ReviewStaff[]): MeasureSystems[] {
  const nonEmpty = staves
    .map((staff, systemIndex) => ({ staff, systemIndex }))
    .filter(({ staff }) => Array.isArray(staff.tokens) && staff.tokens.length > 0);
  if (nonEmpty.length === 0) return [];

  const measures: MeasureSystems[] = [];
  // HOMR creates the first measure's attributes before consuming any token.
  let current: MeasureSystems = {
    systems: new Set([nonEmpty[0].systemIndex]),
    hasContent: true
  };
  const close = (): void => {
    measures.push(current);
    current = { systems: new Set(), hasContent: false };
  };

  for (let staffPosition = 0; staffPosition < nonEmpty.length; staffPosition += 1) {
    const { staff, systemIndex } = nonEmpty[staffPosition];
    for (const token of staff.tokens || []) {
      const rhythm = String(token?.[0] || '');
      if (rhythm === 'repeatStart') {
        current.systems.add(systemIndex);
        close();
        current.systems.add(systemIndex);
        current.hasContent = true;
        continue;
      }
      if (closesMeasureAfter(rhythm)) {
        current.systems.add(systemIndex);
        close();
        if (rhythm === 'repeatEndStart') {
          current.systems.add(systemIndex);
          current.hasContent = true;
        }
        continue;
      }
      if (addsMeasureContent(rhythm)) {
        current.systems.add(systemIndex);
        current.hasContent = true;
      }
    }

    // parse_staffs appends `newline` after every non-empty physical staff.
    // The generator writes a new-system print into the open measure except at
    // the end of the voice, so that measure begins/continues on the next staff.
    const next = nonEmpty[staffPosition + 1];
    if (next) {
      current.systems.add(next.systemIndex);
      current.hasContent = true;
    }
  }
  if (current.hasContent) measures.push(current);
  return measures;
}

function staffRegion(
  staff: ReviewStaff,
  sourceImage: ScannerSourceImageIdentity
): [number, number, number, number] | undefined {
  if (
    !Array.isArray(staff.region) ||
    staff.region.length !== 4 ||
    staff.region.some((coordinate) => !Number.isFinite(coordinate))
  ) {
    return undefined;
  }
  const [rawLeft, rawTop, rawRight, rawBottom] = staff.region;
  const left = Math.max(0, Math.floor(Math.min(rawLeft, rawRight)));
  const top = Math.max(0, Math.floor(Math.min(rawTop, rawBottom)));
  const right = Math.min(sourceImage.width, Math.ceil(Math.max(rawLeft, rawRight)));
  const bottom = Math.min(sourceImage.height, Math.ceil(Math.max(rawTop, rawBottom)));
  return right > left && bottom > top ? [left, top, right, bottom] : undefined;
}

function clusterBarLines(values: number[], tolerance: number): number[] {
  const clusters: number[][] = [];
  for (const value of [...values].sort((left, right) => left - right)) {
    const cluster = clusters[clusters.length - 1];
    if (!cluster || value - cluster[cluster.length - 1] > tolerance) clusters.push([value]);
    else cluster.push(value);
  }
  return clusters.map((cluster) =>
    Math.round(cluster.reduce((total, value) => total + value, 0) / cluster.length)
  );
}

function measureBoundaries(
  staff: ReviewStaff,
  measureCount: number,
  sourceImage: ScannerSourceImageIdentity
): [number, number, number, number][] | undefined {
  const region = staffRegion(staff, sourceImage);
  if (!region || measureCount <= 0) return undefined;
  const [left, top, right, bottom] = region;
  const width = right - left;
  const edgeTolerance = Math.max(12, Math.floor(width * 0.04));
  const mergeTolerance = Math.max(4, Math.floor(width * 0.008));
  const barLines = (staff.barLines || [])
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.round(value))
    .filter((value) => value > left + edgeTolerance && value < right - edgeTolerance);
  const boundaries = [left, ...clusterBarLines(barLines, mergeTolerance), right];
  if (boundaries.length !== measureCount + 1) return undefined;
  return boundaries
    .slice(0, -1)
    .map((boundary, index) => [boundary, top, boundaries[index + 1], bottom]);
}

function matchedPartFor(
  partMatchResult: ScannerPartMatchResult,
  engineId: ScannerEngineId,
  artifactChecksumSha256: string,
  documentPartId: string
): MatchedPart | undefined {
  return partMatchResult.matches.find((match): match is MatchedPart => {
    if (match.outcome !== 'matched') return false;
    const endpoint = endpointFor(match, engineId);
    return (
      endpoint?.artifactChecksumSha256.toLowerCase() === artifactChecksumSha256 &&
      endpoint.documentPartId === documentPartId
    );
  });
}

/**
 * Produce HOMR-side measure geometry only where its pinned voice-major staff
 * order, generated measure count, and detected physical boundaries all agree.
 * The source identity must describe the exact raster sent to HOMR.
 */
export function buildScannerHomrMeasureGeometry(input: {
  engineId: ScannerEngineId;
  artifactChecksumSha256: string;
  sourceImage: ScannerSourceImageIdentity;
  producerRevision: string;
  partMatchResult: ScannerPartMatchResult;
  parts: ScannerDescribedPart[];
  staves: ReviewStaff[];
}): ScannerHomrMeasureGeometryResult {
  const artifactChecksumSha256 = input.artifactChecksumSha256.toLowerCase();
  if (
    input.engineId !== 'homr' ||
    !SHA256_PATTERN.test(input.artifactChecksumSha256) ||
    !SHA256_PATTERN.test(input.sourceImage.checksumSha256) ||
    !Number.isInteger(input.sourceImage.width) ||
    input.sourceImage.width <= 0 ||
    !Number.isInteger(input.sourceImage.height) ||
    input.sourceImage.height <= 0 ||
    !/^[a-f0-9]{7,64}$/i.test(input.producerRevision)
  ) {
    return {
      status: 'refused',
      refusalReasons: [
        { code: 'artifact-identity-mismatch', detail: 'HOMR geometry identity is invalid' }
      ]
    };
  }
  if (
    input.partMatchResult.version !== SCANNER_PART_MATCH_VERSION ||
    !input.partMatchResult.comparisonAllowed ||
    input.partMatchResult.matches.length !== input.parts.length ||
    input.partMatchResult.matches.some((match) => match.outcome !== 'matched') ||
    (input.partMatchResult.pair.baseEngineId !== input.engineId &&
      input.partMatchResult.pair.candidateEngineId !== input.engineId)
  ) {
    return {
      status: 'refused',
      refusalReasons: [
        {
          code: 'part-match-unavailable',
          detail: 'All parts must have unique cross-engine matches before geometry is produced'
        }
      ]
    };
  }
  if (
    input.parts.length === 0 ||
    input.staves.length === 0 ||
    input.staves.length % input.parts.length !== 0 ||
    input.staves.some(
      (staff, index) =>
        staff.index !== index ||
        !Array.isArray(staff.tokens) ||
        staff.tokens.some(
          (row) =>
            !Array.isArray(row) ||
            row.length !== 6 ||
            row.some((field) => typeof field !== 'string')
        )
    )
  ) {
    return {
      status: 'refused',
      refusalReasons: [
        {
          code: 'unsupported-part-layout',
          detail: 'Captured HOMR staves do not form a complete voice-major system grid'
        }
      ]
    };
  }

  const systemsPerPart = input.staves.length / input.parts.length;
  const measureRefs: ScannerMeasureRef[] = [];
  const refusalReasons: ScannerHomrGeometryRefusal[] = [];
  for (let partIndex = 0; partIndex < input.parts.length; partIndex += 1) {
    const part = input.parts[partIndex];
    // This is the pinned HOMR generator's part-ID contract. Refuse output from
    // another serializer instead of applying HOMR's staff-order assumptions.
    if (part.documentPartId !== `P${partIndex + 1}`) {
      refusalReasons.push({
        code: 'unsupported-part-layout',
        detail: `Part ${part.documentPartId} does not follow the pinned HOMR part order`,
        documentPartId: part.documentPartId
      });
      continue;
    }
    const match = matchedPartFor(
      input.partMatchResult,
      input.engineId,
      artifactChecksumSha256,
      part.documentPartId
    );
    if (!match) {
      refusalReasons.push({
        code: 'artifact-identity-mismatch',
        detail: `Part ${part.documentPartId} is not matched to this HOMR artifact`,
        documentPartId: part.documentPartId
      });
      continue;
    }

    const partStaves = input.staves.slice(
      partIndex * systemsPerPart,
      (partIndex + 1) * systemsPerPart
    );
    const measures = mapMeasuresToSystems(partStaves);
    if (measures.length !== part.measures.length) {
      refusalReasons.push({
        code: 'measure-count-mismatch',
        detail: `HOMR token boundaries produced ${measures.length} measures for ${part.documentPartId}, but MusicXML contains ${part.measures.length}`,
        documentPartId: part.documentPartId
      });
      continue;
    }

    const cropsByMeasure = new Map<number, ScannerMeasureCropRegion[]>();
    for (let systemIndex = 0; systemIndex < partStaves.length; systemIndex += 1) {
      const measureIndices = measures.flatMap((measure, measureIndex) =>
        measure.systems.has(systemIndex) ? [measureIndex] : []
      );
      if (measureIndices.length === 0) continue;
      const boundaries = measureBoundaries(
        partStaves[systemIndex],
        measureIndices.length,
        input.sourceImage
      );
      if (!boundaries) {
        refusalReasons.push({
          code: 'barline-count-mismatch',
          detail: `Staff ${partStaves[systemIndex].index} boundaries do not prove ${measureIndices.length} measure crops`,
          documentPartId: part.documentPartId,
          staffIndex: partStaves[systemIndex].index
        });
        continue;
      }
      measureIndices.forEach((measureIndex, localIndex) => {
        const crops = cropsByMeasure.get(measureIndex) || [];
        crops.push({
          systemIndex,
          staffIndices: [partStaves[systemIndex].index],
          region: boundaries[localIndex]
        });
        cropsByMeasure.set(measureIndex, crops);
      });
    }
    if (refusalReasons.some((reason) => reason.documentPartId === part.documentPartId)) continue;

    const endpoint = endpointFor(match, input.engineId)!;
    for (const descriptor of part.measures) {
      const cropRegions = cropsByMeasure.get(descriptor.measureIndex);
      if (!cropRegions?.length) {
        refusalReasons.push({
          code: 'invalid-staff-geometry',
          detail: `No physical staff region covers ${part.documentPartId} measure ${descriptor.measureIndex}`,
          documentPartId: part.documentPartId
        });
        continue;
      }
      measureRefs.push({
        engine: input.engineId,
        artifactChecksumSha256: endpoint.artifactChecksumSha256.toLowerCase(),
        stablePartKey: match.stablePartKey,
        documentPartId: part.documentPartId,
        measureIndex: descriptor.measureIndex,
        measureNumber: descriptor.measureNumber,
        cropRegions
      });
    }
  }

  if (refusalReasons.length > 0) return { status: 'refused', refusalReasons };
  return {
    status: 'succeeded',
    geometry: {
      version: SCANNER_MEASURE_GEOMETRY_VERSION,
      producerId: SCANNER_HOMR_MEASURE_GEOMETRY_PRODUCER_ID,
      producerRevision: `${SCANNER_HOMR_MEASURE_GEOMETRY_PRODUCER_VERSION}:${input.producerRevision}`,
      sourceImage: {
        ...input.sourceImage,
        checksumSha256: input.sourceImage.checksumSha256.toLowerCase()
      },
      measureRefs
    }
  };
}
