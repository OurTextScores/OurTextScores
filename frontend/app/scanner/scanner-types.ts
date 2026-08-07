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

export interface ScannerJob {
  jobId: string;
  status: ScannerStatus;
  /** Increments on every visible change; see design section 7.1. */
  statusVersion?: number;
  originalFilename: string;
  pageCount: number;
  includedPageCount: number;
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
    hasPdf: boolean;
    canRetry: boolean;
  }>;
  hasMusicXml: boolean;
  hasPdf: boolean;
  hasThumbnail: boolean;
  hasZip: boolean;
  errorCode?: string;
  errorMessage?: string;
  canRetry: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  resultExpiresAt: string;
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
