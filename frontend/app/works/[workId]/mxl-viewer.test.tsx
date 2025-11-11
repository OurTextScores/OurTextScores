"use client";

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import MxlViewer from "./mxl-viewer";

// Mock OpenSheetMusicDisplay
const mockLoad = jest.fn();
const mockRender = jest.fn();
const mockOsmd = {
  load: mockLoad,
  render: mockRender,
  Zoom: 1.0,
};
jest.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: jest.fn().mockImplementation(() => mockOsmd),
}));

// Mock fetch
global.fetch = jest.fn();

describe("MxlViewer", () => {
  const workId = "test-work";
  const sourceId = "test-source";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows loading state initially", () => {
    render(<MxlViewer workId={workId} sourceId={sourceId} />);
    expect(screen.getByText("Loading score…")).toBeInTheDocument();
  });

  it("loads and renders a score successfully", async () => {
    const xmlText = "<score-partwise></score-partwise>";
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(xmlText),
    });
    mockLoad.mockResolvedValue(true);

    render(<MxlViewer workId={workId} sourceId={sourceId} />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/canonical.xml`),
        expect.any(Object)
      );
    });

    await waitFor(() => {
      expect(mockLoad).toHaveBeenCalledWith(xmlText);
    });

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled();
    });

    expect(screen.queryByText("Loading score…")).not.toBeInTheDocument();
  });

  it("falls back to normalized.mxl if canonical.xml fails to load", async () => {
    const mxlBuffer = new Uint8Array([1, 2, 3]);
    (fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: false }) // canonical.xml fails
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(mxlBuffer.buffer),
      }); // normalized.mxl succeeds
    mockLoad.mockResolvedValue(true);

    render(<MxlViewer workId={workId} sourceId={sourceId} />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/normalized.mxl`),
        expect.any(Object)
      );
    });

    await waitFor(() => {
      expect(mockLoad).toHaveBeenCalledWith(mxlBuffer);
    });
  });

  it("shows an error message if fetching fails", async () => {
    const errorMessage = "Unable to fetch score";
    (fetch as jest.Mock).mockRejectedValue(new Error(errorMessage));

    render(<MxlViewer workId={workId} sourceId={sourceId} />);

    await waitFor(() => {
      expect(screen.getByText(errorMessage)).toBeInTheDocument();
    });
  });

  it("handles zoom changes", async () => {
    const xmlText = "<score-partwise></score-partwise>";
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(xmlText),
    });
    mockLoad.mockResolvedValue(true);

    render(<MxlViewer workId={workId} sourceId={sourceId} />);

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled();
    });

    const zoomSlider = screen.getByLabelText("Zoom");
    fireEvent.change(zoomSlider, { target: { value: "150" } });

    await waitFor(() => {
      expect(mockOsmd.Zoom).toBe(1.5);
    });

    expect(mockRender).toHaveBeenCalledTimes(2); // Initial render + zoom render
  });
});
