"use client";

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import PdfViewer from "./pdf-viewer";

// Mock URL.createObjectURL and URL.revokeObjectURL
const mockCreateObjectURL = jest.fn();
const mockRevokeObjectURL = jest.fn();
global.URL.createObjectURL = mockCreateObjectURL;
global.URL.revokeObjectURL = mockRevokeObjectURL;

// Mock fetch
global.fetch = jest.fn();

describe("PdfViewer", () => {
  const workId = "test-work";
  const sourceId = "test-source";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows loading state initially", () => {
    render(<PdfViewer workId={workId} sourceId={sourceId} />);
    expect(screen.getByText("Loading PDF…")).toBeInTheDocument();
  });

  it("loads and displays a PDF successfully", async () => {
    const pdfBlob = new Blob(["pdf content"], { type: "application/pdf" });
    const pdfUrl = "blob:http://localhost/some-uuid";
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      blob: () => Promise.resolve(pdfBlob),
    });
    mockCreateObjectURL.mockReturnValue(pdfUrl);

    render(<PdfViewer workId={workId} sourceId={sourceId} />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/score.pdf`),
        expect.any(Object)
      );
    });

    await waitFor(() => {
      expect(mockCreateObjectURL).toHaveBeenCalledWith(pdfBlob);
    });

    await waitFor(() => {
      const objectElement = screen.getByTestId("pdf-object");
      expect(objectElement).toHaveAttribute("data", pdfUrl);
    });

    expect(screen.queryByText("Loading PDF…")).not.toBeInTheDocument();
  });

  it("shows an error message if fetching fails", async () => {
    const errorMessage = "Unable to fetch PDF";
    (fetch as jest.Mock).mockRejectedValue(new Error(errorMessage));

    render(<PdfViewer workId={workId} sourceId={sourceId} />);

    await waitFor(() => {
      expect(screen.getByText(errorMessage)).toBeInTheDocument();
    });
  });

  it("shows 'No PDF available' if there is no URL", () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
    });
    render(<PdfViewer workId={workId} sourceId={sourceId} />);

    waitFor(() => {
      expect(screen.getByText("No PDF available.")).toBeInTheDocument();
    });
  });
});
