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
        musicXml: candidate.musicXml
      }
    );
    baseParts = describeScannerMusicXmlMeasures(base.musicXml);
    candidateParts = describeScannerMusicXmlMeasures(candidate.musicXml);
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
      analysis.refusalReasons.map((detail) => ({
        stage: 'analysis',
        code: 'structural-comparison-refused',
        detail
      })),
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
      refusalReasons: []
    };
  }

  const producerAttempts: ScannerPageComparisonRefusal[] = [];
  let lastGeometry: ScannerComparisonGeometryJoinResult | undefined;
  for (const side of [base, candidate]) {
    if (!side.measureGeometryProducer) continue;
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
    if (geometry.status === 'ready') {
      return {
        version: SCANNER_PAGE_COMPARISON_VERSION,
        status: 'ready',
        pair,
        base: presentSide(base),
        candidate: presentSide(candidate),
        sourceImage,
        analysis,
        geometry,
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
    { sourceImage, analysis, geometry }
  );
}
