describe("prepareUploadScoreFile", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("returns the original file for non-mscz uploads", async () => {
    const { prepareUploadScoreFile } = await import("./client-mscz-conversion");
    const file = new File([new Uint8Array([1, 2, 3])], "source.mxl", {
      type: "application/vnd.recordare.musicxml",
    });

    const result = await prepareUploadScoreFile(file);

    expect(result.file).toBe(file);
    expect(result.convertedFromMscz).toBe(false);
    expect(result.originalFilename).toBe("source.mxl");
  });

  it("converts mscz files when webmscore is wrapped in nested defaults", async () => {
    const destroy = jest.fn();
    const saveMxl = jest.fn(async () => new Uint8Array([9, 8, 7]));
    const load = jest.fn(async () => ({
      saveMxl,
      destroy,
    }));

    jest.doMock("webmscore", () => ({
      __esModule: true,
      default: {
        default: {
          ready: Promise.resolve(),
          load,
        },
      },
    }));

    const { prepareUploadScoreFile } = await import("./client-mscz-conversion");
    const progress: Array<{ message: string; milestone: string }> = [];
    const file = new File([new Uint8Array([1, 2, 3])], "demo.mscz", {
      type: "application/octet-stream",
    }) as File & { arrayBuffer: () => Promise<ArrayBuffer> };
    file.arrayBuffer = async () => new Uint8Array([1, 2, 3]).buffer;

    const result = await prepareUploadScoreFile(file, (p) => progress.push(p));

    expect(load).toHaveBeenCalledWith("mscz", expect.any(Uint8Array));
    expect(saveMxl).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
    expect(result.convertedFromMscz).toBe(true);
    expect(result.file.name).toBe("demo.mxl");
    expect(result.file.type).toBe("application/vnd.recordare.musicxml");
    expect(result.originalMsczFile?.name).toBe("demo.mscz");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1].milestone).toBe("done");
  });
});
