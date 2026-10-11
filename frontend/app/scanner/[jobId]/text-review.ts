/** Engines whose runs can carry the lyric, direction and dynamic review (OTS-HOMR reads it itself; HOMR borrows it). */
const REVIEW_ENGINES = ["ots-homr", "homr"] as const;

/** Whether any engine run of this page holds a stored text review, so the review page has something to open. */
export function pageHasTextReview(
  page:
    | { engines?: Record<string, { artifactKinds?: string[] } | undefined> }
    | undefined,
): boolean {
  return REVIEW_ENGINES.some((engineId) =>
    page?.engines?.[engineId]?.artifactKinds?.includes("text-fusion-review"),
  );
}
