import { createHash } from 'node:crypto';
import type {
  ScannerEngineProvenance,
  ScannerPageResult,
  ScannerStorageLocator
} from './schemas/scanner-job.schema';

export const SCANNER_ENGINES = ['homr', 'transcoda'] as const;
export type ScannerEngineName = (typeof SCANNER_ENGINES)[number];

export type ScannerEngineRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';

/** Independent state for one engine; page status is derived from both records. */
export interface ScannerEngineRun {
  engine: ScannerEngineName;
  status: ScannerEngineRunStatus;
  attempts: number;
  providerAttempts?: number;
  idempotencyKey: string;
  providerRequestId?: string;
  durationMs?: number;
  inferenceMs?: number;
  errorCode?: string;
  errorMessage?: string;
  providerRevision?: string;
  modelRevision?: string;
  provenance?: ScannerEngineProvenance;
  artifacts: {
    musicXml?: ScannerStorageLocator;
    pdf?: ScannerStorageLocator;
    /** Transcoda's model-authored output before music21 conversion. */
    kern?: ScannerStorageLocator;
  };
}

export interface ScannerPageEngines {
  homr?: ScannerEngineRun;
  transcoda?: ScannerEngineRun;
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
  return (
    page.engines?.homr || {
      engine: 'homr',
      status: page.status,
      attempts: page.attempts,
      providerAttempts: page.providerAttempts,
      idempotencyKey: page.idempotencyKey,
      providerRequestId: page.providerRequestId,
      durationMs: page.durationMs,
      inferenceMs: page.inferenceMs,
      errorCode: page.errorCode,
      errorMessage: page.errorMessage,
      providerRevision: metadata.providerRevision,
      modelRevision: metadata.modelRevision,
      provenance: metadata.provenance,
      artifacts: { musicXml: page.musicXml, pdf: page.pdf }
    }
  );
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

/** All artifacts owned by engine runs, including model-native intermediates. */
export function scannerEngineArtifactLocators(page: ScannerPageResult): ScannerStorageLocator[] {
  return Object.values(page.engines || {}).flatMap((run) =>
    run ? (Object.values(run.artifacts).filter(Boolean) as ScannerStorageLocator[]) : []
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

export interface ScannerPartMatchEvidence {
  homrOrdinal?: number;
  transcodaOrdinal?: number;
  normalizedNameEqual?: boolean;
  homrStaffCount?: number;
  transcodaStaffCount?: number;
  structureAgreement?: number;
}

/** Auditable evidence for replacing document-local MusicXML part ids. */
export type ScannerPartMatch =
  | {
      outcome: 'matched';
      stablePartKey: string;
      homrPartId: string;
      transcodaPartId: string;
      evidence: ScannerPartMatchEvidence;
    }
  | {
      outcome: Exclude<ScannerPartMatchOutcome, 'matched'>;
      homrPartId?: string;
      transcodaPartId?: string;
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
  engine: ScannerEngineName;
  artifactChecksumSha256: string;
  stablePartKey: string;
  documentPartId: string;
  measureIndex: number;
  measureNumber?: string;
  cropRegions: ScannerMeasureCropRegion[];
}

export const SCANNER_ARTIFACT_INPUT_SIGNATURE_VERSION = 'scanner-artifact-input-v1';
export const SCANNER_BLOCK_CONTENT_SIGNATURE_VERSION = 'scanner-block-content-v1';

/**
 * Fingerprint the exact effective pages from which a materialized derivative was built.
 * Callers supply pages in score order; order is musical content and is not sorted here.
 */
export function scannerArtifactInputSignature(input: {
  builderVersion: string;
  pages: Array<{ ordinal: number; checksumSha256: string }>;
}): string {
  return versionedSignature(SCANNER_ARTIFACT_INPUT_SIGNATURE_VERSION, [
    input.builderVersion,
    input.pages.map((page) => [page.ordinal, page.checksumSha256])
  ]);
}

/**
 * Bind a durable reconciliation decision to both source revisions and its rich content.
 * Descriptor hashes come from the equality representation, never the coarse LCS key.
 */
export function scannerBlockContentSignature(input: {
  homrArtifactChecksumSha256: string;
  transcodaArtifactChecksumSha256: string;
  partMatchVersion: string;
  descriptorVersion: string;
  stablePartKey: string;
  homrDescriptorHashes: string[];
  transcodaDescriptorHashes: string[];
  contextBeforeHash?: string;
  contextAfterHash?: string;
}): string {
  return versionedSignature(SCANNER_BLOCK_CONTENT_SIGNATURE_VERSION, [
    input.homrArtifactChecksumSha256,
    input.transcodaArtifactChecksumSha256,
    input.partMatchVersion,
    input.descriptorVersion,
    input.stablePartKey,
    input.homrDescriptorHashes,
    input.transcodaDescriptorHashes,
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
