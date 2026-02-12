import {
  getFileExtension,
  toAnalyticsError,
  trackUploadOutcomeClient,
  trackApprovalOutcomeServer,
  trackWatchToggleServer,
} from "./analytics";

describe("analytics helpers", () => {
  it("extracts a lowercase file extension", () => {
    expect(getFileExtension("score.MSCZ")).toBe("mscz");
    expect(getFileExtension("folder/name.music.xml")).toBe("xml");
  });

  it("returns undefined for filenames without extension", () => {
    expect(getFileExtension("score")).toBeUndefined();
    expect(getFileExtension("")).toBeUndefined();
    expect(getFileExtension(undefined)).toBeUndefined();
  });

  it("normalizes unknown errors into strings", () => {
    expect(toAnalyticsError(new Error("boom"))).toBe("boom");
    expect(toAnalyticsError("plain-text")).toBe("plain-text");
  });

  it("keeps tracking calls non-blocking in test env", async () => {
    expect(() =>
      trackUploadOutcomeClient({
        flow: "upload_page",
        outcome: "success",
        kind: "source",
        workId: "work-1",
      })
    ).not.toThrow();

    await expect(
      trackApprovalOutcomeServer({
        decision: "approve",
        outcome: "success",
        workId: "work-1",
        sourceId: "source-1",
        revisionId: "rev-1",
      })
    ).resolves.toBeUndefined();

    await expect(
      trackWatchToggleServer({
        action: "watch",
        outcome: "success",
        workId: "work-1",
        sourceId: "source-1",
      })
    ).resolves.toBeUndefined();
  });
});
