"use client";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PageComparison from "./page-comparison";
import { ScannerJob } from "../scanner-types";

const loadScore = jest.fn().mockResolvedValue(undefined);
const renderScore = jest.fn().mockResolvedValue(undefined);
const mockOsmdConstructor = jest.fn().mockImplementation(() => ({
  load: loadScore,
  render: renderScore,
  Zoom: 1,
}));

jest.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: mockOsmdConstructor,
}));

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

  it("loads a signed evidence crop and both engine readings on demand", async () => {
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
      screen.getByRole("heading", { name: "HOMR reading — measure 4" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Transcoda reading — measure 4" }),
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
    await waitFor(() => expect(loadScore).toHaveBeenCalledTimes(2));
    expect(mockOsmdConstructor).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
      expect.objectContaining({
        drawFromMeasureNumber: 4,
        drawUpToMeasureNumber: 4,
      }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `/api/proxy/scanner/jobs/job-1/pages/1/comparison/readings/homr?${new URLSearchParams(
        {
          statusVersion: "9",
          artifactChecksumSha256: baseArtifactChecksum,
        },
      ).toString()}`,
      expect.objectContaining({ cache: "no-store" }),
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
        name: "Kraken OMR reading — measure 4",
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
    expect(loadScore).not.toHaveBeenCalled();
  });
});
