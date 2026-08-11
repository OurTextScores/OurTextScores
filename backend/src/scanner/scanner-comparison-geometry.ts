import { createHash } from 'node:crypto';
import {
  isScannerEngineId,
  type ScannerComparisonPair,
  type ScannerMeasureCropRegion,
  type ScannerMeasureRef
} from './scanner-dual-engine';
import type {
  ScannerComparisonAnalysis,
  ScannerComparisonBlock,
  ScannerComparisonMeasureIdentity
} from './scanner-comparison-blocks';

export const SCANNER_MEASURE_GEOMETRY_VERSION = 'scanner-measure-geometry-v1';
export const SCANNER_COMPARISON_GEOMETRY_JOIN_VERSION = 'scanner-comparison-geometry-join-v1';
export const MAX_SCANNER_MEASURE_GEOMETRY_REFS = 262_144;
export const MAX_SCANNER_MEASURE_CROPS_PER_REF = 64;
export const MAX_SCANNER_MEASURE_CROP_STAVES = 256;

export interface ScannerSourceImageIdentity {
  checksumSha256: string;
  width: number;
  height: number;
}

/**
 * Page-coordinate geometry plus explicit engine-document measure joins.
 * `producerId` identifies the geometry stage, not an OMR engine: a neutral
 * layout stage may ground measures from several engines against one scan.
 */
export interface ScannerMeasureGeometryManifest {
  version: typeof SCANNER_MEASURE_GEOMETRY_VERSION;
  producerId: string;
  producerRevision: string;
  sourceImage: ScannerSourceImageIdentity;
  measureRefs: ScannerMeasureRef[];
}

export type ScannerGeometryRefusalCode =
  | 'structural-comparison-refused'
  | 'geometry-unavailable'
  | 'geometry-version-mismatch'
  | 'source-image-mismatch'
  | 'invalid-geometry-manifest'
  | 'ambiguous-measure-reference'
  | 'missing-measure-reference'
  | 'measure-reference-mismatch';

export interface ScannerGeometryRefusal {
  code: ScannerGeometryRefusalCode;
  detail: string;
  engineId?: string;
  documentPartId?: string;
  measureIndex?: number;
}

export interface ScannerGroundedComparisonBlock
  extends Omit<ScannerComparisonBlock, 'baseMeasureRefs' | 'candidateMeasureRefs'> {
  baseMeasureRefs: ScannerMeasureRef[];
  candidateMeasureRefs: ScannerMeasureRef[];
  /** De-duplicated page-coordinate evidence covering both sides of the block. */
  cropRegions: ScannerMeasureCropRegion[];
  geometrySignature: string;
}

export type ScannerComparisonBlockGeometryResult =
  | { status: 'ready'; block: ScannerGroundedComparisonBlock }
  | {
      status: 'refused';
      block: ScannerComparisonBlock;
      refusalReasons: ScannerGeometryRefusal[];
    };

export interface ScannerComparisonGeometryJoinResult {
  version: typeof SCANNER_COMPARISON_GEOMETRY_JOIN_VERSION;
  status: 'ready' | 'refused';
  pair: ScannerComparisonPair;
  sourceImage: ScannerSourceImageIdentity;
  geometryProducer?: { id: string; revision: string };
  geometrySignature?: string;
  blocks: ScannerComparisonBlockGeometryResult[];
  refusalReasons: ScannerGeometryRefusal[];
}

interface GeometryIndex {
  manifest: ScannerMeasureGeometryManifest;
  signature: string;
  refs: Map<string, ScannerMeasureRef>;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function canonicalSourceImage(sourceImage: ScannerSourceImageIdentity): ScannerSourceImageIdentity {
  if (
    !SHA256_PATTERN.test(sourceImage.checksumSha256) ||
    !Number.isInteger(sourceImage.width) ||
    sourceImage.width <= 0 ||
    !Number.isInteger(sourceImage.height) ||
    sourceImage.height <= 0
  ) {
    throw new Error('Invalid scanner source-image identity');
  }
  return {
    checksumSha256: sourceImage.checksumSha256.toLowerCase(),
    width: sourceImage.width,
    height: sourceImage.height
  };
}

function measureIdentityKey(
  identity: Pick<
    ScannerComparisonMeasureIdentity,
    'engine' | 'artifactChecksumSha256' | 'stablePartKey' | 'documentPartId' | 'measureIndex'
  >
): string {
  return JSON.stringify([
    identity.engine,
    identity.artifactChecksumSha256.toLowerCase(),
    identity.stablePartKey,
    identity.documentPartId,
    identity.measureIndex
  ]);
}

function validLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function canonicalCropRegion(
  crop: ScannerMeasureCropRegion,
  image: ScannerSourceImageIdentity
): ScannerMeasureCropRegion | undefined {
  if (
    !Number.isInteger(crop?.systemIndex) ||
    crop.systemIndex < 0 ||
    !Array.isArray(crop.staffIndices) ||
    crop.staffIndices.length === 0 ||
    crop.staffIndices.length > MAX_SCANNER_MEASURE_CROP_STAVES ||
    crop.staffIndices.some((index) => !Number.isInteger(index) || index < 0) ||
    new Set(crop.staffIndices).size !== crop.staffIndices.length ||
    !Array.isArray(crop.region) ||
    crop.region.length !== 4 ||
    crop.region.some((coordinate) => !Number.isInteger(coordinate))
  ) {
    return undefined;
  }
  const [left, top, right, bottom] = crop.region;
  if (
    left < 0 ||
    top < 0 ||
    right <= left ||
    bottom <= top ||
    right > image.width ||
    bottom > image.height
  ) {
    return undefined;
  }
  return {
    systemIndex: crop.systemIndex,
    staffIndices: [...crop.staffIndices].sort((leftIndex, rightIndex) => leftIndex - rightIndex),
    region: [left, top, right, bottom]
  };
}

function canonicalMeasureRef(
  ref: ScannerMeasureRef,
  image: ScannerSourceImageIdentity
): ScannerMeasureRef | undefined {
  if (
    !isScannerEngineId(ref?.engine) ||
    !SHA256_PATTERN.test(ref.artifactChecksumSha256) ||
    !validLabel(ref.stablePartKey) ||
    !validLabel(ref.documentPartId) ||
    !Number.isInteger(ref.measureIndex) ||
    ref.measureIndex < 0 ||
    (ref.measureNumber !== undefined &&
      (typeof ref.measureNumber !== 'string' || ref.measureNumber.length > 80)) ||
    !Array.isArray(ref.cropRegions) ||
    ref.cropRegions.length === 0 ||
    ref.cropRegions.length > MAX_SCANNER_MEASURE_CROPS_PER_REF
  ) {
    return undefined;
  }
  const cropRegions = ref.cropRegions.map((crop) => canonicalCropRegion(crop, image));
  if (cropRegions.some((crop) => !crop)) return undefined;
  const uniqueCrops = new Map<string, ScannerMeasureCropRegion>();
  for (const crop of cropRegions as ScannerMeasureCropRegion[]) {
    uniqueCrops.set(JSON.stringify(crop), crop);
  }
  return {
    engine: ref.engine,
    artifactChecksumSha256: ref.artifactChecksumSha256.toLowerCase(),
    stablePartKey: ref.stablePartKey,
    documentPartId: ref.documentPartId,
    measureIndex: ref.measureIndex,
    measureNumber: ref.measureNumber,
    cropRegions: [...uniqueCrops.values()].sort(compareCropRegions)
  };
}

function compareCropRegions(
  left: ScannerMeasureCropRegion,
  right: ScannerMeasureCropRegion
): number {
  return (
    left.systemIndex - right.systemIndex ||
    left.region[1] - right.region[1] ||
    left.region[0] - right.region[0] ||
    JSON.stringify(left.staffIndices).localeCompare(JSON.stringify(right.staffIndices))
  );
}

function geometrySignature(manifest: ScannerMeasureGeometryManifest): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        SCANNER_MEASURE_GEOMETRY_VERSION,
        manifest.producerId,
        manifest.producerRevision,
        manifest.sourceImage,
        manifest.measureRefs
      ])
    )
    .digest('hex');
  return `${SCANNER_MEASURE_GEOMETRY_VERSION}:${digest}`;
}

function indexGeometry(
  geometry: ScannerMeasureGeometryManifest,
  expectedSourceImage: ScannerSourceImageIdentity
): GeometryIndex | ScannerGeometryRefusal {
  if (geometry.version !== SCANNER_MEASURE_GEOMETRY_VERSION) {
    return {
      code: 'geometry-version-mismatch',
      detail: `Expected ${SCANNER_MEASURE_GEOMETRY_VERSION}, received ${String(geometry.version)}`
    };
  }
  if (!validLabel(geometry.producerId) || !validLabel(geometry.producerRevision)) {
    return {
      code: 'invalid-geometry-manifest',
      detail: 'Geometry producer identity is missing or invalid'
    };
  }

  let sourceImage: ScannerSourceImageIdentity;
  try {
    sourceImage = canonicalSourceImage(geometry.sourceImage);
  } catch {
    return {
      code: 'invalid-geometry-manifest',
      detail: 'Geometry source-image identity is invalid'
    };
  }
  if (
    sourceImage.checksumSha256 !== expectedSourceImage.checksumSha256 ||
    sourceImage.width !== expectedSourceImage.width ||
    sourceImage.height !== expectedSourceImage.height
  ) {
    return {
      code: 'source-image-mismatch',
      detail: 'Geometry was produced for a different source-image revision or size'
    };
  }
  if (
    !Array.isArray(geometry.measureRefs) ||
    geometry.measureRefs.length > MAX_SCANNER_MEASURE_GEOMETRY_REFS
  ) {
    return {
      code: 'invalid-geometry-manifest',
      detail: 'Geometry measure references are invalid'
    };
  }

  const refs = new Map<string, ScannerMeasureRef>();
  for (const rawRef of geometry.measureRefs) {
    const ref = canonicalMeasureRef(rawRef, sourceImage);
    if (!ref) {
      return {
        code: 'invalid-geometry-manifest',
        detail: 'Geometry contains an invalid or out-of-bounds measure reference'
      };
    }
    const key = measureIdentityKey(ref);
    if (refs.has(key)) {
      return {
        code: 'ambiguous-measure-reference',
        detail: `Geometry contains more than one reference for ${ref.engine} ${ref.documentPartId} measure ${ref.measureIndex}`,
        engineId: ref.engine,
        documentPartId: ref.documentPartId,
        measureIndex: ref.measureIndex
      };
    }
    refs.set(key, ref);
  }

  const manifest: ScannerMeasureGeometryManifest = {
    version: SCANNER_MEASURE_GEOMETRY_VERSION,
    producerId: geometry.producerId,
    producerRevision: geometry.producerRevision,
    sourceImage,
    measureRefs: [...refs.values()].sort((left, right) =>
      measureIdentityKey(left).localeCompare(measureIdentityKey(right))
    )
  };
  return { manifest, refs, signature: geometrySignature(manifest) };
}

function resolveMeasure(
  identity: ScannerComparisonMeasureIdentity,
  index: GeometryIndex
): ScannerMeasureRef | ScannerGeometryRefusal {
  const ref = index.refs.get(measureIdentityKey(identity));
  if (!ref) {
    return {
      code: 'missing-measure-reference',
      detail: `No verified crop maps ${identity.engine} ${identity.documentPartId} measure ${identity.measureIndex}`,
      engineId: identity.engine,
      documentPartId: identity.documentPartId,
      measureIndex: identity.measureIndex
    };
  }
  if (ref.measureNumber !== identity.measureNumber) {
    return {
      code: 'measure-reference-mismatch',
      detail: `Geometry measure number does not match ${identity.engine} ${identity.documentPartId} measure ${identity.measureIndex}`,
      engineId: identity.engine,
      documentPartId: identity.documentPartId,
      measureIndex: identity.measureIndex
    };
  }
  return ref;
}

function uniqueCropRegions(refs: ScannerMeasureRef[]): ScannerMeasureCropRegion[] {
  const crops = new Map<string, ScannerMeasureCropRegion>();
  for (const ref of refs) {
    for (const crop of ref.cropRegions) {
      crops.set(JSON.stringify(crop), crop);
    }
  }
  return [...crops.values()].sort(compareCropRegions);
}

/**
 * Upgrade structural comparison blocks to source-image-backed evidence.
 * Structural results remain available on refusal, but callers must require the
 * top-level `ready` status before exposing any reviewer decision controls.
 */
export function joinScannerComparisonGeometry(input: {
  analysis: ScannerComparisonAnalysis;
  sourceImage: ScannerSourceImageIdentity;
  geometry?: ScannerMeasureGeometryManifest;
}): ScannerComparisonGeometryJoinResult {
  const sourceImage = canonicalSourceImage(input.sourceImage);
  if (input.analysis.status === 'refused') {
    const refusalReasons = input.analysis.refusalReasons.map((detail) => ({
      code: 'structural-comparison-refused' as const,
      detail
    }));
    return {
      version: SCANNER_COMPARISON_GEOMETRY_JOIN_VERSION,
      status: 'refused',
      pair: input.analysis.pair,
      sourceImage,
      blocks: [],
      refusalReasons
    };
  }

  if (input.analysis.blocks.length === 0) {
    return {
      version: SCANNER_COMPARISON_GEOMETRY_JOIN_VERSION,
      status: 'ready',
      pair: input.analysis.pair,
      sourceImage,
      blocks: [],
      refusalReasons: []
    };
  }
  if (!input.geometry) {
    const refusal: ScannerGeometryRefusal = {
      code: 'geometry-unavailable',
      detail: 'No verified measure-to-image geometry is available for this page'
    };
    return {
      version: SCANNER_COMPARISON_GEOMETRY_JOIN_VERSION,
      status: 'refused',
      pair: input.analysis.pair,
      sourceImage,
      blocks: input.analysis.blocks.map((block) => ({
        status: 'refused',
        block,
        refusalReasons: [refusal]
      })),
      refusalReasons: [refusal]
    };
  }

  const indexed = indexGeometry(input.geometry, sourceImage);
  if ('code' in indexed) {
    return {
      version: SCANNER_COMPARISON_GEOMETRY_JOIN_VERSION,
      status: 'refused',
      pair: input.analysis.pair,
      sourceImage,
      blocks: input.analysis.blocks.map((block) => ({
        status: 'refused',
        block,
        refusalReasons: [indexed]
      })),
      refusalReasons: [indexed]
    };
  }

  const blocks: ScannerComparisonBlockGeometryResult[] = input.analysis.blocks.map((block) => {
    const base = block.baseMeasureRefs.map((identity) => resolveMeasure(identity, indexed));
    const candidate = block.candidateMeasureRefs.map((identity) =>
      resolveMeasure(identity, indexed)
    );
    const refusalReasons = [...base, ...candidate].filter(
      (value): value is ScannerGeometryRefusal => 'code' in value
    );
    if (refusalReasons.length > 0) {
      return { status: 'refused', block, refusalReasons };
    }
    const baseMeasureRefs = base as ScannerMeasureRef[];
    const candidateMeasureRefs = candidate as ScannerMeasureRef[];
    return {
      status: 'ready',
      block: {
        ...block,
        baseMeasureRefs,
        candidateMeasureRefs,
        cropRegions: uniqueCropRegions([...baseMeasureRefs, ...candidateMeasureRefs]),
        geometrySignature: indexed.signature
      }
    };
  });
  const refusalReasons = blocks.flatMap((result) =>
    result.status === 'refused' ? result.refusalReasons : []
  );
  return {
    version: SCANNER_COMPARISON_GEOMETRY_JOIN_VERSION,
    status: refusalReasons.length > 0 ? 'refused' : 'ready',
    pair: input.analysis.pair,
    sourceImage,
    geometryProducer: {
      id: indexed.manifest.producerId,
      revision: indexed.manifest.producerRevision
    },
    geometrySignature: indexed.signature,
    blocks,
    refusalReasons
  };
}
