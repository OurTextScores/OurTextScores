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
    status: "succeeded" | "failed";
    attempts: number;
    errorCode?: string;
    errorMessage?: string;
    hasMusicXml: boolean;
    hasPdf: boolean;
  }>;
  hasMusicXml: boolean;
  hasPdf: boolean;
  hasThumbnail: boolean;
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
  "rendering"
];

export function scannerStatusLabel(status: ScannerStatus): string {
  return status.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}
