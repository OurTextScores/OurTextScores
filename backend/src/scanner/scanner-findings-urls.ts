/**
 * Where the findings regions document lives, and why it matters.
 *
 * Its contents address siblings relatively -- scan crops as `systems/N/crop`, and the
 * merge target as `../merged` via `mergedScoreLinks`, which every consumer shares. That
 * makes the document's own depth part of its contract: move it and the links inside it
 * point somewhere else, with nothing in the type system or either end's unit tests to
 * notice.
 *
 * Stated here as a value so a test can pin it, rather than living only as a string in a
 * route decorator and another in a React component.
 */
export function pageFindingsRegionsUrlContract(pageBase: string): {
  document: string;
  systemCrop: (systemIndex: number) => string;
} {
  return {
    document: `${pageBase}/findings/regions`,
    systemCrop: (systemIndex: number) => `systems/${systemIndex}/crop`
  };
}
