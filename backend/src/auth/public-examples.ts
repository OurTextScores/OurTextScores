export const PUBLIC_CHANGE_REVIEW_ID = 'b81896dd-0ce1-4b60-b5e4-29273c7384aa';
export const PUBLIC_SCANNER_JOB_ID = '59fcaa3c-9ddb-428d-9fe5-340c2ead6ab2';

/** A non-user principal used only to pass Scanner's availability check for public reads. */
export const PUBLIC_EXAMPLE_VIEWER_ID = 'public-example';

export function isPublicChangeReview(reviewId: unknown): boolean {
  return reviewId === PUBLIC_CHANGE_REVIEW_ID;
}

export function isPublicScannerJob(jobId: unknown): boolean {
  return jobId === PUBLIC_SCANNER_JOB_ID;
}
