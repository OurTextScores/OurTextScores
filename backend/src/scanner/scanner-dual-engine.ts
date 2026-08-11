import { createHash } from 'node:crypto';
import type {
  ScannerEngineProvenance,
  ScannerPageResult,
  ScannerStorageLocator
} from './schemas/scanner-job.schema';

export const BUILTIN_SCANNER_ENGINE_IDS = ['homr', 'transcoda'] as const;
/** @deprecated Use BUILTIN_SCANNER_ENGINE_IDS for built-ins or ScannerEngineId for contracts. */
export const SCANNER_ENGINES = BUILTIN_SCANNER_ENGINE_IDS;
export type ScannerEngineId = string;
/** @deprecated Compatibility alias while the Phase C registry migration lands. */
export type ScannerEngineName = ScannerEngineId;

export const SCANNER_ENGINE_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export function isScannerEngineId(value: unknown): value is ScannerEngineId {
  return typeof value === 'string' && SCANNER_ENGINE_ID_PATTERN.test(value);
}

export type ScannerEngineRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface ScannerGenerationMetadata {
  hitMaxLength: boolean;
  sawEos: boolean;
  truncated: boolean;
  maxLength?: number;
  strategy?: string;
  numBeams?: number;
  repetitionPenalty?: number;
}

export type ScannerOutputCompleteness =
  | 'complete'
  | 'possibly-incomplete'
  | 'incomplete'
  | 'unknown';

export interface ScannerEngineArtifacts {
  musicXml?: ScannerStorageLocator;
  pdf?: ScannerStorageLocator;
  /** A provider-native artifact; retained as an explicit compatibility field. */
  kern?: ScannerStorageLocator;
  [kind: string]: ScannerStorageLocator | undefined;
}

/** Independent state for one engine; page status is derived from both records. */
export interface ScannerEngineRun {
  engine: ScannerEngineId;
  status: ScannerEngineRunStatus;
  attempts: number;
  providerAttempts?: number;
  idempotencyKey: string;
  providerRequestId?: string;
  durationMs?: number;
  inferenceMs?: number;
  generation?: ScannerGenerationMetadata;
  errorCode?: string;
  errorMessage?: string;
  providerRevision?: string;
  modelRevision?: string;
  provenance?: ScannerEngineProvenance;
  completeness?: ScannerOutputCompleteness;
  /** Capability-owned raw review evidence; currently emitted by HOMR. */
  review?: ScannerPageResult['review'];
  reviewedMusicXml?: ScannerStorageLocator;
  corrections?: ScannerPageResult['corrections'];
  artifacts: ScannerEngineArtifacts;
}

export type ScannerPageEngines = Record<ScannerEngineId, ScannerEngineRun | undefined>;

export const SCANNER_ENGINE_PLAN_VERSION = 'scanner-engine-plan-v1';

export interface ScannerEngineCapabilitySnapshot {
  displayName: string;
  outputArtifactKinds: string[];
  supportsSpotReview: boolean;
  supportsMeasureGeometry: boolean;
  unsupportedSemanticClasses: string[];
}

export interface ScannerEnginePlan {
  version: typeof SCANNER_ENGINE_PLAN_VERSION;
  engineIds: ScannerEngineId[];
  primaryEngineId: ScannerEngineId;
  fallbackEngineIds: ScannerEngineId[];
  capabilitySnapshots: Record<ScannerEngineId, ScannerEngineCapabilitySnapshot>;
}

const BUILTIN_SCANNER_CAPABILITIES: Record<string, ScannerEngineCapabilitySnapshot> = {
  homr: {
    displayName: 'HOMR',
    outputArtifactKinds: ['musicxml', 'pdf'],
    supportsSpotReview: true,
    supportsMeasureGeometry: true,
    unsupportedSemanticClasses: []
  },
  transcoda: {
    displayName: 'Transcoda',
    outputArtifactKinds: ['musicxml', 'kern'],
    supportsSpotReview: false,
    supportsMeasureGeometry: false,
    unsupportedSemanticClasses: ['lyrics', 'dynamics']
  }
};

function defaultCapabilitySnapshot(engineId: ScannerEngineId): ScannerEngineCapabilitySnapshot {
  return (
    BUILTIN_SCANNER_CAPABILITIES[engineId] || {
      displayName: engineId,
      outputArtifactKinds: ['musicxml'],
      supportsSpotReview: false,
      supportsMeasureGeometry: false,
      unsupportedSemanticClasses: []
    }
  );
}

export function scannerEnginePlan(
  engineIds: ScannerEngineId[],
  primaryEngineId: ScannerEngineId = engineIds[0],
  capabilitySnapshots: Partial<Record<ScannerEngineId, ScannerEngineCapabilitySnapshot>> = {}
): ScannerEnginePlan {
  const uniqueEngineIds = [...new Set(engineIds)];
  const suppliedCapabilities = Object.values(capabilitySnapshots);
  if (
    engineIds.length === 0 ||
    engineIds.length > 16 ||
    uniqueEngineIds.length !== engineIds.length ||
    engineIds.some((engineId) => !isScannerEngineId(engineId)) ||
    !uniqueEngineIds.includes(primaryEngineId) ||
    suppliedCapabilities.some(
      (capability) => capability && !isScannerEngineCapabilitySnapshot(capability)
    )
  ) {
    throw new Error('Invalid scanner engine plan');
  }
  return {
    version: SCANNER_ENGINE_PLAN_VERSION,
    engineIds: uniqueEngineIds,
    primaryEngineId,
    fallbackEngineIds: uniqueEngineIds.filter((engineId) => engineId !== primaryEngineId),
    capabilitySnapshots: Object.fromEntries(
      uniqueEngineIds.map((engineId) => [
        engineId,
        capabilitySnapshots[engineId] || defaultCapabilitySnapshot(engineId)
      ])
    )
  };
}

export function scannerDefaultEnginePlan(transcodaEnabled: boolean): ScannerEnginePlan {
  return scannerEnginePlan(transcodaEnabled ? ['homr', 'transcoda'] : ['homr'], 'homr');
}

/**
 * Return a persisted immutable plan, or infer the policy that legacy jobs used.
 * Inference includes already-recorded engines so disabling one cannot orphan its artifacts.
 */
export function scannerEnginePlanForJob(
  job: { enginePlan?: ScannerEnginePlan; pages?: ScannerPageResult[] },
  enabledEngineIds: ScannerEngineId[] | boolean = []
): ScannerEnginePlan {
  if (job.enginePlan) {
    const plan = job.enginePlan;
    if (
      !Array.isArray(plan.engineIds) ||
      !Array.isArray(plan.fallbackEngineIds) ||
      !plan.capabilitySnapshots ||
      plan.engineIds.some((engineId) => !plan.capabilitySnapshots[engineId])
    ) {
      throw new Error('Invalid persisted scanner engine plan');
    }
    const normalized = scannerEnginePlan(
      plan.engineIds,
      plan.primaryEngineId,
      plan.capabilitySnapshots
    );
    if (
      plan.version !== SCANNER_ENGINE_PLAN_VERSION ||
      plan.fallbackEngineIds.length !== normalized.fallbackEngineIds.length ||
      plan.fallbackEngineIds.some(
        (engineId, index) => engineId !== normalized.fallbackEngineIds[index]
      )
    ) {
      throw new Error('Invalid persisted scanner engine plan');
    }
    return normalized;
  }

  const enabledIds = Array.isArray(enabledEngineIds)
    ? enabledEngineIds
    : enabledEngineIds
      ? ['homr', 'transcoda']
      : ['homr'];
  const recordedEngineIds = (job.pages || []).flatMap((page) => Object.keys(page.engines || {}));
  const engineIds = [
    'homr',
    ...enabledIds.filter((engineId) => engineId !== 'homr'),
    ...recordedEngineIds.filter((engineId) => engineId !== 'homr')
  ];
  return scannerEnginePlan([...new Set(engineIds)], 'homr');
}

function isScannerEngineCapabilitySnapshot(
  value: unknown
): value is ScannerEngineCapabilitySnapshot {
  if (!value || typeof value !== 'object') return false;
  const capability = value as ScannerEngineCapabilitySnapshot;
  return (
    typeof capability.displayName === 'string' &&
    capability.displayName.length > 0 &&
    capability.displayName.length <= 80 &&
    Array.isArray(capability.outputArtifactKinds) &&
    capability.outputArtifactKinds.length > 0 &&
    capability.outputArtifactKinds.every(
      (kind) => typeof kind === 'string' && /^[a-z0-9][a-z0-9.-]{0,31}$/.test(kind)
    ) &&
    typeof capability.supportsSpotReview === 'boolean' &&
    typeof capability.supportsMeasureGeometry === 'boolean' &&
    Array.isArray(capability.unsupportedSemanticClasses) &&
    capability.unsupportedSemanticClasses.every((item) => typeof item === 'string')
  );
}

export interface ScannerEngineRunMetadata {
  providerRevision?: string;
  modelRevision?: string;
  provenance?: ScannerEngineProvenance;
}

/**
 * Derive the legacy page lifecycle from independently terminal engine runs.
 * A usable result survives the other engine failing, cancelling, or skipping.
 */
export function scannerAggregatePageStatus(
  engines: ScannerPageEngines,
  included = true
): ScannerPageResult['status'] {
  if (!included) return 'skipped';
  const runs = Object.values(engines).filter(Boolean) as ScannerEngineRun[];
  if (runs.length === 0) return 'pending';
  if (runs.some((run) => run.status === 'running')) return 'running';
  if (runs.some((run) => run.status === 'pending')) return 'pending';
  if (runs.some((run) => run.status === 'succeeded')) return 'succeeded';
  if (runs.some((run) => run.status === 'failed')) return 'failed';
  if (runs.every((run) => run.status === 'skipped')) return 'skipped';
  return 'cancelled';
}

/** Read compatibility and lazy migration for legacy top-level HOMR page fields. */
export function scannerHomrRun(
  page: ScannerPageResult,
  metadata: ScannerEngineRunMetadata = {}
): ScannerEngineRun {
  const existing = page.engines?.homr;
  if (existing) {
    const artifacts = existing.artifacts || {};
    return {
      ...existing,
      providerRevision: existing.providerRevision || metadata.providerRevision,
      modelRevision: existing.modelRevision || metadata.modelRevision,
      provenance: existing.provenance || metadata.provenance,
      review: existing.review || page.review,
      reviewedMusicXml: existing.reviewedMusicXml || page.reviewedMusicXml,
      corrections: existing.corrections || page.corrections,
      artifacts: {
        ...artifacts,
        musicXml: artifacts.musicXml || page.musicXml,
        pdf: artifacts.pdf || page.pdf
      }
    };
  }
  return {
    engine: 'homr',
    status: page.status,
    attempts: page.attempts,
    providerAttempts: page.providerAttempts,
    idempotencyKey: page.idempotencyKey,
    providerRequestId: page.providerRequestId,
    durationMs: page.durationMs,
    inferenceMs: page.inferenceMs,
    review: page.review,
    reviewedMusicXml: page.reviewedMusicXml,
    corrections: page.corrections,
    errorCode: page.errorCode,
    errorMessage: page.errorMessage,
    providerRevision: metadata.providerRevision,
    modelRevision: metadata.modelRevision,
    provenance: metadata.provenance,
    artifacts: { musicXml: page.musicXml, pdf: page.pdf }
  };
}

/** Dual-write the current legacy HOMR fields into the per-engine record. */
export function withScannerHomrRun(
  page: ScannerPageResult,
  metadata: ScannerEngineRunMetadata = {}
): ScannerPageResult {
  const legacyOnly: ScannerPageResult = {
    ...page,
    engines: { ...page.engines, homr: undefined }
  };
  return {
    ...page,
    engines: { ...page.engines, homr: scannerHomrRun(legacyOnly, metadata) }
  };
}

/** Store one engine result and derive the compatibility page status from all runs. */
export function withScannerEngineRun(
  page: ScannerPageResult,
  run: ScannerEngineRun
): ScannerPageResult {
  const engines = { ...page.engines, [run.engine]: run };
  const updated: ScannerPageResult = {
    ...page,
    status: scannerAggregatePageStatus(engines, page.included),
    engines
  };
  if (run.engine !== 'homr') return updated;
  return {
    ...updated,
    attempts: run.attempts,
    providerAttempts: run.providerAttempts,
    idempotencyKey: run.idempotencyKey,
    providerRequestId: run.providerRequestId,
    durationMs: run.durationMs,
    inferenceMs: run.inferenceMs,
    review: run.review,
    reviewedMusicXml: run.reviewedMusicXml,
    corrections: run.corrections,
    musicXml: run.status === 'succeeded' ? run.artifacts.musicXml : undefined,
    pdf: run.status === 'succeeded' ? run.artifacts.pdf || page.pdf : page.pdf,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage
  };
}

/** Bind a spot-review decision to one exact engine result and its accumulated edits. */
export function scannerEngineReviewContentSignature(run: ScannerEngineRun): string {
  return `scanner-engine-review-v1:${createHash('sha256')
    .update(
      JSON.stringify({
        engine: run.engine,
        rawMusicXmlSha256: run.artifacts.musicXml?.checksumSha256,
        reviewedMusicXmlSha256: run.reviewedMusicXml?.checksumSha256,
        review: run.review,
        corrections: run.corrections || []
      })
    )
    .digest('hex')}`;
}

/** All artifacts owned by engine runs, including model-native intermediates. */
export function scannerEngineArtifactLocators(page: ScannerPageResult): ScannerStorageLocator[] {
  return Object.values(page.engines || {}).flatMap((run) =>
    run
      ? ([...Object.values(run.artifacts), run.reviewedMusicXml].filter(
          Boolean
        ) as ScannerStorageLocator[])
      : []
  );
}

/** Reproducible per-engine result metadata without exposing storage object keys. */
export function scannerEngineManifest(page: ScannerPageResult): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(page.engines || {}).flatMap(([engine, run]) =>
      run
        ? [
            [
              engine,
              {
                status: run.status,
                attempts: run.attempts,
                providerAttempts: run.providerAttempts ?? run.attempts,
                providerRequestId: run.providerRequestId,
                durationMs: run.durationMs,
                inferenceMs: run.inferenceMs,
                generation: run.generation,
                errorCode: run.errorCode,
                errorMessage: run.errorMessage,
                providerRevision: run.providerRevision,
                modelRevision: run.modelRevision,
                provenance: run.provenance,
                completeness: run.completeness,
                reviewedMusicXmlChecksumSha256: run.reviewedMusicXml?.checksumSha256,
                artifactChecksumsSha256: Object.fromEntries(
                  Object.entries(run.artifacts).flatMap(([kind, locator]) =>
                    locator ? [[kind, locator.checksumSha256]] : []
                  )
                ),
                // Compatibility projection for manifests produced before the registry migration.
                artifacts: {
                  musicXmlSha256: run.artifacts.musicXml?.checksumSha256,
                  pdfSha256: run.artifacts.pdf?.checksumSha256,
                  kernSha256: run.artifacts.kern?.checksumSha256
                }
              }
            ]
          ]
        : []
    )
  );
}

/** Avoid duplicate deletes while legacy HOMR fields are dual-written. */
export function uniqueScannerStorageLocators(
  locators: Array<ScannerStorageLocator | undefined>
): ScannerStorageLocator[] {
  const unique = new Map<string, ScannerStorageLocator>();
  for (const locator of locators) {
    if (locator) unique.set(`${locator.bucket}/${locator.objectKey}`, locator);
  }
  return [...unique.values()];
}

export type ScannerPartMatchOutcome = 'matched' | 'ambiguous' | 'unmatched';

export interface ScannerComparisonPair {
  baseEngineId: ScannerEngineId;
  candidateEngineId: ScannerEngineId;
}

export interface ScannerPartMatchEvidence {
  normalizedNameEqual?: boolean;
  ordinalEqual?: boolean;
  staffCountEqual?: boolean;
  structureAgreement?: number;
  matchScore?: number;
}

export interface ScannerPartEndpoint {
  engineId: ScannerEngineId;
  artifactChecksumSha256: string;
  documentPartId: string;
  ordinal?: number;
  normalizedName?: string;
  staffCount?: number;
}

/** Auditable evidence for replacing document-local MusicXML part ids. */
export type ScannerPartMatch =
  | {
      outcome: 'matched';
      stablePartKey: string;
      base: ScannerPartEndpoint;
      candidate: ScannerPartEndpoint;
      evidence: ScannerPartMatchEvidence;
    }
  | {
      outcome: Exclude<ScannerPartMatchOutcome, 'matched'>;
      base?: ScannerPartEndpoint;
      candidate?: ScannerPartEndpoint;
      evidence: ScannerPartMatchEvidence;
      refusalReason: string;
    };

export interface ScannerMeasureCropRegion {
  systemIndex: number;
  staffIndices: number[];
  /** Source-page pixel coordinates: [left, top, right, bottom]. */
  region: [number, number, number, number];
}

/** Explicit join from generated MusicXML back to the source-image geometry. */
export interface ScannerMeasureRef {
  engine: ScannerEngineId;
  artifactChecksumSha256: string;
  stablePartKey: string;
  documentPartId: string;
  measureIndex: number;
  measureNumber?: string;
  cropRegions: ScannerMeasureCropRegion[];
}

export const SCANNER_ARTIFACT_INPUT_SIGNATURE_VERSION = 'scanner-artifact-input-v1';
export const SCANNER_BLOCK_CONTENT_SIGNATURE_VERSION = 'scanner-block-content-v2';

export const SCANNER_ARTIFACT_BUILDERS = {
  pagePdf: 'scanner-page-pdf-v1',
  musicXmlBundle: 'scanner-musicxml-bundle-v1',
  combinedMusicXml: 'scanner-combined-musicxml-v1',
  combinedPdf: 'scanner-combined-pdf-v1',
  resultsZip: 'scanner-results-zip-v1',
  previewPdf: 'scanner-preview-pdf-v1',
  previewThumbnail: 'scanner-preview-thumbnail-v1'
} as const;

export interface ScannerArtifactInput {
  ordinal: number;
  checksumSha256: string;
}

/**
 * Fingerprint the exact effective pages from which a materialized derivative was built.
 * Callers supply pages in score order; order is musical content and is not sorted here.
 */
export function scannerArtifactInputSignature(input: {
  builderVersion: string;
  pages: ScannerArtifactInput[];
}): string {
  return versionedSignature(SCANNER_ARTIFACT_INPUT_SIGNATURE_VERSION, [
    input.builderVersion,
    input.pages.map((page) => [page.ordinal, page.checksumSha256])
  ]);
}

/** Persist dependency identity on the artifact rather than in a parallel map. */
export function withScannerArtifactInputSignature(
  locator: ScannerStorageLocator,
  builderVersion: string,
  pages: ScannerArtifactInput[]
): ScannerStorageLocator {
  return {
    ...locator,
    inputSignature: scannerArtifactInputSignature({ builderVersion, pages })
  };
}

/** Signed artifacts are current only for exactly the inputs and builder requested. */
export function scannerArtifactInputMatches(
  locator: ScannerStorageLocator | undefined,
  builderVersion: string,
  pages: ScannerArtifactInput[]
): boolean {
  return Boolean(
    locator?.inputSignature &&
      locator.inputSignature === scannerArtifactInputSignature({ builderVersion, pages })
  );
}

/**
 * Bind a durable reconciliation decision to both source revisions and its rich content.
 * Descriptor hashes come from the equality representation, never the coarse LCS key.
 */
export function scannerBlockContentSignature(input: {
  sides: readonly [
    {
      role: 'base';
      engineId: ScannerEngineId;
      artifactChecksumSha256: string;
      descriptorHashes: readonly string[];
    },
    {
      role: 'candidate';
      engineId: ScannerEngineId;
      artifactChecksumSha256: string;
      descriptorHashes: readonly string[];
    }
  ];
  partMatchVersion: string;
  alignmentVersion: string;
  descriptorVersion: string;
  stablePartKey: string;
  contextBeforeHash?: string;
  contextAfterHash?: string;
}): string {
  return versionedSignature(SCANNER_BLOCK_CONTENT_SIGNATURE_VERSION, [
    input.sides.map((side) => [
      side.role,
      side.engineId,
      side.artifactChecksumSha256,
      side.descriptorHashes
    ]),
    input.partMatchVersion,
    input.alignmentVersion,
    input.descriptorVersion,
    input.stablePartKey,
    input.contextBeforeHash || null,
    input.contextAfterHash || null
  ]);
}

function versionedSignature(version: string, payload: unknown): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([version, payload]))
    .digest('hex');
  return `${version}:${digest}`;
}
