import { createHash } from 'node:crypto';
import type { ReviewStaff } from './scanner-review';
import type {
  ScannerEngineId,
  ScannerGenerationMetadata,
  ScannerOutputCompleteness
} from './scanner-dual-engine';
import type { ScannerEngineProvenance } from './schemas/scanner-job.schema';

export interface ScannerProviderScanInput {
  image: Buffer;
  filename: string;
  contentType: string;
  detectTitle: boolean;
  idempotencyKey: string;
  /** Immutable engine-plan policy, supplied only by the worker. */
  engineOptions?: unknown;
}

export interface ScannerProviderResult {
  engine: ScannerEngineId;
  musicXml: Buffer;
  /** Model-authored kern retained before Transcoda's MusicXML conversion. */
  kern?: Buffer;
  /** Other bounded, adapter-validated provider-native artifacts by registry kind. */
  nativeArtifacts?: Record<string, Buffer>;
  providerRevision: string;
  modelRevision: string;
  provenance: ScannerEngineProvenance;
  requestId?: string;
  inferenceMs?: number;
  /** Decoder termination diagnostics; currently supplied by Transcoda. */
  generation?: ScannerGenerationMetadata;
  /** Normalized across provider-specific termination/completeness diagnostics. */
  completeness?: ScannerOutputCompleteness;
  musicXmlSha256: string;
  /** Capability-owned normalized review data; absent without decoded token geometry. */
  review?: { staves: ReviewStaff[] };
  /** Named MusicXML readings produced by one inference request. */
  outputCandidates?: Record<string, { artifactKind: string; review?: { staves: ReviewStaff[] } }>;
  /** Structured families that can be materialized later without inference. */
  availableStructuredHeadFamilies?: string[];
  /** Cross-staff disagreements this page produced; evidence, never a correction. */
  crossStaffFindings?: ScannerCrossStaffFinding[];
}

/**
 * One deterministic cross-staff disagreement, for a reviewer to see and judge.
 *
 * Never gates anything. A page carrying findings is a complete page with annotations
 * on it, not a failed one - several kinds fire on ordinary music (a cello reading in
 * tenor against a profile expecting bass), which is only tolerable because a reviewer
 * can dismiss them.
 */
export interface ScannerCrossStaffFinding {
  kind: string;
  message: string;
  /** Index of the scanned system, when the finding concerns one. */
  system?: number;
  /** Positions within that system, top to bottom - never page-wide staff numbers. */
  staffIndices?: number[];
  /** The profile part the staff maps to, when a profile was supplied. */
  part?: string;
}

/** Engine adapter consumed by orchestration; transport details stay behind it. */
export interface ScannerPageProvider {
  readonly engine: ScannerEngineId;
  readonly expectedRevision: string;
  createIdempotencyKey(input: {
    inputSha256: string;
    pageNumber: number;
    detectTitle: boolean;
    generation: number;
    engineOptions?: unknown;
  }): string;
  scanPage(input: ScannerProviderScanInput): Promise<ScannerProviderResult>;
  /** Optional normalized regeneration contract for engines that support spot review. */
  regenerateReview?(staves: string[][][]): Promise<Buffer>;
  /** Materialize a stored structured proposal subset; performs no model inference. */
  materializeStructured?(proposals: Buffer, families: string[]): Promise<Buffer>;
}

export function scannerProviderIdempotencyKey(input: {
  engine: ScannerEngineId;
  modelRevision: string;
  modelArtifactSha256?: string;
  converterVersion?: string;
  preprocessingRevision: string;
  decodingRevision?: string;
  inputSha256: string;
  pageNumber: number;
  detectTitle: boolean;
  generation: number;
  engineOptions?: unknown;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
