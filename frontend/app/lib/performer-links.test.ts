import { performHref } from "./performer-links";

describe("performer links", () => {
  it("addresses the vendored perform page", () => {
    expect(performHref()).toBe("/score-editor/perform.html");
    expect(performHref({ guide: true })).toBe("/score-editor/perform.html?guide");
    expect(performHref({ score: "https://x.test/a b.mscz" })).toBe(
      "/score-editor/perform.html?score=https%3A%2F%2Fx.test%2Fa%20b.mscz",
    );
  });
});
