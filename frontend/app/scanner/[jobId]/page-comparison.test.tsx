"use client";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PageComparison from "./page-comparison";
import { ScannerJob } from "../scanner-types";


const page: ScannerJob["pages"][number] = {
  pageNumber: 1,
  ordinal: 1,
  rotationDegrees: 0,
  included: true,
  status: "succeeded",
  attempts: 1,
  manualRetries: 0,
  hasThumbnail: true,
  hasMusicXml: true,
  hasPdf: true,
  canRetry: false,
  engines: {
    homr: {
      status: "succeeded",
      attempts: 1,
      hasMusicXml: true,
      hasPdf: true,
      hasKern: false,
    },
    transcoda: {
      status: "succeeded",
      attempts: 1,
      hasMusicXml: true,
      hasPdf: false,
      hasKern: true,
    },
    kraken: {
      status: "succeeded",
      attempts: 1,
      hasMusicXml: true,
      hasPdf: false,
      hasKern: false,
    },
  },
};

const job: ScannerJob = {
  jobId: "job-1",
  status: "succeeded",
  statusVersion: 9,
  originalFilename: "score.pdf",
  pageCount: 1,
  includedPageCount: 1,
  enginePlan: {
    version: "scanner-engine-plan-v1",
    engineIds: ["homr", "transcoda", "kraken"],
    primaryEngineId: "homr",
    fallbackEngineIds: ["transcoda", "kraken"],
    capabilitySnapshots: {
      homr: {
        displayName: "HOMR",
        outputArtifactKinds: ["musicxml", "pdf"],
        supportsSpotReview: true,
        supportsMeasureGeometry: true,
        unsupportedSemanticClasses: [],
      },
      transcoda: {
        displayName: "Transcoda",
        outputArtifactKinds: ["musicxml", "kern"],
        supportsSpotReview: false,
        supportsMeasureGeometry: false,
        unsupportedSemanticClasses: ["lyrics", "dynamics"],
      },
      kraken: {
        displayName: "Kraken OMR",
        outputArtifactKinds: ["musicxml"],
        supportsSpotReview: false,
        supportsMeasureGeometry: false,
        unsupportedSemanticClasses: [],
      },
    },
  },
  pages: [page],
  hasMusicXml: true,
  hasPdf: true,
  hasThumbnail: true,
  hasZip: true,
  canRetry: false,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:01:00.000Z",
  completedAt: "2026-08-11T12:01:00.000Z",
  resultExpiresAt: "2026-09-10T12:00:00.000Z",
};

const contentSignature = `scanner-block-content-v2:${"a".repeat(64)}`;
const geometrySignature = `scanner-measure-geometry-v1:${"b".repeat(64)}`;
const baseArtifactChecksum = "c".repeat(64);
const candidateArtifactChecksum = "d".repeat(64);

function readyComparison(candidateEngineId = "transcoda") {
  const candidateName =
    candidateEngineId === "kraken" ? "Kraken OMR" : "Transcoda";
  return {
    statusVersion: 9,
    status: "ready",
    base: {
      engineId: "homr",
      displayName: "HOMR",
      artifactChecksumSha256: baseArtifactChecksum,
      unsupportedSemanticClasses: [],
    },
    candidate: {
      engineId: candidateEngineId,
      displayName: candidateName,
      artifactChecksumSha256: candidateArtifactChecksum,
      unsupportedSemanticClasses:
        candidateEngineId === "transcoda" ? ["lyrics"] : [],
    },
    refusalReasons: [],
    geometry: {
      status: "ready",
      geometrySignature,
      refusalReasons: [],
      blocks: [
        {
          status: "ready",
          block: {
            blockIndex: 0,
            stablePartKey: "part-1",
            baseMeasureRefs: [{ measureIndex: 3, measureNumber: "4" }],
            candidateMeasureRefs: [{ measureIndex: 3, measureNumber: "4" }],
            differenceClasses: ["notation", "lyrics"],
            completenessWarnings: [
              {
                engineId: candidateEngineId,
                detail: "Engine does not support lyrics",
              },
            ],
            contentSignature,
          },
        },
      ],
    },
  };
}

describe("PageComparison", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/comparison?")) {
        return {
          ok: true,
          json: async () =>
            readyComparison(
              url.includes("candidateEngine=kraken") ? "kraken" : "transcoda",
            ),
        } as Response;
      }
      if (url.includes("/comparison/readings/")) {
        return {
          ok: true,
          text: async () => '<score-partwise version="4.0"></score-partwise>',
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as jest.Mock;
  });

  afterEach(() => jest.resetAllMocks());

  it("is a doorway to its own page when it is not the page", async () => {
    // Comparing wants the whole window — three scores stacked over a scan — and
    // expanding it inside a card left it competing with the job page's own
    // downloads and previews, below a fold that grew as the readings loaded.
    // The link also gives a comparison a URL to come back to.
    render(<PageComparison jobId="job-1" job={job} page={page} />);

    const link = screen.getByRole("link", { name: "Resolve engine conflicts" });
    expect(link).toHaveAttribute("href", "/scanner/job-1/pages/1/compare");
    // Nothing is fetched until the reader goes there.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("grows the frame to the editor's own height rather than scrolling it", async () => {
    // The rows view does not scroll itself: a scrollable box inside a
    // fixed-height frame gives a reader two scrollbars and the shorter of two
    // viewports. The page's own scrollbar is the point.
    render(<PageComparison jobId="job-1" job={job} page={page} open />);
    const frame = await screen.findByTitle(/Reconciling difference 1 of page 1/);
    expect(frame).not.toHaveStyle({ height: "2400px" });

    fireEvent(
      window,
      new MessageEvent("message", {
        data: { type: "ots-compare-height", height: 2400 },
        origin: window.location.origin,
      }),
    );

    await waitFor(() => expect(frame).toHaveStyle({ height: "2400px" }));
  });

  it("ignores a height from anywhere but this site", async () => {
    render(<PageComparison jobId="job-1" job={job} page={page} open />);
    const frame = await screen.findByTitle(/Reconciling difference 1 of page 1/);

    fireEvent(
      window,
      new MessageEvent("message", {
        data: { type: "ots-compare-height", height: 9000 },
        origin: "https://somewhere.example",
      }),
    );

    expect(frame).not.toHaveStyle({ height: "9000px" });
  });

  it("opens on the first difference that has a place on the scan", async () => {
    // The list beside the editor used to choose it. When that folded into the
    // editor nothing chose it any more, and the editor opened on every system
    // of the page at once — a page-long document to scroll to reach the one
    // thing the reader came for.
    render(<PageComparison jobId="job-1" job={job} page={page} open />);

    const frame = await screen.findByTitle(/Reconciling difference 1 of page 1/);
    const url = new URL(frame.getAttribute("src")!, "http://localhost");
    expect(url.searchParams.get("compareBlock")).toBe("0");
  });

  it("hands the difference to the merge editor and renders no score itself", async () => {
    // The list of differences and the cropped scrap of scan beside it are gone.
    // They were a third and fourth place to look at one difference, and the
    // crop was the same system the editor already draws — cut out and shown
    // again, smaller. What stays here is what the editor cannot say: which
    // engines are being compared, and what each of them does not recognize.
    // As the comparison's own page renders it: there is nothing to expand, so
    // the readings are fetched as soon as it is on screen.
    render(<PageComparison jobId="job-1" job={job} page={page} open />);

    expect(
      await screen.findByTitle(/Reconciling difference 1 of page 1/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Transcoda does not recognize lyrics."),
    ).toBeInTheDocument();
    // Nothing outside the editor names or draws the difference any more.
    expect(screen.queryByText("1 differing block")).toBeNull();
    expect(screen.queryByAltText(/Source evidence/)).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Whole-page diff review" }),
    ).toBeNull();
  });

  it("never engraves a reading itself", async () => {
    // The decision turns on beaming, stem direction, rest placement and
    // accidental spelling — exactly what a second renderer reproduces
    // differently. Judging Transcoda's beaming through OpenSheetMusicDisplay's
    // beaming judged the wrong artifact, so this page draws no score at all:
    // the merge editor draws all three through MuseScore.
    //
    // There is no OSMD mock to assert against any more, because the dependency
    // is gone from the product entirely — a stronger guarantee than a spy.
    // What is asserted here is the observable consequence: no whole MusicXML
    // artifact is fetched just to draw one bar.
    render(<PageComparison jobId="job-1" job={job} page={page} open />);
    // As the comparison's own page renders it.

    await waitFor(() =>
      expect(screen.getByTitle(/Reconciling difference/)).toBeInTheDocument(),
    );
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/comparison/readings/"),
      expect.anything(),
    );
  });

  it("supports a third provider without provider-specific UI branches", async () => {
    render(<PageComparison jobId="job-1" job={job} page={page} open />);
    // As the comparison's own page renders it.
    await screen.findByTitle(/Reconciling difference 1 of page 1/);

    fireEvent.change(screen.getByLabelText("Candidate reading"), {
      target: { value: "kraken" },
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("candidateEngine=kraken"),
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("says a page could not be lined up only when it could not be", async () => {
    // Two different failures used to read "These readings cannot be compared
    // safely": one where the parts never matched, and one where they matched
    // and the scan could not prove where the differences were. Only the first
    // is what that sentence means.
    (globalThis.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...readyComparison(),
        status: "refused",
        analysis: { status: "succeeded", blocks: [] },
        refusalReasons: [{ detail: "Staff 1 boundaries do not prove 4 measure crops" }],
        geometry: { status: "refused", blocks: [], refusalReasons: [] },
      }),
    });
    render(<PageComparison jobId="job-1" job={job} page={page} open />);
    // As the comparison's own page renders it.

    expect(
      await screen.findByText("The differences have no verified image evidence."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("These readings cannot be compared safely."),
    ).toBeNull();
    // The producer's own reason still reaches the reader.
    expect(
      screen.getByText("Staff 1 boundaries do not prove 4 measure crops"),
    ).toBeInTheDocument();
  });

  it("says when one reading was regrouped to line up with the other", async () => {
    // A keyboard page written as one braced part by one engine and as two
    // parts by the other is the same music; the candidate pane is then not
    // literally the file that engine produced, and the reader is told so.
    (globalThis.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...readyComparison(),
        layoutReconciliation: {
          engineId: "transcoda",
          note: "2 single-staff parts were read as 1 part on 2 staves.",
        },
      }),
    });
    render(<PageComparison jobId="job-1" job={job} page={page} open />);
    // As the comparison's own page renders it.

    expect(
      await screen.findByText(/Transcoda was regrouped to line up\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2 single-staff parts were read as 1 part on 2 staves\./),
    ).toBeInTheDocument();
  });

  it("withholds the detail view when the server refuses geometry", async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...readyComparison(),
        geometry: {
          status: "refused",
          blocks: [],
          refusalReasons: [
            { detail: "No verified measure-to-image geometry is available" },
          ],
        },
      }),
    });
    render(<PageComparison jobId="job-1" job={job} page={page} open />);
    // As the comparison's own page renders it.

    expect(
      await screen.findByText(
        "The differences have no verified image evidence.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByAltText(/Source evidence/)).not.toBeInTheDocument();
  });

  it("still reviews the whole page when geometry is refused", async () => {
    // Crops need proven geometry; the whole-page view needs only measure
    // indices, so a page without geometry can still be reviewed side by side.
    (globalThis.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...readyComparison(),
        analysis: {
          status: "succeeded",
          blocks: [
            {
              blockIndex: 0,
              stablePartKey: "part-1",
              baseMeasureRefs: [{ measureIndex: 3, measureNumber: "4" }],
              candidateMeasureRefs: [{ measureIndex: 3, measureNumber: "4" }],
              differenceClasses: ["notation"],
              completenessWarnings: [],
              contentSignature,
            },
          ],
        },
        geometry: {
          status: "refused",
          blocks: [],
          refusalReasons: [
            { detail: "No verified measure-to-image geometry is available" },
          ],
        },
      }),
    });
    render(<PageComparison jobId="job-1" job={job} page={page} open />);
    // As the comparison's own page renders it.

    // Nothing could be placed on the scan, so there is no difference to click —
    // but withholding the editor would leave no way to see the page at all.
    expect(
      await screen.findByRole("heading", { name: "Review the page" }),
    ).toBeInTheDocument();
    expect(screen.getByTitle(/Reviewing page 1/)).toBeInTheDocument();
    // No crops, because nothing proved where those measures are on the scan.
    expect(screen.queryByAltText(/Source evidence/)).not.toBeInTheDocument();
  });

  it("hands the whole page to the score editor's compare embed", async () => {
    // Measure highlighting geometry has one home in this product: MuseScore's
    // layout inside the editor. The scanner links to it rather than rendering
    // the page a second way with its own geometry.
    render(<PageComparison jobId="job-1" job={job} page={page} open />);
    // As the comparison's own page renders it.

    const frame = (await screen.findByTitle(
      /Reconciling difference 1 of page 1/,
    )) as HTMLIFrameElement;
    const url = new URL(frame.src, "http://localhost");
    expect(url.pathname).toBe("/score-editor/index.html");
    // Scoped to the difference the reviewer is looking at, so the agreeing
    // lines below it are not also drawn.
    expect(url.searchParams.get("compareBlock")).toBe("0");
    expect(url.searchParams.get("leftLabel")).toBe("HOMR");
    expect(url.searchParams.get("rightLabel")).toBe("Transcoda");
    // The editor is handed our differences; its own measure signature cannot
    // separate two independently generated documents.
    const regions = new URL(
      String(url.searchParams.get("compareRegions")),
      "http://localhost",
    );
    expect(regions.pathname).toBe(
      "/api/proxy/scanner/jobs/job-1/pages/1/comparison/regions",
    );
    expect(regions.searchParams.get("baseEngine")).toBe("homr");
    expect(regions.searchParams.get("candidateEngine")).toBe("transcoda");
    // Both sides are the signed, status-bound reading routes, so the embed
    // cannot silently read a different revision than the analysis did.
    for (const [param, engineId, checksum] of [
      ["compareLeft", "homr", baseArtifactChecksum],
      ["compareRight", "transcoda", candidateArtifactChecksum],
    ] as const) {
      const reading = new URL(
        String(url.searchParams.get(param)),
        "http://localhost",
      );
      expect(reading.pathname).toBe(
        `/api/proxy/scanner/jobs/job-1/pages/1/comparison/readings/${engineId}`,
      );
      expect(reading.searchParams.get("statusVersion")).toBe("9");
      expect(reading.searchParams.get("artifactChecksumSha256")).toBe(checksum);
      // Both readings are asked for as the comparison lined them up: a
      // candidate whose parts were regrouped onto the base's staves has to
      // arrive regrouped, or its bars are not the bars the blocks name.
      expect(reading.searchParams.get("baseEngine")).toBe("homr");
    }
  });

  it("shows only grounded blocks when page geometry is partial", async () => {
    const partial = readyComparison();
    (globalThis.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...partial,
        geometry: {
          ...partial.geometry,
          status: "refused",
          refusalReasons: [{ detail: "No verified crop maps block 2" }],
          blocks: [
            ...partial.geometry.blocks,
            { status: "refused", block: { ...partial.geometry.blocks[0].block, blockIndex: 1 } },
          ],
        },
      }),
    });
    render(<PageComparison jobId="job-1" job={job} page={page} open />);
    // As the comparison's own page renders it.

    // The count is still stated here, because it is about the page rather than
    // about any one difference: the editor cannot know what it was not sent.
    expect(
      await screen.findByText(/Showing 1 of 2 differing blocks/),
    ).toBeInTheDocument();
    expect(
      screen.getByTitle(/Reconciling difference 1 of page 1/),
    ).toBeInTheDocument();
  });
});
