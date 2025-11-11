"use client";

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import CopyDownload from "./copy-download";

// Mock clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: jest.fn(),
  },
});

// Mock URL.createObjectURL and URL.revokeObjectURL
const mockCreateObjectURL = jest.fn();
const mockRevokeObjectURL = jest.fn();
global.URL.createObjectURL = mockCreateObjectURL;
global.URL.revokeObjectURL = mockRevokeObjectURL;

describe("CopyDownload", () => {
  const text = "test content";
  const filename = "test.txt";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the copy and download buttons", () => {
    render(<CopyDownload text={text} filename={filename} />);
    expect(screen.getByRole("button", { name: /Copy/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download/i })).toBeInTheDocument();
  });

  it("copies the text to the clipboard when copy is clicked", async () => {
    render(<CopyDownload text={text} filename={filename} />);
    const copyButton = screen.getByRole("button", { name: /Copy/i });
    fireEvent.click(copyButton);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(text);
  });

  it("downloads the text as a file when download is clicked", () => {
    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    
    render(<CopyDownload text={text} filename={filename} />);
    const downloadButton = screen.getByRole("button", { name: /Download/i });
    fireEvent.click(downloadButton);

    expect(mockCreateObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(mockRevokeObjectURL).toHaveBeenCalled();

    clickSpy.mockRestore();
  });
});
