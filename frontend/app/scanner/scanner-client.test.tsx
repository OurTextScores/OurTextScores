import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import ScannerClient from "./scanner-client";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

/** Minimal XMLHttpRequest double that can also emit upload progress. */
class FakeXhr {
  static last: FakeXhr | null = null;
  status = 202;
  responseText = JSON.stringify({ jobId: "job-new", status: "preparing" });
  upload: {
    onprogress?: (e: {
      lengthComputable: boolean;
      loaded: number;
      total: number;
    }) => void;
  } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  body: FormData | null = null;
  open() {}
  send(body: FormData) {
    this.body = body;
    FakeXhr.last = this;
  }
  finish() {
    this.onload?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
}

const job = (jobId: string) => ({
  jobId,
  status: "succeeded",
  statusVersion: 4,
  originalFilename: "listed.pdf",
  pageCount: 1,
  includedPageCount: 1,
  pages: [],
  hasMusicXml: true,
  hasPdf: true,
  hasThumbnail: true,
  hasZip: true,
  canRetry: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  resultExpiresAt: new Date().toISOString(),
});

const providers = ["homr", "transcoda", "ots-homr"].map((id) => ({
  id,
  displayName:
    id === "homr" ? "HOMR" : id === "transcoda" ? "Transcoda" : "OTS-HOMR",
  capabilities: {
    displayName: id,
    outputArtifactKinds: ["musicxml", "pdf"],
    supportsSpotReview: id === "homr",
    supportsMeasureGeometry: id === "homr",
    unsupportedSemanticClasses: [],
  },
}));

function selectProviders(first = "homr", second = "transcoda") {
  fireEvent.change(screen.getByLabelText("Provider"), {
    target: { value: first },
  });
  fireEvent.change(screen.getByLabelText("Comparison provider (optional)"), {
    target: { value: second },
  });
}

describe("ScannerClient", () => {
  beforeEach(() => {
    push.mockClear();
    FakeXhr.last = null;
    (globalThis as any).XMLHttpRequest = FakeXhr;
    global.fetch = jest.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return {
            ok: true,
            json: async () => ({
              jobId: "job-multi",
              status: "succeeded",
              originalFilename: "page-2.png + 1 more",
              pageCount: 2,
              includedPageCount: 2,
              pages: [],
              hasMusicXml: true,
              hasPdf: true,
              hasThumbnail: true,
              hasZip: true,
              canRetry: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              resultExpiresAt: new Date().toISOString(),
            }),
          } as Response;
        }
        if (String(url).includes("/engines")) {
          return {
            ok: true,
            json: async () => ({ items: providers }),
          } as Response;
        }
        return { ok: true, json: async () => [] } as Response;
      },
    );
  });

  it.each([
    ["paginated envelope", { items: [job("job-listed")], nextCursor: null }],
    ["pre-pagination array", [job("job-listed")]],
  ])("renders Recent scans from a %s", async (_label, body) => {
    // The array shape keeps a rolling deploy working when the frontend ships
    // ahead of the backend.
    global.fetch = jest.fn(
      async (url: RequestInfo | URL) =>
        ({
          ok: true,
          json: async () =>
            String(url).includes("/engines") ? { items: providers } : body,
        }) as Response,
    );
    render(<ScannerClient />);
    expect(await screen.findByText("listed.pdf")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/proxy/scanner/jobs?limit=20",
      expect.anything(),
    );
  });

  it.each([
    [503, "Scanner is not enabled on this deployment."],
    [403, "Your account is not on the Scanner beta allowlist."],
  ])(
    "explains a %s from the backend instead of offering an upload",
    async (status, expected) => {
      // NEXT_PUBLIC_SCANNER_ENABLED is inlined at image build time, so it can
      // outlive the backend being enabled; the UI must follow the backend.
      global.fetch = jest.fn(
        async () => ({ ok: false, status, json: async () => ({}) }) as Response,
      );
      render(<ScannerClient />);
      expect(await screen.findByText(expected)).toBeInTheDocument();
      expect(screen.queryByLabelText("Score files")).toBeNull();
    },
  );

  it("keeps providers selectable when retained scan history fails", async () => {
    global.fetch = jest.fn(async (url: RequestInfo | URL) =>
      String(url).includes("/engines")
        ? ({
            ok: true,
            status: 200,
            json: async () => ({ items: providers }),
          } as Response)
        : ({
            ok: false,
            status: 500,
            json: async () => ({ message: "Invalid retained scan" }),
          } as Response),
    );

    render(<ScannerClient />);

    expect(
      await screen.findAllByRole("option", { name: "OTS-HOMR" }),
    ).toHaveLength(2);
    expect(screen.getByText("Invalid retained scan")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "This deployment does not currently have a provider available.",
      ),
    ).not.toBeInTheDocument();
  });

  it("requires one provider and makes a second provider optional", async () => {
    render(<ScannerClient />);
    expect(
      await screen.findAllByRole("option", { name: "OTS-HOMR" }),
    ).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Score files"), {
      target: {
        files: [new File(["score"], "page.png", { type: "image/png" })],
      },
    });

    const submit = screen.getByRole("button", { name: "Select pages" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "homr" },
    });
    expect(submit).toBeEnabled();
  });

  it("submits a single provider without creating a comparison pair", async () => {
    render(<ScannerClient />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Score files"), {
      target: {
        files: [new File(["score"], "page.png", { type: "image/png" })],
      },
    });
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "homr" },
    });

    fireEvent.submit(
      screen.getByRole("button", { name: "Select pages" }).closest("form")!,
    );
    await waitFor(() => expect(FakeXhr.last).not.toBeNull());
    expect(JSON.parse(String(FakeXhr.last!.body!.get("engineIds")))).toEqual([
      "homr",
    ]);
    expect(FakeXhr.last!.body!.has("otsHomr")).toBe(false);
  });

  it("shows and submits multiple images in natural filename order", async () => {
    render(<ScannerClient />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const pageTen = new File(["ten"], "page-10.png", { type: "image/png" });
    const pageTwo = new File(["two"], "page-2.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Score files"), {
      target: { files: [pageTen, pageTwo] },
    });
    selectProviders();

    const order = screen.getByText("Initial page order").parentElement;
    expect(order).not.toBeNull();
    expect(
      within(order!)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["page-2.png", "page-10.png"]);

    const submit = screen.getByRole("button", { name: "Select pages" });
    fireEvent.submit(submit.closest("form")!);
    await waitFor(() => expect(FakeXhr.last).not.toBeNull());
    const submitted = FakeXhr.last!.body!.getAll("file") as File[];
    expect(submitted.map((file) => file.name)).toEqual([
      "page-2.png",
      "page-10.png",
    ]);
  });

  it("submits two providers and OTS-HOMR options when it is selected", async () => {
    render(<ScannerClient />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const file = new File(["score"], "page-1.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Score files"), {
      target: { files: [file] },
    });
    selectProviders("homr", "ots-homr");
    fireEvent.change(screen.getByLabelText("Text detector"), {
      target: { value: "non-lyric-text" },
    });
    expect(screen.queryByLabelText("Additional heads")).not.toBeInTheDocument();

    fireEvent.submit(
      screen.getByRole("button", { name: "Select pages" }).closest("form")!,
    );
    await waitFor(() => expect(FakeXhr.last).not.toBeNull());
    expect(JSON.parse(String(FakeXhr.last!.body!.get("engineIds")))).toEqual([
      "homr",
      "ots-homr",
    ]);
    expect(JSON.parse(String(FakeXhr.last!.body!.get("otsHomr")))).toEqual({
      textDetector: "non-lyric-text",
    });
  });

  it("sends the chosen score profile", async () => {
    // The picker is the only thing that supplies a profile; if it does not reach the
    // payload the clef checks stay unreachable exactly as they were before the
    // channel existed, and nothing anywhere would say so.
    render(<ScannerClient />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Score files"), {
      target: {
        files: [new File(["score"], "page-1.png", { type: "image/png" })],
      },
    });
    selectProviders("ots-homr");
    fireEvent.change(screen.getByLabelText("Score profile"), {
      target: { value: "string-quartet" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Select pages" }).closest("form")!,
    );
    await waitFor(() => expect(FakeXhr.last).not.toBeNull());

    const sent = JSON.parse(String(FakeXhr.last!.body!.get("otsHomr")));
    expect(sent.scoreProfile.schemaVersion).toEqual("homr.score-profile.v1");
    expect(
      sent.scoreProfile.parts.map(
        (part: { stableId: string }) => part.stableId,
      ),
    ).toEqual(["violin-1", "violin-2", "viola", "cello"]);
    // Generous by design: a cello reading in tenor or treble is ordinary music, and a
    // profile naming only bass would fire on the repertoire it is meant to help with.
    expect(
      sent.scoreProfile.parts.find(
        (part: { stableId: string }) => part.stableId === "cello",
      ).likelyClefs,
    ).toEqual(["F4", "C4", "G2"]);
  });

  it("omits the profile entirely when the reader does not say", async () => {
    // Absence of the field, not a null: the option is validated by an allowlist.
    render(<ScannerClient />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Score files"), {
      target: {
        files: [new File(["score"], "page-1.png", { type: "image/png" })],
      },
    });
    selectProviders("ots-homr");
    fireEvent.submit(
      screen.getByRole("button", { name: "Select pages" }).closest("form")!,
    );
    await waitFor(() => expect(FakeXhr.last).not.toBeNull());
    const sent = JSON.parse(String(FakeXhr.last!.body!.get("otsHomr")));
    expect(sent).toEqual({ textDetector: "lyrics" });
    expect("scoreProfile" in sent).toBe(false);
  });

  it("refuses an oversized selection before sending it", async () => {
    // On Vercel the request never reaches our route handler: the platform
    // rejects the body at the edge and returns a 413 we cannot annotate. The
    // pre-flight has to catch it while we can still explain what to do.
    render(<ScannerClient />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const huge = new File(["x"], "huge.png", { type: "image/png" });
    Object.defineProperty(huge, "size", { value: 30 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText("Score files"), {
      target: { files: [huge] },
    });

    fireEvent.submit(
      screen.getByRole("button", { name: "Select pages" }).closest("form")!,
    );
    expect(await screen.findByText(/the limit is/i)).toBeInTheDocument();
    expect(FakeXhr.last).toBeNull();
  });

  it("explains a 413 rather than reporting the status code", async () => {
    render(<ScannerClient />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Score files"), {
      target: { files: [new File(["a"], "page-1.png", { type: "image/png" })] },
    });
    selectProviders();
    fireEvent.submit(
      screen.getByRole("button", { name: "Select pages" }).closest("form")!,
    );
    await waitFor(() => expect(FakeXhr.last).not.toBeNull());

    // A platform 413 carries an HTML body, so the JSON path cannot help.
    FakeXhr.last!.status = 413;
    FakeXhr.last!.responseText = "<html>Request Entity Too Large</html>";
    await act(async () => {
      FakeXhr.last!.finish();
    });
    expect(
      await screen.findByText(/refused this upload as too large/i),
    ).toBeInTheDocument();
  });

  it("reports real upload progress and then opens the new scan", async () => {
    render(<ScannerClient />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Score files"), {
      target: {
        files: [
          new File(["x".repeat(2048)], "page.png", { type: "image/png" }),
        ],
      },
    });
    selectProviders();
    fireEvent.submit(
      screen.getByRole("button", { name: "Select pages" }).closest("form")!,
    );
    await waitFor(() => expect(FakeXhr.last).not.toBeNull());

    // Bytes sent, not a spinner: fetch cannot report this, which is why the
    // upload uses XMLHttpRequest.
    act(() => FakeXhr.last!.progress(1024, 2048));
    expect(
      await screen.findByText(/Uploading to OurTextScores/),
    ).toBeInTheDocument();
    expect(screen.getByText(/50% sent/)).toBeInTheDocument();

    // At 100% the bytes stall while the server stores the upload, so the copy
    // switches rather than sitting on a finished-looking bar.
    act(() => FakeXhr.last!.progress(2048, 2048));
    expect(await screen.findByText(/Upload complete/)).toBeInTheDocument();

    act(() => FakeXhr.last!.finish());
    await waitFor(() => expect(push).toHaveBeenCalledWith("/scanner/job-new"));
  });
});
