export const PUBLIC_CHANGE_REVIEW_ID = 'f8fce149-4c91-488a-8516-e051d9868f30';
export const PUBLIC_SCANNER_JOB_ID = 'ef98b123-329e-4ae7-a01f-cf15059b354b';

/** A non-user principal used only to pass Scanner's availability check for public reads. */
export const PUBLIC_EXAMPLE_VIEWER_ID = 'public-example';

export function isPublicChangeReview(reviewId: unknown): boolean {
  return reviewId === PUBLIC_CHANGE_REVIEW_ID;
}

export function isPublicScannerJob(jobId: unknown): boolean {
  return jobId === PUBLIC_SCANNER_JOB_ID;
}
