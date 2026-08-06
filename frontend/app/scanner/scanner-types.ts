export type ScannerStatus =
  | "queued"
  | "preparing"
  | "running"
  | "rendering"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";

export interface ScannerJob {
  jobId: string;
  status: ScannerStatus;
  originalFilename: string;
  pageCount: number;
  pages: Array<{
    pageNumber: number;
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
