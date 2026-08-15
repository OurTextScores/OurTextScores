import { buildScannerAlignedMeasureGeometry } from './scanner-aligned-measure-geometry';
import {
  buildScannerComparisonAnalysis,
  type ScannerComparisonAnalysis
} from './scanner-comparison-blocks';
import {
  joinScannerComparisonGeometry,
  type ScannerComparisonGeometryJoinResult
} from './scanner-comparison-geometry';
import type {
  ScannerMeasureGeometryProducerInput,
  ScannerMeasureGeometryProducerResult
} from './scanner-engine.registry';
import {
  describeScannerMusicXmlMeasures,
  type ScannerDescribedPart
} from './scanner-measure-analysis';
import { matchScannerMusicXmlParts } from './scanner-part-matching';
import { reconcileScannerPartLayout, type ScannerPartLayoutRefusal } from './scanner-part-layout';
import type {
  ScannerComparisonPair,
  ScannerEngineId,
  ScannerOutputCompleteness
} from './scanner-dual-engine';
import type { ScannerPageResult, ScannerRasterIdentity } from './schemas/scanner-job.schema';

export const SCANNER_PAGE_COMPARISON_VERSION = 'scanner-page-comparison-v1';

export type ScannerPageComparisonRefusalStage = 'prerequisites' | 'analysis' | 'geometry';

export interface ScannerPageComparisonRefusal {
  stage: ScannerPageComparisonRefusalStage;
  code: string;
  detail: string;
  engineId?: ScannerEngineId;
}

export interface ScannerPageComparisonSideInput {
  engineId: ScannerEngineId;
  displayName: string;
  artifactChecksumSha256: string;
  musicXml: Buffer;
  recognitionRaster: ScannerRasterIdentity;
  modelRevision?: string;
  completeness?: ScannerOutputCompleteness;
  unsupportedSemanticClasses: string[];
  review?: ScannerPageResult['review'];
  artifacts: ScannerMeasureGeometryProducerInput['artifacts'];
  loadArtifact: ScannerMeasureGeometryProducerInput['loadArtifact'];
  loadRecognitionRaster: ScannerMeasureGeometryProducerInput['loadRecognitionRaster'];
  measureGeometryProducer?: (
    input: ScannerMeasureGeometryProducerInput
  ) => ScannerMeasureGeometryProducerResult | Promise<ScannerMeasureGeometryProducerResult>;
}

export interface ScannerPageComparisonSide {
  engineId: ScannerEngineId;
  displayName: string;
  artifactChecksumSha256: string;
  completeness?: ScannerOutputCompleteness;
  unsupportedSemanticClasses: string[];
}

export interface ScannerPageComparisonResult {
  version: typeof SCANNER_PAGE_COMPARISON_VERSION;
  status: 'ready' | 'refused';
  pair: ScannerComparisonPair;
  base: ScannerPageComparisonSide;
  candidate: ScannerPageComparisonSide;
  sourceImage?: ScannerRasterIdentity;
  analysis?: ScannerComparisonAnalysis;
  geometry?: ScannerComparisonGeometryJoinResult;
  /** The scan's own systems, for a view that goes line by line (§2.1). */
  systems?: ScannerComparisonSystem[];
  /**
   * What had to be reshaped before the two readings could be lined up at all.
   *
   * Present when one engine wrote a keyboard part as one braced pair of staves
   * and the other wrote it as two parts. The reader is told, because the
   * candidate they are looking at is then not literally the file the engine
   * produced — the same notes, regrouped.
   */
  layoutReconciliation?: {
    engineId: ScannerEngineId;
    note: string;
    contentChecksumSha256: string;
  };
  refusalReasons: ScannerPageComparisonRefusal[];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function validRaster(value: ScannerRasterIdentity): boolean {
  return (
    typeof value?.checksumSha256 === 'string' &&
    SHA256_PATTERN.test(value.checksumSha256) &&
    Number.isInteger(value.width) &&
    value.width > 0 &&
    Number.isInteger(value.height) &&
    value.height > 0
  );
}

function sameRaster(left: ScannerRasterIdentity, right: ScannerRasterIdentity): boolean {
  return (
    left.checksumSha256.toLowerCase() === right.checksumSha256.toLowerCase() &&
    left.width === right.width &&
    left.height === right.height
  );
}

function presentSide(side: ScannerPageComparisonSideInput): ScannerPageComparisonSide {
  return {
    engineId: side.engineId,
    displayName: side.displayName,
    artifactChecksumSha256: side.artifactChecksumSha256.toLowerCase(),
    completeness: side.completeness,
    unsupportedSemanticClasses: [...side.unsupportedSemanticClasses]
  };
}

function refused(
  pair: ScannerComparisonPair,
  base: ScannerPageComparisonSideInput,
  candidate: ScannerPageComparisonSideInput,
  refusalReasons: ScannerPageComparisonRefusal[],
  options: {
    sourceImage?: ScannerRasterIdentity;
    analysis?: ScannerComparisonAnalysis;
    geometry?: ScannerComparisonGeometryJoinResult;
    systems?: ScannerComparisonSystem[];
    layoutReconciliation?: ScannerPageComparisonResult['layoutReconciliation'];
  } = {}
): ScannerPageComparisonResult {
  return {
    version: SCANNER_PAGE_COMPARISON_VERSION,
    status: 'refused',
    pair,
    base: presentSide(base),
    candidate: presentSide(candidate),
    ...options,
    refusalReasons
  };
}

function geometryInput(
  side: ScannerPageComparisonSideInput,
  sourceImage: ScannerRasterIdentity,
  partMatchResult: ReturnType<typeof matchScannerMusicXmlParts>,
  parts: ScannerDescribedPart[]
): ScannerMeasureGeometryProducerInput {
  return {
    artifactChecksumSha256: side.artifactChecksumSha256,
    sourceImage,
    producerRevision: side.modelRevision || '',
    partMatchResult,
    parts,
    review: side.review,
    artifacts: side.artifacts,
    loadArtifact: side.loadArtifact,
    loadRecognitionRaster: side.loadRecognitionRaster
  };
}

export interface ScannerComparisonSystem {
  systemIndex: number;
  /** Source-page pixel bounds covering every staff of this system. */
  region: [number, number, number, number];
  baseMeasureIndexes: number[];
  candidateMeasureIndexes: number[];
  /** The same system localized to each matched part for the by-staff reviewer. */
  staffRows: Array<{
    stablePartKey: string;
    staffIndices: number[];
    region: [number, number, number, number];
    baseMeasureIndexes: number[];
    candidateMeasureIndexes: number[];
  }>;
}

/**
 * The page's systems as the *scan* has them, with each engine's measures.
 *
 * A row-per-system view cannot take its lines from either engine — they break
 * systems differently, and the question being asked is what the scanned page
 * says. The geometry manifest already answers it: every measure reference
 * carries the physical system its crop came from, for both engines once aligned
 * geometry has copied the reference side's crops across.
 */
export function scannerComparisonSystems(
  geometry: { measureRefs: Array<Record<string, any>> } | undefined,
  pair: ScannerComparisonPair
): ScannerComparisonSystem[] {
  const bySystem = new Map<number, ScannerComparisonSystem>();
  for (const ref of geometry?.measureRefs || []) {
    for (const crop of ref.cropRegions || []) {
      const systemIndex = Number(crop.systemIndex);
      if (!Number.isInteger(systemIndex)) continue;
      const entry = bySystem.get(systemIndex) || {
        systemIndex,
        region: [...crop.region] as [number, number, number, number],
        baseMeasureIndexes: [],
        candidateMeasureIndexes: [],
        staffRows: []
      };
      // A system spans every staff that shares it, so the row's crop is the
      // union rather than any one measure's box.
      entry.region = [
        Math.min(entry.region[0], crop.region[0]),
        Math.min(entry.region[1], crop.region[1]),
        Math.max(entry.region[2], crop.region[2]),
        Math.max(entry.region[3], crop.region[3])
      ];
      const side =
        ref.engine === pair.baseEngineId
          ? entry.baseMeasureIndexes
          : ref.engine === pair.candidateEngineId
            ? entry.candidateMeasureIndexes
            : undefined;
      if (side && !side.includes(ref.measureIndex)) side.push(ref.measureIndex);
      const staffRow = entry.staffRows.find(
        (candidate) => candidate.stablePartKey === ref.stablePartKey
      ) || {
        stablePartKey: ref.stablePartKey,
        staffIndices: [],
        region: [...crop.region] as [number, number, number, number],
        baseMeasureIndexes: [],
        candidateMeasureIndexes: []
      };
      staffRow.region = [
        Math.min(staffRow.region[0], crop.region[0]),
        Math.min(staffRow.region[1], crop.region[1]),
        Math.max(staffRow.region[2], crop.region[2]),
        Math.max(staffRow.region[3], crop.region[3])
      ];
      for (const staffIndex of crop.staffIndices || []) {
        if (!staffRow.staffIndices.includes(staffIndex)) staffRow.staffIndices.push(staffIndex);
      }
      const staffSide =
        ref.engine === pair.baseEngineId
          ? staffRow.baseMeasureIndexes
          : ref.engine === pair.candidateEngineId
            ? staffRow.candidateMeasureIndexes
            : undefined;
      if (staffSide && !staffSide.includes(ref.measureIndex)) staffSide.push(ref.measureIndex);
      if (!entry.staffRows.includes(staffRow)) entry.staffRows.push(staffRow);
      bySystem.set(systemIndex, entry);
    }
  }
  return [...bySystem.values()]
    .sort((left, right) => left.systemIndex - right.systemIndex)
    .map((entry) => ({
      ...entry,
      baseMeasureIndexes: [...entry.baseMeasureIndexes].sort((a, b) => a - b),
      candidateMeasureIndexes: [...entry.candidateMeasureIndexes].sort((a, b) => a - b),
      staffRows: entry.staffRows
        .map((row) => ({
          ...row,
          staffIndices: [...row.staffIndices].sort((a, b) => a - b),
          baseMeasureIndexes: [...row.baseMeasureIndexes].sort((a, b) => a - b),
          candidateMeasureIndexes: [...row.candidateMeasureIndexes].sort((a, b) => a - b)
        }))
        .sort((left, right) => Math.min(...left.staffIndices) - Math.min(...right.staffIndices))
    }));
}

/**
 * Refusal details are returned to the client, so an unexpected throw must not
 * carry a dependency's internal message out with it. The stage-coded reason
 * stays fixed and the underlying error goes to the caller's log instead.
 */
function unexpectedFailureDetail(
  error: unknown,
  stage: ScannerPageComparisonRefusalStage,
  code: string,
  report?: (context: string, error: unknown) => void
): string {
  report?.(`${stage}:${code}`, error);
  return 'The comparison could not be completed for this page';
}

/** Run the complete bounded, read-only comparison pipeline for one ordered pair. */
export async function compareScannerPage(input: {
  sourceImage: ScannerRasterIdentity;
  base: ScannerPageComparisonSideInput;
  candidate: ScannerPageComparisonSideInput;
  /** Records an unexpected internal failure without exposing it to the client. */
  reportInternalError?: (context: string, error: unknown) => void;
}): Promise<ScannerPageComparisonResult> {
  const { base, candidate, sourceImage } = input;
  const pair: ScannerComparisonPair = {
    baseEngineId: base.engineId,
    candidateEngineId: candidate.engineId
  };
  if (
    base.engineId === candidate.engineId ||
    !validRaster(base.recognitionRaster) ||
    !validRaster(candidate.recognitionRaster) ||
    !validRaster(sourceImage) ||
    !sameRaster(base.recognitionRaster, candidate.recognitionRaster) ||
    !sameRaster(base.recognitionRaster, sourceImage)
  ) {
    return refused(pair, base, candidate, [
      {
        stage: 'prerequisites',
        code: 'recognition-raster-mismatch',
        detail: 'Both engine runs and the retained page must use the same recognition raster'
      }
    ]);
  }

  let partMatchResult: ReturnType<typeof matchScannerMusicXmlParts>;
  let baseParts: ScannerDescribedPart[];
  let candidateParts: ScannerDescribedPart[];
  let analysis: ScannerComparisonAnalysis;
  // Two readings of the same keyboard page can differ about how many parts it
  // has without differing about the music. Nothing downstream can align a
  // two-staff part with a one-staff part, so the shapes are settled here,
  // before anything looks at the notes.
  let layout: ReturnType<typeof reconcileScannerPartLayout>;
  let layoutRefusals: ScannerPartLayoutRefusal[] = [];
  try {
    layout = reconcileScannerPartLayout({
      baseXml: base.musicXml,
      candidateXml: candidate.musicXml
    });
    layoutRefusals = layout.refusals;
  } catch (error) {
    return refused(pair, base, candidate, [
      {
        stage: 'analysis',
        code: 'part-layout-reconciliation-failed',
        detail: unexpectedFailureDetail(
          error,
          'analysis',
          'part-layout-reconciliation-failed',
          input.reportInternalError
        )
      }
    ]);
  }
  const candidateXml = layout.musicXml;
  try {
    partMatchResult = matchScannerMusicXmlParts(
      {
        engineId: base.engineId,
        artifactChecksumSha256: base.artifactChecksumSha256,
        musicXml: base.musicXml
      },
      {
        engineId: candidate.engineId,
        artifactChecksumSha256: candidate.artifactChecksumSha256,
        musicXml: candidateXml,
        contentChecksumSha256: layout.applied ? layout.contentChecksumSha256 : undefined
      }
    );
    baseParts = describeScannerMusicXmlMeasures(base.musicXml);
    candidateParts = describeScannerMusicXmlMeasures(candidateXml);
    analysis = buildScannerComparisonAnalysis({
      partMatchResult,
      base: {
        engineId: base.engineId,
        artifactChecksumSha256: base.artifactChecksumSha256,
        parts: baseParts,
        completeness: base.completeness,
        unsupportedSemanticClasses: base.unsupportedSemanticClasses
      },
      candidate: {
        engineId: candidate.engineId,
        artifactChecksumSha256: candidate.artifactChecksumSha256,
        parts: candidateParts,
        completeness: candidate.completeness,
        unsupportedSemanticClasses: candidate.unsupportedSemanticClasses
      }
    });
  } catch (error) {
    return refused(pair, base, candidate, [
      {
        stage: 'analysis',
        code: 'comparison-analysis-failed',
        detail: unexpectedFailureDetail(
          error,
          'analysis',
          'comparison-analysis-failed',
          input.reportInternalError
        )
      }
    ]);
  }

  if (analysis.status === 'refused') {
    return refused(
      pair,
      base,
      candidate,
      [
        ...layoutRefusals.map((refusal) => ({
          stage: 'analysis' as const,
          code: `part-layout-${refusal.code}`,
          detail: refusal.detail,
          engineId: candidate.engineId
        })),
        ...analysis.refusalReasons.map((detail) => ({
          stage: 'analysis' as const,
          code: 'structural-comparison-refused',
          detail
        }))
      ],
      { sourceImage, analysis }
    );
  }

  if (analysis.blocks.length === 0) {
    const geometry = joinScannerComparisonGeometry({ analysis, sourceImage });
    return {
      version: SCANNER_PAGE_COMPARISON_VERSION,
      status: 'ready',
      pair,
      base: presentSide(base),
      candidate: presentSide(candidate),
      sourceImage,
      analysis,
      geometry,
      ...(layout.applied
        ? {
            layoutReconciliation: {
              engineId: candidate.engineId,
              note: layout.note!,
              contentChecksumSha256: layout.contentChecksumSha256
            }
          }
        : {}),
      refusalReasons: []
    };
  }

  const layoutReconciliation = layout.applied
    ? {
        engineId: candidate.engineId,
        note: layout.note!,
        contentChecksumSha256: layout.contentChecksumSha256
      }
    : undefined;
  const producerAttempts: ScannerPageComparisonRefusal[] = [];
  let lastGeometry: ScannerComparisonGeometryJoinResult | undefined;
  // Kept even when the join refuses: a row-per-system view needs the scan's
  // lines, and those are known whether or not every block could be grounded.
  let lastSystems: ScannerComparisonSystem[] | undefined;
  for (const side of [base, candidate]) {
    if (!side.measureGeometryProducer) continue;
    // A producer works from the stored artifact, whose parts are the ones this
    // comparison just regrouped. Its measure references would name a document
    // nothing else here is using, so the reshaped side contributes no geometry.
    if (layout.applied && side.engineId === candidate.engineId) {
      producerAttempts.push({
        stage: 'geometry',
        code: 'part-layout-reconciled',
        detail:
          'This reading was regrouped onto the other reading’s staves, so its own page geometry no longer describes it',
        engineId: side.engineId
      });
      continue;
    }
    const parts = side.engineId === base.engineId ? baseParts : candidateParts;
    let produced: ScannerMeasureGeometryProducerResult;
    try {
      produced = await side.measureGeometryProducer(
        geometryInput(side, sourceImage, partMatchResult, parts)
      );
    } catch (error) {
      producerAttempts.push({
        stage: 'geometry',
        code: 'geometry-producer-failed',
        detail: unexpectedFailureDetail(
          error,
          'geometry',
          'geometry-producer-failed',
          input.reportInternalError
        ),
        engineId: side.engineId
      });
      continue;
    }
    if (produced.status === 'refused') {
      producerAttempts.push(
        ...produced.refusalReasons.map((reason) => ({
          stage: 'geometry' as const,
          code: reason.code,
          detail: reason.detail,
          engineId: side.engineId
        }))
      );
      continue;
    }
    const aligned = buildScannerAlignedMeasureGeometry({
      referenceEngineId: side.engineId,
      referenceGeometry: produced.geometry,
      baseRecognitionRaster: base.recognitionRaster,
      candidateRecognitionRaster: candidate.recognitionRaster,
      partMatchResult,
      baseParts,
      candidateParts
    });
    if (aligned.status === 'refused') {
      producerAttempts.push(
        ...aligned.refusalReasons.map((reason) => ({
          stage: 'geometry' as const,
          code: reason.code,
          detail: reason.detail,
          engineId: side.engineId
        }))
      );
      continue;
    }
    const geometry = joinScannerComparisonGeometry({
      analysis,
      geometry: aligned.geometry,
      sourceImage
    });
    lastGeometry = geometry;
    lastSystems = scannerComparisonSystems(aligned.geometry, pair);
    if (geometry.status === 'ready') {
      return {
        version: SCANNER_PAGE_COMPARISON_VERSION,
        status: 'ready',
        pair,
        systems: lastSystems,
        base: presentSide(base),
        candidate: presentSide(candidate),
        sourceImage,
        analysis,
        geometry,
        ...(layoutReconciliation ? { layoutReconciliation } : {}),
        refusalReasons: []
      };
    }
    producerAttempts.push(
      ...geometry.refusalReasons.map((reason) => ({
        stage: 'geometry' as const,
        code: reason.code,
        detail: reason.detail,
        engineId: side.engineId
      }))
    );
  }

  const geometry = lastGeometry || joinScannerComparisonGeometry({ analysis, sourceImage });
  return refused(
    pair,
    base,
    candidate,
    producerAttempts.length > 0
      ? producerAttempts
      : [
          {
            stage: 'geometry',
            code: 'geometry-producer-unavailable',
            detail: 'Neither selected engine has a registered measure-geometry producer'
          }
        ],
    { sourceImage, analysis, geometry, systems: lastSystems, layoutReconciliation }
  );
}
