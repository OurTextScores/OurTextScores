"use client";

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ScannerJobClient from "./scanner-job-client";
import { ScannerJob } from "../scanner-types";

const partialJob: ScannerJob = {
  jobId: "job-1",
  status: "partial",
  originalFilename: "two-pages.pdf",
  pageCount: 2,
  includedPageCount: 2,
  pages: [
    {
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
    },
    {
      pageNumber: 2,
      ordinal: 2,
      rotationDegrees: 0,
      included: true,
      status: "failed",
      attempts: 2,
      manualRetries: 0,
      errorCode: "provider_http_503",
      errorMessage: "Scanner provider is temporarily unavailable",
      hasThumbnail: true,
      hasMusicXml: false,
      hasPdf: false,
      canRetry: true,
    },
  ],
  hasMusicXml: true,
  hasPdf: true,
  hasThumbnail: true,
  hasZip: true,
  canRetry: true,
  createdAt: "2026-08-06T12:00:00.000Z",
  updatedAt: "2026-08-06T12:01:00.000Z",
  completedAt: "2026-08-06T12:01:00.000Z",
  resultExpiresAt: "2026-09-05T12:00:00.000Z",
};

describe("ScannerJobClient", () => {
  beforeEach(() => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => partialJob,
    }) as jest.Mock;
  });

  afterEach(() => jest.resetAllMocks());

  it("shows per-page previews and downloads for a partial job", async () => {
    const { container } = render(<ScannerJobClient jobId="job-1" />);

    expect(
      await screen.findByRole("heading", { name: "two-pages.pdf" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Page 1.*Succeeded/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Page 2.*Failed/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Download all results (.zip)" }),
    ).toHaveAttribute("href", "/api/proxy/scanner/jobs/job-1/artifacts/zip");
    expect(
      screen.getByAltText("Source preview for page 1"),
    ).toBeInTheDocument();
    expect(
      container.querySelector('object[type="application/pdf"]'),
    ).toHaveAttribute(
      "data",
      "/api/proxy/scanner/jobs/job-1/artifacts/pdf?page=1",
    );
  });

  it("previews every engine that read the page, each beside the scan", async () => {
    // One preview per engine: comparing an engine against the source should not
    // require holding the other engine's rendering in your head.
    const dualEngineJob: ScannerJob = {
      ...partialJob,
      status: "succeeded",
      enginePlan: {
        primaryEngineId: "homr",
        fallbackEngineIds: ["transcoda"],
        engineIds: ["homr", "transcoda"],
        capabilitySnapshots: {
          homr: { displayName: "HOMR", unsupportedSemanticClasses: [] },
          transcoda: { displayName: "Transcoda", unsupportedSemanticClasses: [] },
        },
      },
      pages: [
        {
          ...partialJob.pages[0],
          engines: {
            homr: {
              status: "succeeded",
              attempts: 1,
              hasMusicXml: true,
              hasPdf: true,
            },
            transcoda: {
              status: "succeeded",
              attempts: 1,
              hasMusicXml: true,
              hasPdf: true,
            },
          },
        },
      ],
    } as ScannerJob;
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => dualEngineJob,
    });

    const { container } = render(<ScannerJobClient jobId="job-1" />);
    expect(await screen.findByText("Scan versus HOMR")).toBeInTheDocument();
    expect(screen.getByText("Scan versus Transcoda")).toBeInTheDocument();

    const previews = [...container.querySelectorAll("object")].map((node) =>
      node.getAttribute("data"),
    );
    expect(previews).toEqual([
      "/api/proxy/scanner/jobs/job-1/artifacts/pdf?page=1&engine=homr",
      "/api/proxy/scanner/jobs/job-1/artifacts/pdf?page=1&engine=transcoda",
    ]);
    // The scan itself is shown against each engine, not just once.
    expect(screen.getAllByAltText("Source preview for page 1")).toHaveLength(2);
  });

  it("queues only the selected failed page", async () => {
    render(<ScannerJobClient jobId="job-1" />);
    const pageTwo = await screen.findByRole("button", {
      name: /Page 2.*Failed/i,
    });
    fireEvent.click(pageTwo);
    fireEvent.click(screen.getByRole("button", { name: "Retry page" }));

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/proxy/scanner/jobs/job-1/pages/2/retry",
        { method: "POST" },
      ),
    );
  });

  it("shows a rescued HOMR failure and Transcoda truncation", async () => {
    const rescued: ScannerJob = {
      ...partialJob,
      status: "succeeded",
      pageCount: 1,
      includedPageCount: 1,
      enginePlan: {
        version: "scanner-engine-plan-v1",
        engineIds: ["homr", "transcoda"],
        primaryEngineId: "homr",
        fallbackEngineIds: ["transcoda"],
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
        },
      },
      pages: [
        {
          ...partialJob.pages[0],
          hasPdf: false,
          canRetry: true,
          errorCode: "provider_http_503",
          errorMessage: "HOMR is temporarily unavailable.",
          engines: {
            homr: {
              status: "failed",
              attempts: 2,
              errorCode: "provider_http_503",
              errorMessage: "HOMR is temporarily unavailable.",
              hasMusicXml: false,
              hasPdf: false,
              hasKern: false,
            },
            transcoda: {
              status: "succeeded",
              attempts: 1,
              hasMusicXml: true,
              hasPdf: false,
              hasKern: true,
              generation: {
                hitMaxLength: true,
                sawEos: false,
                truncated: true,
                maxLength: 2048,
              },
            },
          },
        },
      ],
    };
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => rescued,
    });

    render(<ScannerJobClient jobId="job-1" />);

    expect(
      await screen.findByText(/available MusicXML comes from Transcoda/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/reached its generation limit/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry HOMR" }),
    ).toBeInTheDocument();
  });

  it("shows the active engine instead of presenting Transcoda time as rendering", async () => {
    const activeJob: ScannerJob = {
      ...partialJob,
      status: "running",
      pageCount: 1,
      includedPageCount: 1,
      enginePlan: {
        version: "scanner-engine-plan-v1",
        engineIds: ["homr", "transcoda"],
        primaryEngineId: "homr",
        fallbackEngineIds: ["transcoda"],
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
        },
      },
      pages: [
        {
          ...partialJob.pages[0],
          status: "succeeded",
          hasPdf: false,
          effectiveEngineId: "homr",
          engines: {
            homr: {
              status: "succeeded",
              attempts: 1,
              hasMusicXml: true,
              hasPdf: false,
              hasKern: false,
            },
            transcoda: {
              status: "running",
              attempts: 0,
              hasMusicXml: false,
              hasPdf: false,
              hasKern: false,
            },
          },
        },
      ],
      hasPdf: false,
      hasZip: false,
      completedAt: undefined,
    };
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => activeJob,
    });

    render(<ScannerJobClient jobId="job-1" />);

    expect(
      await screen.findByText("Transcoda is recognizing page 1 of 1…"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", {
        name: "Recognition and preview progress",
      }),
    ).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuemax",
      "3",
    );
    expect(
      screen.getByText(/HOMR MusicXML is already available/),
    ).toHaveTextContent("Transcoda is still recognizing this page");
    expect(
      screen.getAllByRole("link", { name: "Download MusicXML" }),
    ).not.toHaveLength(0);
  });

  it("names the preview stage only after every recognition engine is terminal", async () => {
    const renderingJob: ScannerJob = {
      ...partialJob,
      status: "rendering",
      pageCount: 1,
      includedPageCount: 1,
      enginePlan: {
        version: "scanner-engine-plan-v1",
        engineIds: ["homr", "transcoda"],
        primaryEngineId: "homr",
        fallbackEngineIds: ["transcoda"],
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
            unsupportedSemanticClasses: [],
          },
        },
      },
      pages: [
        {
          ...partialJob.pages[0],
          hasPdf: false,
          engines: {
            homr: {
              status: "succeeded",
              attempts: 1,
              hasMusicXml: true,
              hasPdf: false,
              hasKern: false,
            },
            transcoda: {
              status: "succeeded",
              attempts: 1,
              hasMusicXml: true,
              hasPdf: false,
              hasKern: true,
            },
          },
        },
      ],
      hasPdf: false,
      completedAt: undefined,
    };
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => renderingJob,
    });

    render(<ScannerJobClient jobId="job-1" />);

    expect(
      await screen.findByText("Rendering preview for page 1…"),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "2",
    );
  });

  it("uses persisted engine policy for fallback and completeness warnings", async () => {
    const rescued: ScannerJob = {
      ...partialJob,
      status: "succeeded",
      pageCount: 1,
      includedPageCount: 1,
      enginePlan: {
        version: "scanner-engine-plan-v1",
        engineIds: ["audiveris-5", "kraken"],
        primaryEngineId: "audiveris-5",
        fallbackEngineIds: ["kraken"],
        capabilitySnapshots: {
          "audiveris-5": {
            displayName: "Audiveris 5",
            outputArtifactKinds: ["musicxml"],
            supportsSpotReview: false,
            supportsMeasureGeometry: false,
            unsupportedSemanticClasses: [],
          },
          kraken: {
            displayName: "Kraken OMR",
            outputArtifactKinds: ["musicxml"],
            supportsSpotReview: false,
            supportsMeasureGeometry: false,
            unsupportedSemanticClasses: ["lyrics"],
          },
        },
      },
      pages: [
        {
          ...partialJob.pages[0],
          effectiveEngineId: "kraken",
          hasPdf: false,
          canRetry: true,
          engines: {
            "audiveris-5": {
              status: "failed",
              attempts: 2,
              errorMessage: "Audiveris is temporarily unavailable.",
              hasMusicXml: false,
              hasPdf: false,
              hasKern: false,
            },
            kraken: {
              status: "succeeded",
              attempts: 1,
              hasMusicXml: true,
              hasPdf: false,
              hasKern: false,
              completeness: "possibly-incomplete",
            },
          },
        },
      ],
    };
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => rescued,
    });

    render(<ScannerJobClient jobId="job-1" />);

    expect(
      await screen.findByText(/available MusicXML comes from Kraken OMR/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Kraken OMR reported.*may be incomplete/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Kraken OMR does not recognize lyrics/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry Audiveris 5" }),
    ).toBeInTheDocument();
  });

  it("saves page review choices before explicitly starting inference", async () => {
    const readyJob: ScannerJob = {
      ...partialJob,
      status: "ready",
      includedPageCount: 2,
      pages: partialJob.pages.map((page) => ({
        ...page,
        status: "pending",
        attempts: 0,
        errorCode: undefined,
        errorMessage: undefined,
        hasMusicXml: false,
        hasPdf: false,
        canRetry: false,
      })),
      hasMusicXml: false,
      hasPdf: false,
      hasZip: false,
      canRetry: false,
    };
    const queuedJob: ScannerJob = { ...readyJob, status: "queued" };
    (globalThis.fetch as jest.Mock).mockImplementation(
      async (url: string, init?: RequestInit) => ({
        ok: true,
        json: async () =>
          init?.method === "POST" && url.endsWith("/start")
            ? queuedJob
            : readyJob,
      }),
    );

    render(<ScannerJobClient jobId="job-1" />);
    expect(
      await screen.findByRole("heading", {
        name: "Review pages before scanning",
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Rotate source page 1 right" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Move source page 2 earlier" }),
    );
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Include" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Start scanning" }));

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/proxy/scanner/jobs/job-1/pages",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    const configureCall = (globalThis.fetch as jest.Mock).mock.calls.find(
      ([url, init]) =>
        url === "/api/proxy/scanner/jobs/job-1/pages" &&
        init?.method === "PATCH",
    );
    expect(JSON.parse(configureCall[1].body)).toEqual({
      pages: [
        {
          pageNumber: 2,
          ordinal: 1,
          rotationDegrees: 0,
          included: false,
        },
        {
          pageNumber: 1,
          ordinal: 2,
          rotationDegrees: 90,
          included: true,
        },
      ],
    });
    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/proxy/scanner/jobs/job-1/start",
        { method: "POST" },
      ),
    );
  });
  it("offers the combined score only when assembly succeeded", async () => {
    const merged: ScannerJob = {
      ...partialJob,
      status: "succeeded",
      pages: partialJob.pages.map((page) => ({
        ...page,
        status: "succeeded",
        hasMusicXml: true,
        hasPdf: true,
        canRetry: false,
        errorCode: undefined,
        errorMessage: undefined,
      })),
      mergeStatus: "succeeded",
      hasCombinedMusicXml: true,
      hasCombinedPdf: true,
    };
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => merged }) as jest.Mock;
    render(<ScannerJobClient jobId="job-1" />);

    expect(
      await screen.findByRole("link", { name: "Download combined MusicXML" }),
    ).toHaveAttribute(
      "href",
      "/api/proxy/scanner/jobs/job-1/artifacts/musicxml",
    );
    expect(
      screen.getByRole("link", { name: "Open combined score in Score Editor" }),
    ).toBeInTheDocument();
    // The beta caveat must travel with the download, not be buried elsewhere.
    expect(screen.getByText(/Page assembly is in beta/)).toBeInTheDocument();
  });

  it("explains a declined assembly without hiding the per-page results", async () => {
    const declined: ScannerJob = {
      ...partialJob,
      status: "succeeded",
      pages: partialJob.pages.map((page) => ({
        ...page,
        status: "succeeded",
        hasMusicXml: true,
        hasPdf: true,
        canRetry: false,
        errorCode: undefined,
        errorMessage: undefined,
      })),
      mergeStatus: "incompatible",
      mergeReason: "Part 1 changes from 2 to 1 staves on page 2",
      hasCombinedMusicXml: false,
    };
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => declined }) as jest.Mock;
    render(<ScannerJobClient jobId="job-1" />);

    expect(
      await screen.findByRole("link", { name: "Download all results (.zip)" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Download combined MusicXML" }),
    ).toBeNull();
    // The reason is interpolated, so the sentence spans several text nodes.
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === "P" &&
          (element.textContent || "").includes(
            "Part 1 changes from 2 to 1 staves on page 2",
          ),
      ),
    ).toBeInTheDocument();
  });
});
