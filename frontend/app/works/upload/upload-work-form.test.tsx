"use client";

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import UploadWorkForm from "./upload-work-form";
import { resolveImslpUrl } from "../../lib/api";
import React from "react";

// Mock dependencies
jest.mock("../../lib/api", () => ({
  resolveImslpUrl: jest.fn(),
}));

// Mock useTransition to be a simple useState
jest.mock("react", () => {
  const originalModule = jest.requireActual("react");
  return {
    ...originalModule,
    useTransition: () => {
      const [isPending, setIsPending] = originalModule.useState(false);
      const startTransition = (callback) => {
        setIsPending(true);
        callback().finally(() => setIsPending(false));
      };
      return [isPending, startTransition];
    },
  };
});

describe("UploadWorkForm", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the form", () => {
    render(<UploadWorkForm />);
    expect(screen.getByRole("heading", { name: /Save IMSLP work/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save work/i })).toBeInTheDocument();
  });

  it("shows an error if the URL is empty", async () => {
    render(<UploadWorkForm />);
    const saveButton = screen.getByRole("button", { name: /Save work/i });
    fireEvent.click(saveButton);
    expect(await screen.findByText(/Please enter an IMSLP work URL/i)).toBeInTheDocument();
  });

  it("calls resolveImslpUrl and shows success on valid URL", async () => {
    const mockResponse = {
      work: { workId: "test-work", sourceCount: 0, availableFormats: [] },
      metadata: { workId: "test-work", title: "Test Work", composer: "Test Composer" },
    };
    (resolveImslpUrl as jest.Mock).mockResolvedValue(mockResponse);

    render(<UploadWorkForm />);
    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const saveButton = screen.getByRole("button", { name: /Save work/i });

    fireEvent.change(urlInput, { target: { value: "https://imslp.org/wiki/Test" } });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(resolveImslpUrl).toHaveBeenCalledWith("https://imslp.org/wiki/Test");
    });

    await waitFor(() => {
      expect(screen.getByText(/Work test-work is ready for uploads/i)).toBeInTheDocument();
    });

    expect(screen.getByText("Test Work")).toBeInTheDocument();
    expect(screen.getByText("Test Composer")).toBeInTheDocument();
  });

  it("shows an error message on API failure", async () => {
    const errorMessage = "Failed to resolve URL";
    (resolveImslpUrl as jest.Mock).mockRejectedValue(new Error(errorMessage));

    render(<UploadWorkForm />);
    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const saveButton = screen.getByRole("button", { name: /Save work/i });

    fireEvent.change(urlInput, { target: { value: "https://imslp.org/wiki/Invalid" } });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText(errorMessage)).toBeInTheDocument();
    });
  });

  it("resets the form when 'Save another work' is clicked", async () => {
    const mockResponse = {
      work: { workId: "test-work", sourceCount: 0, availableFormats: [] },
      metadata: { workId: "test-work", title: "Test Work", composer: "Test Composer" },
    };
    (resolveImslpUrl as jest.Mock).mockResolvedValue(mockResponse);

    render(<UploadWorkForm />);
    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const saveButton = screen.getByRole("button", { name: /Save work/i });

    fireEvent.change(urlInput, { target: { value: "https://imslp.org/wiki/Test" } });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText(/Work test-work is ready for uploads/i)).toBeInTheDocument();
    });

    const resetButton = screen.getByRole("button", { name: /Save another work/i });
    fireEvent.click(resetButton);

    await waitFor(() => {
      expect(screen.queryByText(/Work test-work is ready for uploads/i)).not.toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /Save work/i })).toBeInTheDocument();
  });
});
