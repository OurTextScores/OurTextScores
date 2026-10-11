import { pageHasTextReview } from "./text-review";

describe("pageHasTextReview", () => {
  it("is true when OTS-HOMR or HOMR holds a stored text review", () => {
    expect(
      pageHasTextReview({
        engines: {
          "ots-homr": { artifactKinds: ["musicxml", "text-fusion-review"] },
        },
      }),
    ).toBe(true);
    expect(
      pageHasTextReview({
        engines: {
          homr: { artifactKinds: ["musicxml", "text-fusion-review"] },
        },
      }),
    ).toBe(true);
  });

  it("is false without one, for other engines, and for a missing page", () => {
    expect(
      pageHasTextReview({ engines: { homr: { artifactKinds: ["musicxml"] } } }),
    ).toBe(false);
    expect(
      pageHasTextReview({
        engines: { transcoda: { artifactKinds: ["text-fusion-review"] } },
      }),
    ).toBe(false);
    expect(pageHasTextReview({})).toBe(false);
    expect(pageHasTextReview(undefined)).toBe(false);
  });
});
