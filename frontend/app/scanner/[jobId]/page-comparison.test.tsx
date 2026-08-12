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

  it("loads a signed evidence crop on demand, and renders no score itself", async () => {
    render(<PageComparison jobId="job-1" job={job} page={page} />);

    expect(globalThis.fetch).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Compare engine readings" }),
    );

    expect(await screen.findByText("1 differing block")).toBeInTheDocument();
    expect(screen.getByText("notes or rhythm, lyrics")).toBeInTheDocument();
    expect(
      screen.getByText("Transcoda does not recognize lyrics."),
    ).toBeInTheDocument();
    expect(
      screen.getByAltText("Source evidence for comparison block 1"),
    ).toHaveAttribute(
      "src",
      `/api/proxy/scanner/jobs/job-1/pages/1/comparison/blocks/0/crop?${new URLSearchParams(
        {
          baseEngine: "homr",
          candidateEngine: "transcoda",
          statusVersion: "9",
          contentSignature,
          geometrySignature,
        },
      ).toString()}`,
    );
    // Which measures the block covers is still stated; the engraving is not
    // drawn here.
    expect(
      screen.getByText(/HOMR: measure 4 · Transcoda: measure 4/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Whole-page diff review" }),
    ).toBeInTheDocument();
  });

  it("never engraves a reading itself", async () => {
    // The decision turns on beaming, stem direction, rest placement and
    // accidental spelling — exactly what a second renderer reproduces
    // differently. Judging Transcoda's beaming through OpenSheetMusicDisplay's
    // beaming judged the wrong artifact, so this page draws no score at all:
    // the merge editor below draws all three through MuseScore.
    //
    // There is no OSMD mock to assert against any more, because the dependency
    // is gone from the product entirely — a stronger guarantee than a spy.
    // What is asserted here is the observable consequence: no whole MusicXML
    // artifact is fetched just to draw one bar.
    render(<PageComparison jobId="job-1" job={job} page={page} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Compare engine readings" }),
    );
    expect(await screen.findByText("1 differing block")).toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Whole-page diff review" }),
      ).toBeInTheDocument(),
    );
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/comparison/readings/"),
      expect.anything(),
    );
  });

  it("states a stale crop refusal instead of a broken image", async () => {
    // The crop is signature-bound, so the server refuses it once the job moves
    // on. An <img> cannot read that refusal, so it must be surfaced here.
    render(<PageComparison jobId="job-1" job={job} page={page} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Compare engine readings" }),
    );

    const crop = await screen.findByAltText(
      "Source evidence for comparison block 1",
    );
    fireEvent.error(crop);

    expect(
      await screen.findByText(/This scan crop is no longer current/),
    ).toBeInTheDocument();
    expect(
      screen.queryByAltText("Source evidence for comparison block 1"),
    ).not.toBeInTheDocument();

    const fetchCount = (globalThis.fetch as jest.Mock).mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: "Reload the comparison" }),
    );
    await waitFor(() =>
      expect(
        (globalThis.fetch as jest.Mock).mock.calls.length,
      ).toBeGreaterThan(fetchCount),
    );
  });

  it("supports a third provider without provider-specific UI branches", async () => {
    render(<PageComparison jobId="job-1" job={job} page={page} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Compare engine readings" }),
    );
    await screen.findByText("1 differing block");

    fireEvent.change(screen.getByLabelText("Candidate reading"), {
      target: { value: "kraken" },
    });

    expect(
      await screen.findByRole("heading", {
        name: "Whole-page diff review",
      }),
    ).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("candidateEngine=kraken"),
      expect.objectContaining({ cache: "no-store" }),
    );
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
    render(<PageComparison jobId="job-1" job={job} page={page} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Compare engine readings" }),
    );

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
    render(<PageComparison jobId="job-1" job={job} page={page} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Compare engine readings" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Whole-page diff review" }),
    ).toBeInTheDocument();
    // No crops, because nothing proved where those measures are on the scan.
    expect(screen.queryByAltText(/Source evidence/)).not.toBeInTheDocument();
  });

  it("hands the whole page to the score editor's compare embed", async () => {
    // Measure highlighting geometry has one home in this product: MuseScore's
    // layout inside the editor. The scanner links to it rather than rendering
    // the page a second way with its own geometry.
    render(<PageComparison jobId="job-1" job={job} page={page} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Compare engine readings" }),
    );

    const frame = (await screen.findByTitle(
      "Whole-page comparison of HOMR and Transcoda",
    )) as HTMLIFrameElement;
    const url = new URL(frame.src, "http://localhost");
    expect(url.pathname).toBe("/score-editor/index.html");
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
    }
  });

  it("shows only grounded blocks when page geometry is partial", async () => {
    const partial = readyComparison();
    (globalThis.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...partial,
        status: "refused",
        refusalReasons: [{ detail: "One comparison span is unresolved" }],
        geometry: {
          ...partial.geometry,
          status: "refused",
          refusalReasons: [{ detail: "One measure has no verified mapping" }],
          blocks: [
            ...partial.geometry.blocks,
            {
              status: "refused",
              block: {
                ...partial.geometry.blocks[0].block,
                blockIndex: 1,
                contentSignature: `scanner-block-content-v2:${"e".repeat(64)}`,
              },
              refusalReasons: [{ detail: "One measure has no verified mapping" }],
            },
          ],
        },
      }),
    });
    render(<PageComparison jobId="job-1" job={job} page={page} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Compare engine readings" }),
    );

    expect(
      await screen.findByText("Some differences have no verified image evidence."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Showing 1 of 2 differing blocks/),
    ).toBeInTheDocument();
    expect(screen.getByText("1 differing block")).toBeInTheDocument();
    expect(
      screen.getByAltText("Source evidence for comparison block 1"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("These readings cannot be compared safely."),
    ).not.toBeInTheDocument();
  });
});
