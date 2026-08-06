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
  pages: [
    {
      pageNumber: 1,
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
});
