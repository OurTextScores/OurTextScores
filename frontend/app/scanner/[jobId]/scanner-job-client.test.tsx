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
});
