/** @jest-environment node */
import { canonicalScoreUrl } from "./score-editor-launch";

describe("canonicalScoreUrl without a window", () => {
  it("does not throw during server rendering and keeps a relative base", () => {
    expect(typeof window).toBe("undefined");
    expect(canonicalScoreUrl({ apiBase: "/api", workId: "w 1", sourceId: "s1" })).toBe(
      "/api/works/w%201/sources/s1/canonical.xml",
    );
  });
});
