export type ScannerStatus =
  | "queued"
  | "preparing"
  | "ready"
  | "running"
  | "rendering"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";

export interface ScannerScoreProfilePart {
  stableId: string;
  displayName?: string;
  /** Generous on purpose: a cello reads in bass, tenor and treble alike. */
  likelyClefs?: string[];
  transpositionSemitones?: number;
  expectedStaffCount?: number;
}

/** A prior a reviewer can reject, never a rule the pipeline enforces. */
export interface ScannerScoreProfile {
  schemaVersion: "homr.score-profile.v1";
  parts: ScannerScoreProfilePart[];
}

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

export interface ScannerEngineRun {
  status:
    "pending" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
  attempts: number;
  /** When this attempt reached the provider; absent on runs that never began. */
  startedAt?: string;
  /**
   * Cross-staff disagreements this run found. Evidence, never a correction, and it
   * gates nothing: a page with findings is a complete page with annotations on it.
   */
  crossStaffFindings?: ScannerCrossStaffFinding[];
  providerAttempts?: number;
  errorCode?: string;
  errorMessage?: string;
  hasMusicXml: boolean;
  hasPdf: boolean;
  hasKern: boolean;
  hasReview?: boolean;
  artifactKinds?: string[];
  availableStructuredHeadFamilies?: string[];
  selectedStructuredHeadFamilies?: string[];
  structuredOutputPending?: boolean;
  structuredOutputRetryable?: boolean;
  structuredReviewRefreshable?: boolean;
  structuredOutputError?: string;
  completeness?: "complete" | "possibly-incomplete" | "incomplete" | "unknown";
  generation?: {
    hitMaxLength: boolean;
    sawEos: boolean;
    truncated: boolean;
    maxLength?: number;
    numBeams?: number;
  };
}

export interface ScannerJob {
  jobId: string;
  publicExample?: boolean;
  status: ScannerStatus;
  /** Increments on every visible change; see design section 7.1. */
  statusVersion?: number;
  originalFilename: string;
  pageCount: number;
  includedPageCount: number;
  /** Page images finished so far; only sent while the job is `preparing`. */
  preparedPageCount?: number;
  enginePlan?: {
    version: "scanner-engine-plan-v1";
    engineIds: string[];
    primaryEngineId: string;
    fallbackEngineIds: string[];
    capabilitySnapshots: Record<
      string,
      {
        displayName: string;
        outputArtifactKinds: string[];
        supportsSpotReview: boolean;
        supportsMeasureGeometry: boolean;
        unsupportedSemanticClasses: string[];
      }
    >;
  };
  pages: Array<{
    pageNumber: number;
    ordinal: number;
    rotationDegrees: 0 | 90 | 180 | 270;
    included: boolean;
    status:
      "pending" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
    attempts: number;
    manualRetries: number;
    errorCode?: string;
    errorMessage?: string;
    hasThumbnail: boolean;
    hasMusicXml: boolean;
    /** Raw engine selected by plan order; absent for reviewed/reconciled derivatives. */
    effectiveEngineId?: string;
    /** A reviewer has reconciled this page; it is what assembly uses. */
    hasMergedScore?: boolean;
    mergedDecisionCount?: number;
    hasPdf: boolean;
    canRetry: boolean;
    engines?: Record<string, ScannerEngineRun | undefined>;
  }>;
  hasMusicXml: boolean;
  hasPdf: boolean;
  hasThumbnail: boolean;
  hasZip: boolean;
  /** Design section 6 assembly outcome. */
  mergeStatus?: "not-requested" | "succeeded" | "incompatible" | "failed";
  mergeReason?: string;
  hasCombinedMusicXml?: boolean;
  hasCombinedPdf?: boolean;
  errorCode?: string;
  errorMessage?: string;
  canRetry: boolean;
  createdAt: string;
  /** When a worker claimed the job; absent while it is still queued. */
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  resultExpiresAt: string;
}

export interface ScannerProviderOption {
  id: string;
  displayName: string;
  capabilities: {
    displayName: string;
    outputArtifactKinds: string[];
    supportsSpotReview: boolean;
    supportsMeasureGeometry: boolean;
    unsupportedSemanticClasses: string[];
  };
}

export const activeScannerStatuses: ScannerStatus[] = [
  "queued",
  "preparing",
  "running",
  "rendering",
];

export function scannerStatusLabel(
  status: ScannerStatus | ScannerJob["pages"][number]["status"],
): string {
  return status
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
