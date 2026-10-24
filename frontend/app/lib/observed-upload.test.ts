import { observedUpload } from "./observed-upload";

describe("observed uploads", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: () => "12345678-1234-1234-1234-123456789012",
      configurable: true,
    });
    global.fetch = jest.fn();
  });
  it("correlates edge 413 observations without reporting file contents", async () => {
    (fetch as jest.Mock)
      .mockResolvedValueOnce({ status: 413 })
      .mockResolvedValueOnce({ ok: true });
    await observedUpload("/api/proxy/projects/123/sources", {
      method: "POST",
      body: "private file bytes",
    });
    const [url, init] = (fetch as jest.Mock).mock.calls[1];
    expect(url).toBe("/api/proxy/operations/upload-observations");
    expect(JSON.parse(init.body)).toMatchObject({
      status: 413,
      operation: "project",
      attemptId: "12345678-1234-1234-1234-123456789012",
    });
    expect(init.body).not.toContain("private file bytes");
  });
  it("does not manufacture client success records or monitor unrelated requests", async () => {
    (fetch as jest.Mock).mockResolvedValue({ status: 201 });
    await observedUpload("/api/works/1/sources", { method: "POST" });
    expect(fetch).toHaveBeenCalledTimes(1);
    await observedUpload("/api/auth/api-token");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("preserves network errors while recording unknown outcome", async () => {
    (fetch as jest.Mock)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true });
    await expect(
      observedUpload("/api/proxy/scanner/jobs", { method: "POST" }),
    ).rejects.toThrow("network");
    expect(JSON.parse((fetch as jest.Mock).mock.calls[1][1].body).status).toBe(
      0,
    );
  });
});
