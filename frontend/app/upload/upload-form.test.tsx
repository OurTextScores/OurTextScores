"use client";

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import UploadForm from "./upload-form";
import { useRouter } from "next/navigation";
import { ensureWork, resolveImslpUrl, searchImslp, getPublicApiBase } from "../lib/api";
import { initSteps, applyEventToSteps } from "../components/progress-steps";
import React from "react";

// Mock next/navigation
jest.mock("next/navigation", () => ({
  useRouter: jest.fn(),
}));

// Mock ../lib/api
jest.mock("../lib/api", () => ({
  ensureWork: jest.fn(),
  resolveImslpUrl: jest.fn(),
  searchImslp: jest.fn(),
  getPublicApiBase: jest.fn(() => "http://localhost:4000"),
}));

// Mock ../components/progress-steps
jest.mock("../components/progress-steps", () => ({
  initSteps: jest.fn(() => []),
  applyEventToSteps: jest.fn((steps, stage, startedAt) => steps),
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

// Mock EventSource
class MockEventSource {
  url: string;
  listeners: { [key: string]: Function[] } = {};
  static instances: MockEventSource[] = [];

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(event: string, callback: Function) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }
  removeEventListener(event: string, callback: Function) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
    }
  }
  close() {
    // Mock close
  }
  // Helper to simulate events
  _simulateEvent(event: string, data: any) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((cb) => cb({ data: JSON.stringify(data) }));
    }
  }
}
(global as any).EventSource = MockEventSource;


describe("UploadForm", () => {
  const mockRouterPush = jest.fn();
  const mockExistingWorks = [
    { workId: "work1", title: "Work One", sourceCount: 1, availableFormats: [] },
  ];

  // Helper to set file input properly using userEvent
  const setFileInput = async (input: HTMLInputElement, file: File) => {
    // Create a proper FileList-like object
    const fileList = Object.create(FileList.prototype);
    Object.defineProperty(fileList, '0', { value: file });
    Object.defineProperty(fileList, 'length', { value: 1 });
    Object.defineProperty(fileList, 'item', {
      value: function (index: number) { return index === 0 ? file : null; }
    });

    Object.defineProperty(input, 'files', {
      value: fileList,
      writable: false,
      configurable: true,
    });

    // Trigger the onChange event with proper structure
    const changeEvent = new Event('change', { bubbles: true });
    Object.defineProperty(changeEvent, 'target', {
      value: { files: fileList },
      writable: false,
    });

    fireEvent.change(input, { target: { files: fileList } });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (MockEventSource as any).instances = [];
    (useRouter as jest.Mock).mockReturnValue({ push: mockRouterPush, refresh: jest.fn() });

    // Default mock for global.fetch to handle source/branch loading in UploadStep
    global.fetch = jest.fn((url) => {
      if (url.toString().includes('/works/work1/sources/source1/branches')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ branches: [{ name: 'main' }, { name: 'development' }] }),
        } as Response);
      }
      if (url.toString().includes('/works/work1')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            sources: [{ sourceId: "source1", label: "Source Label 1" }]
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
  });

  it("renders the 'select' step initially", () => {
    render(<UploadForm works={mockExistingWorks} />);
    expect(screen.getByText(/Step 1 — Select IMSLP work/i)).toBeInTheDocument();
    expect(screen.queryByText(/Step 2 — Upload source/i)).not.toBeInTheDocument();
  });

  it("transitions to 'upload' step when a work is resolved via URL", async () => {
    (resolveImslpUrl as jest.Mock).mockResolvedValue({
      work: { workId: "work-url", sourceCount: 0, availableFormats: [] },
      metadata: { workId: "work-url", title: "Work from URL", composer: "Composer B", permalink: "http://imslp.org/work-url" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const resolveButton = screen.getByRole("button", { name: /Resolve URL/i });

    fireEvent.change(urlInput, { target: { value: "http://imslp.org/wiki/WorkFromURL" } });
    fireEvent.click(resolveButton);

    await waitFor(() => {
      expect(resolveImslpUrl).toHaveBeenCalledWith("http://imslp.org/wiki/WorkFromURL");
      expect(screen.getByText(/Step 2 — Upload source for Work from URL/i)).toBeInTheDocument();
      expect(screen.queryByText(/Step 1 — Select IMSLP work/i)).not.toBeInTheDocument();
    });
  });

  it("transitions back to 'select' step when 'Choose different work' is clicked", async () => {
    (resolveImslpUrl as jest.Mock).mockResolvedValue({
      work: { workId: "work-url", sourceCount: 0, availableFormats: [] },
      metadata: { workId: "work-url", title: "Work from URL", composer: "Composer B", permalink: "http://imslp.org/work-url" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    // First, transition to upload step via URL
    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const resolveButton = screen.getByRole("button", { name: /Resolve URL/i });
    fireEvent.change(urlInput, { target: { value: "http://imslp.org/wiki/WorkFromURL" } });
    fireEvent.click(resolveButton);

    await waitFor(() => {
      expect(screen.getByText(/Step 2 — Upload source for Work from URL/i)).toBeInTheDocument();
    });

    // Then, click "Choose different work"
    const chooseDifferentWorkButton = screen.getByRole("button", { name: /Choose different work/i });
    fireEvent.click(chooseDifferentWorkButton);

    await waitFor(() => {
      expect(screen.getByText(/Step 1 — Select IMSLP work/i)).toBeInTheDocument();
      expect(screen.queryByText(/Step 2 — Upload source/i)).not.toBeInTheDocument();
    });
  });

  it("displays an error message if URL resolution fails", async () => {
    const errorMessage = "Invalid IMSLP URL";
    (resolveImslpUrl as jest.Mock).mockRejectedValue(new Error(errorMessage));

    render(<UploadForm works={mockExistingWorks} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const resolveButton = screen.getByRole("button", { name: /Resolve URL/i });

    fireEvent.change(urlInput, { target: { value: "invalid-url" } });
    fireEvent.click(resolveButton);

    await waitFor(() => {
      expect(screen.getByText(errorMessage)).toBeInTheDocument();
    });
  });

  it("renders upload form with all required fields", async () => {
    (resolveImslpUrl as jest.Mock).mockResolvedValue({
      work: { workId: "work-url", sourceCount: 0, availableFormats: [] },
      metadata: { workId: "work-url", title: "Work from URL", composer: "Composer B", permalink: "http://imslp.org/work-url" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const resolveButton = screen.getByRole("button", { name: /Resolve URL/i });
    fireEvent.change(urlInput, { target: { value: "http://imslp.org/wiki/WorkFromURL" } });
    fireEvent.click(resolveButton);

    await waitFor(() => {
      expect(screen.getByText(/Step 2 — Upload source for Work from URL/i)).toBeInTheDocument();
    });

    // Verify all form fields are present
    expect(screen.getByLabelText(/Description \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Commit message \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Target/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Score file/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload source/i })).toBeInTheDocument();
  });

  it("requires file input to have required attribute", async () => {
    (resolveImslpUrl as jest.Mock).mockResolvedValue({
      work: { workId: "work-url", sourceCount: 0, availableFormats: [] },
      metadata: { workId: "work-url", title: "Work from URL", composer: "Composer B", permalink: "http://imslp.org/work-url" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const resolveButton = screen.getByRole("button", { name: /Resolve URL/i });
    fireEvent.change(urlInput, { target: { value: "http://imslp.org/wiki/WorkFromURL" } });
    fireEvent.click(resolveButton);

    await waitFor(() => {
      expect(screen.getByText(/Step 2 — Upload source for Work from URL/i)).toBeInTheDocument();
    });

    // Verify the file input has required attribute for HTML5 validation
    const fileInput = screen.getByLabelText(/Score file/i);
    expect(fileInput).toHaveAttribute('required');
    expect(fileInput).toHaveAttribute('accept', '.mscz,.mscx,.mxl,.xml');
  });

  it("requires copyright certification when license is All Rights Reserved", async () => {
    (resolveImslpUrl as jest.Mock).mockResolvedValue({
      work: { workId: "work-url", sourceCount: 0, availableFormats: [] },
      metadata: { workId: "work-url", title: "Work from URL", composer: "Composer B", permalink: "http://imslp.org/work-url" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const resolveButton = screen.getByRole("button", { name: /Resolve URL/i });
    fireEvent.change(urlInput, { target: { value: "http://imslp.org/wiki/WorkFromURL" } });
    fireEvent.click(resolveButton);

    await waitFor(() => {
      expect(screen.getByText(/Step 2 — Upload source for Work from URL/i)).toBeInTheDocument();
    });

    const fileInput = screen.getByLabelText(/Score file/i);
    const file = new File(["content"], "test.mxl", { type: "application/octet-stream" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    const licenseSelect = screen.getByLabelText(/License \(optional\)/i);
    fireEvent.change(licenseSelect, { target: { value: "All Rights Reserved" } });

    const uploadButton = screen.getByRole("button", { name: /Upload source/i });
    expect(uploadButton).toBeDisabled();

    const certCheckbox = screen.getByRole("checkbox", {
      name: /I certify that I have permission from the copyright holder to upload this work\./i
    });
    fireEvent.click(certCheckbox);

    expect(uploadButton).not.toBeDisabled();
  });

  it("allows selecting an existing source for revision", async () => {
    (resolveImslpUrl as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const resolveButton = screen.getByRole("button", { name: /Resolve URL/i });
    fireEvent.change(urlInput, { target: { value: "http://imslp.org/wiki/Work1" } });
    fireEvent.click(resolveButton);

    await waitFor(() => {
      expect(screen.getByText(/Step 2 — Upload source for Work One/i)).toBeInTheDocument();
    });

    // Wait for the useEffect that fetches sources to complete
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/works/work1"));
    });

    const targetSourceSelect = screen.getByLabelText(/Target/i);
    fireEvent.change(targetSourceSelect, { target: { value: "source1" } });

    await waitFor(() => {
      expect(screen.getByText(/Append to: Source Label 1 \(source1\)/i)).toBeInTheDocument();
    });

    // Verify upload button is still present (always says "Upload source")
    expect(screen.getByRole("button", { name: /Upload source/i })).toBeInTheDocument();
  });

  it("shows branch creation UI for existing source", async () => {
    (resolveImslpUrl as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const resolveButton = screen.getByRole("button", { name: /Resolve URL/i });
    fireEvent.change(urlInput, { target: { value: "http://imslp.org/wiki/Work1" } });
    fireEvent.click(resolveButton);

    await waitFor(() => {
      expect(screen.getByText(/Step 2 — Upload source for Work One/i)).toBeInTheDocument();
    });

    // Wait for the useEffect that fetches sources to complete
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/works/work1"));
    });

    const targetSourceSelect = screen.getByLabelText(/Target/i);
    fireEvent.change(targetSourceSelect, { target: { value: "source1" } });

    await waitFor(() => {
      expect(screen.getByText(/Append to: Source Label 1 \(source1\)/i)).toBeInTheDocument();
    });

    const createBranchCheckbox = screen.getByLabelText(/Create new branch/i);
    fireEvent.click(createBranchCheckbox);

    // Verify branch name input appears when checkbox is checked
    const branchNameInput = screen.getByPlaceholderText(/branch name/i);
    expect(branchNameInput).toBeInTheDocument();
    expect(branchNameInput).toHaveValue("");
  });

  it("shows error when trying to resolve empty URL", async () => {
    render(<UploadForm works={mockExistingWorks} />);

    const resolveButton = screen.getByRole("button", { name: /Resolve URL/i });
    fireEvent.click(resolveButton);

    await waitFor(() => {
      expect(screen.getByText(/Please paste an IMSLP URL or slug./i)).toBeInTheDocument();
    });
  });

  it("allows selecting between existing branches", async () => {
    (resolveImslpUrl as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const resolveButton = screen.getByRole("button", { name: /Resolve URL/i });
    fireEvent.change(urlInput, { target: { value: "http://imslp.org/wiki/Work1" } });
    fireEvent.click(resolveButton);

    await waitFor(() => {
      expect(screen.getByText(/Step 2 — Upload source for Work One/i)).toBeInTheDocument();
    });

    // Wait for sources to load
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/works/work1"));
    });

    const targetSourceSelect = screen.getByLabelText(/Target/i);
    fireEvent.change(targetSourceSelect, { target: { value: "source1" } });

    // Wait for branches to load
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/works/work1/sources/source1/branches"));
    });

    // Check if branch select is present
    const branchSelect = screen.getByLabelText(/Branch/i);
    expect(branchSelect).toBeInTheDocument();

    // Select a different branch
    fireEvent.change(branchSelect, { target: { value: "development" } });

    await waitFor(() => {
      expect((branchSelect as HTMLSelectElement).value).toBe("development");
    });
  });

  it("displays the IMSLP permalink in upload step", async () => {
    (resolveImslpUrl as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const resolveButton = screen.getByRole("button", { name: /Resolve URL/i });
    fireEvent.change(urlInput, { target: { value: "http://imslp.org/wiki/Work1" } });
    fireEvent.click(resolveButton);

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /http:\/\/imslp.org\/work1/i });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "http://imslp.org/work1");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });
  });

  it("displays composer information when available", async () => {
    (resolveImslpUrl as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Ludwig van Beethoven", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const resolveButton = screen.getByRole("button", { name: /Resolve URL/i });
    fireEvent.change(urlInput, { target: { value: "http://imslp.org/wiki/Work1" } });
    fireEvent.click(resolveButton);

    await waitFor(() => {
      expect(screen.getByText(/Composer: Ludwig van Beethoven/i)).toBeInTheDocument();
    });
  });

  it("updates step indicator when transitioning between steps", async () => {
    (resolveImslpUrl as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    const { container } = render(<UploadForm works={mockExistingWorks} />);

    // Check step 1 is active initially
    const indicators = container.querySelectorAll("ol.flex li");
    expect(indicators[0]).toHaveClass("text-primary-600");
    expect(indicators[2]).toHaveClass("text-slate-500");

    // Select a work via URL
    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const resolveButton = screen.getByRole("button", { name: /Resolve URL/i });
    fireEvent.change(urlInput, { target: { value: "http://imslp.org/wiki/Work1" } });
    fireEvent.click(resolveButton);

    await waitFor(() => {
      expect(screen.getByText(/Step 2 — Upload source for Work One/i)).toBeInTheDocument();
    });

    // Check step 2 is now active
    const updatedIndicators = container.querySelectorAll("ol.flex li");
    expect(updatedIndicators[2]).toHaveClass("text-primary-600");
  });

  it("enables upload button when a file is selected and submission is idle", async () => {
    (resolveImslpUrl as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/imslp.org\/wiki\//i);
    const resolveButton = screen.getByRole("button", { name: /Resolve URL/i });
    fireEvent.change(urlInput, { target: { value: "http://imslp.org/wiki/Work1" } });
    fireEvent.click(resolveButton);

    await waitFor(() => {
      expect(screen.getByText(/Step 2 — Upload source for Work One/i)).toBeInTheDocument();
    });

    const fileInput = screen.getByLabelText(/Score file/i);
    const file = new File(["content"], "test.mxl", { type: "application/octet-stream" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    const uploadButton = screen.getByRole("button", { name: /Upload source/i });
    expect(uploadButton).not.toBeDisabled();
  });


});
