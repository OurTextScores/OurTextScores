"use client";

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import UploadRevisionForm from "./upload-revision-form";
import { useRouter } from "next/navigation";

// Mock dependencies
global.fetch = jest.fn();
const mockEventSource = {
  addEventListener: jest.fn(),
  close: jest.fn(),
};
global.EventSource = jest.fn(() => mockEventSource) as any;
global.crypto.randomUUID = jest.fn(() => "test-uuid");

describe("UploadRevisionForm", () => {
  const workId = "test-work";
  const sourceId = "test-source";
  const mockRouter = {
    refresh: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue(mockRouter);
  });

  it("renders the form", () => {
    render(<UploadRevisionForm workId={workId} sourceId={sourceId} />);
    expect(screen.getByRole("button", { name: /Upload new revision/i })).toBeInTheDocument();
  });

  it("disables the upload button if no file is selected", () => {
    render(<UploadRevisionForm workId={workId} sourceId={sourceId} />);
    const uploadButton = screen.getByRole("button", { name: /Upload new revision/i });
    expect(uploadButton).toBeDisabled();
  });

  it("enables the upload button when a file is selected", async () => {
    render(<UploadRevisionForm workId={workId} sourceId={sourceId} />);
    const fileInput = screen.getByTestId("file-input");
    const uploadButton = screen.getByRole("button", { name: /Upload new revision/i });

    const file = new File(["content"], "test.mxl", { type: "application/octet-stream" });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    expect(uploadButton).toBeEnabled();
  });

  it("requires copyright certification when license is All Rights Reserved", async () => {
    render(<UploadRevisionForm workId={workId} sourceId={sourceId} />);
    const fileInput = screen.getByTestId("file-input");
    const uploadButton = screen.getByRole("button", { name: /Upload new revision/i });

    const file = new File(["content"], "test.mxl", { type: "application/octet-stream" });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    const licenseSelect = screen.getByDisplayValue("No license specified");
    fireEvent.change(licenseSelect, { target: { value: "All Rights Reserved" } });

    expect(uploadButton).toBeDisabled();
    expect(
      screen.getByText(/I certify that I have permission from the copyright holder to upload this work\./i)
    ).toBeInTheDocument();

    const certCheckbox = screen.getByRole("checkbox", {
      name: /I certify that I have permission from the copyright holder to upload this work\./i
    });
    fireEvent.click(certCheckbox);

    expect(uploadButton).toBeEnabled();
  });

  it("uploads a file to trunk successfully", async () => {
    jest.useFakeTimers();
    (fetch as jest.Mock).mockResolvedValue({ ok: true });
    const file = new File(["content"], "test.mxl", { type: "application/octet-stream" });

    render(<UploadRevisionForm workId={workId} sourceId={sourceId} />);
    const fileInput = screen.getByTestId("file-input");
    const uploadButton = screen.getByRole("button", { name: /Upload new revision/i });

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });
    fireEvent.click(uploadButton);

    await waitFor(() => {
      const uploadCall = (fetch as jest.Mock).mock.calls.find((call) =>
        String(call[0]).includes(`/works/${workId}/sources/${sourceId}/revisions`)
      );
      expect(uploadCall).toBeTruthy();
      expect(uploadCall?.[0]).toBe(`http://localhost:4000/api/works/${workId}/sources/${sourceId}/revisions`);
      expect(uploadCall?.[1]).toEqual(
        expect.objectContaining({
          method: "POST",
          headers: { "X-Progress-Id": "test-uuid" },
        })
      );
    });

    jest.advanceTimersByTime(5000);
    expect(mockRouter.refresh).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it("uploads a file to a new branch", async () => {
    (fetch as jest.Mock).mockResolvedValue({ ok: true });
    const file = new File(["content"], "test.mxl", { type: "application/octet-stream" });

    render(<UploadRevisionForm workId={workId} sourceId={sourceId} />);
    const fileInput = screen.getByTestId("file-input");
    const newBranchRadio = screen.getByLabelText(/new/i);
    const uploadButton = screen.getByRole("button", { name: /Upload new revision/i });

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });
    fireEvent.click(newBranchRadio);
    const branchNameInput = screen.getByPlaceholderText("Branch Name");
    fireEvent.change(branchNameInput, { target: { value: "new-branch" } });
    fireEvent.click(uploadButton);

    await waitFor(() => {
      const uploadCall = (fetch as jest.Mock).mock.calls.find((call) =>
        String(call[0]).includes(`/works/${workId}/sources/${sourceId}/revisions`)
      );
      expect(uploadCall).toBeTruthy();
      const formData = uploadCall?.[1]?.body as FormData;
      expect(formData.get("createBranch")).toBe("true");
      expect(formData.get("branchName")).toBe("new-branch");
    });
  });

  it("shows an error message on upload failure", async () => {
    const errorMessage = "Upload failed";
    (fetch as jest.Mock).mockResolvedValue({
      ok: false,
      text: () => Promise.resolve(errorMessage),
    });
    const file = new File(["content"], "test.mxl", { type: "application/octet-stream" });

    render(<UploadRevisionForm workId={workId} sourceId={sourceId} />);
    const fileInput = screen.getByTestId("file-input");
    const uploadButton = screen.getByRole("button", { name: /Upload new revision/i });

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });
    fireEvent.click(uploadButton);

    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
  });
});
