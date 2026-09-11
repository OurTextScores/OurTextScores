import { pageFindingsRegionsUrlContract } from './scanner-findings-urls';

/**
 * The findings regions document addresses everything inside it *relatively* -- the scan
 * crops, and `../merged` for the save. So where the document itself sits is part of its
 * contract, not an arrangement of the route table, and moving it breaks links that no
 * type checks and no unit test of either end would notice.
 *
 * It shipped at `pages/N/engines/E/findings/regions` and both resolved to nonsense: the
 * crop doubled its path segments, and the merge target moved under the engine, which
 * would have failed every save. The crop failure was visible; the save failure would not
 * have been until someone tried to save.
 */
function resolve(relative: string, base: string): string {
  return new URL(relative, `https://host${base}`).pathname + new URL(relative, `https://host${base}`).search;
}

const JOB = '/api/proxy/scanner/jobs/job-1/pages/3';

describe('findings regions relative links', () => {
  const regions = pageFindingsRegionsUrlContract(JOB);

  it('places the document as a sibling of merged, like the comparison does', () => {
    expect(regions.document).toBe(`${JOB}/findings/regions`);
  });

  it('resolves a scan crop to the crop route', () => {
    expect(resolve('systems/0/crop?engine=ots-homr&statusVersion=4', regions.document)).toBe(
      `${JOB}/findings/systems/0/crop?engine=ots-homr&statusVersion=4`,
    );
  });

  it('resolves the merge target to the page, not under the engine', () => {
    // `mergedScoreLinks` emits `../merged` for every consumer; this is the one that
    // would have silently pointed somewhere else.
    expect(resolve('../merged', regions.document)).toBe(`${JOB}/merged`);
  });

  it('resolves the merged document the editor loads', () => {
    expect(resolve('../merged/musicxml?revision=0', regions.document)).toBe(
      `${JOB}/merged/musicxml?revision=0`,
    );
  });

  it('resolves the same way the comparison document does', () => {
    // The property that makes the shared helpers correct for both.
    const comparison = `${JOB}/comparison/regions`;
    expect(resolve('../merged', comparison)).toBe(resolve('../merged', regions.document));
  });

  it('would not resolve from a deeper path — the shape that shipped', () => {
    const deeper = `${JOB}/engines/ots-homr/findings/regions`;
    expect(resolve('../merged', deeper)).not.toBe(`${JOB}/merged`);
  });
});
