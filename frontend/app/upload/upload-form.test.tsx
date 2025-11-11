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
      value: function(index: number) { return index === 0 ? file : null; }
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

  it("transitions to 'upload' step when a work is selected from existing works", async () => {
    (ensureWork as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    // Select an existing work
    const existingWorkButton = screen.getByRole("button", { name: /work1 ID: work1/i });
    fireEvent.click(existingWorkButton);

    await waitFor(() => {
      expect(ensureWork).toHaveBeenCalledWith("work1");
      expect(screen.getByText(/Step 2 — Upload source for Work One/i)).toBeInTheDocument();
      expect(screen.queryByText(/Step 1 — Select IMSLP work/i)).not.toBeInTheDocument();
    });
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
    (ensureWork as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    // First, transition to upload step
    const existingWorkButton = screen.getByRole("button", { name: /work1 ID: work1/i });
    fireEvent.click(existingWorkButton);

    await waitFor(() => {
      expect(screen.getByText(/Step 2 — Upload source for Work One/i)).toBeInTheDocument();
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
    // Mock the work selection first
    (ensureWork as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const existingWorkButton = screen.getByRole("button", { name: /work1 ID: work1/i });
    fireEvent.click(existingWorkButton);

    await waitFor(() => {
      expect(screen.getByText(/Step 2 — Upload source for Work One/i)).toBeInTheDocument();
    });

    // Verify all form fields are present
    expect(screen.getByLabelText(/Description \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Commit message \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Target/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Score file/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload source/i })).toBeInTheDocument();
  });

  it("requires file input to have required attribute", async () => {
    // Mock the work selection first
    (ensureWork as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const existingWorkButton = screen.getByRole("button", { name: /work1 ID: work1/i });
    fireEvent.click(existingWorkButton);

    await waitFor(() => {
      expect(screen.getByText(/Step 2 — Upload source for Work One/i)).toBeInTheDocument();
    });

    // Verify the file input has required attribute for HTML5 validation
    const fileInput = screen.getByLabelText(/Score file/i);
    expect(fileInput).toHaveAttribute('required');
    expect(fileInput).toHaveAttribute('accept', '.mscz,.mxl,.xml');
  });

  it("allows selecting an existing source for revision", async () => {
    (ensureWork as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const existingWorkButton = screen.getByRole("button", { name: /work1 ID: work1/i });
    fireEvent.click(existingWorkButton);

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
    (ensureWork as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const existingWorkButton = screen.getByRole("button", { name: /work1 ID: work1/i });
    fireEvent.click(existingWorkButton);

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

  it("handles IMSLP search successfully", async () => {
    const mockSearchResults = [
      {
        workId: "test-work-1",
        title: "Symphony No. 1",
        composer: "Beethoven",
        permalink: "https://imslp.org/wiki/Symphony_No._1",
        metadata: {},
      },
      {
        workId: "test-work-2",
        title: "Piano Sonata",
        composer: "Mozart",
        permalink: "https://imslp.org/wiki/Piano_Sonata",
        metadata: {},
      },
    ];

    (searchImslp as jest.Mock).mockResolvedValue(mockSearchResults);

    render(<UploadForm works={mockExistingWorks} />);

    const searchInput = screen.getByPlaceholderText(/Search IMSLP catalogue/i);
    const searchButton = screen.getByRole("button", { name: /Search/i });

    fireEvent.change(searchInput, { target: { value: "Beethoven" } });
    fireEvent.click(searchButton);

    await waitFor(() => {
      expect(searchImslp).toHaveBeenCalledWith("Beethoven", 12);
      expect(screen.getByText(/Symphony No. 1/i)).toBeInTheDocument();
      expect(screen.getByText(/Composer: Beethoven/i)).toBeInTheDocument();
      expect(screen.getByText(/Piano Sonata/i)).toBeInTheDocument();
      expect(screen.getByText(/Composer: Mozart/i)).toBeInTheDocument();
    });
  });

  it("shows 'No IMSLP works found' message when search returns empty results", async () => {
    (searchImslp as jest.Mock).mockResolvedValue([]);

    render(<UploadForm works={mockExistingWorks} />);

    const searchInput = screen.getByPlaceholderText(/Search IMSLP catalogue/i);
    const searchButton = screen.getByRole("button", { name: /Search/i });

    fireEvent.change(searchInput, { target: { value: "nonexistent work" } });
    fireEvent.click(searchButton);

    await waitFor(() => {
      expect(screen.getByText(/No IMSLP works found for that query./i)).toBeInTheDocument();
    });
  });

  it("handles search error gracefully", async () => {
    const errorMessage = "Network error during search";
    (searchImslp as jest.Mock).mockRejectedValue(new Error(errorMessage));

    render(<UploadForm works={mockExistingWorks} />);

    const searchInput = screen.getByPlaceholderText(/Search IMSLP catalogue/i);
    const searchButton = screen.getByRole("button", { name: /Search/i });

    fireEvent.change(searchInput, { target: { value: "Beethoven" } });
    fireEvent.click(searchButton);

    await waitFor(() => {
      expect(screen.getByText(errorMessage)).toBeInTheDocument();
    });
  });

  it("does not perform search when query is empty or whitespace only", async () => {
    render(<UploadForm works={mockExistingWorks} />);

    const searchInput = screen.getByPlaceholderText(/Search IMSLP catalogue/i);
    const searchButton = screen.getByRole("button", { name: /Search/i });

    // Test empty query
    fireEvent.change(searchInput, { target: { value: "" } });
    fireEvent.click(searchButton);

    expect(searchImslp).not.toHaveBeenCalled();

    // Test whitespace query
    fireEvent.change(searchInput, { target: { value: "   " } });
    fireEvent.click(searchButton);

    expect(searchImslp).not.toHaveBeenCalled();
  });

  it("shows error when trying to resolve empty URL", async () => {
    render(<UploadForm works={mockExistingWorks} />);

    const resolveButton = screen.getByRole("button", { name: /Resolve URL/i });
    fireEvent.click(resolveButton);

    await waitFor(() => {
      expect(screen.getByText(/Please paste an IMSLP URL or slug./i)).toBeInTheDocument();
    });
  });

  it("displays existing works when no search results are present", async () => {
    render(<UploadForm works={mockExistingWorks} />);

    // Existing work should be displayed as a suggestion - looking for ID
    await waitFor(() => {
      expect(screen.getByText(/ID: work1/i)).toBeInTheDocument();
    });
  });

  it("shows loading state during search", async () => {
    (searchImslp as jest.Mock).mockImplementation(() => {
      return new Promise((resolve) => setTimeout(() => resolve([]), 100));
    });

    render(<UploadForm works={mockExistingWorks} />);

    const searchInput = screen.getByPlaceholderText(/Search IMSLP catalogue/i);
    const searchButton = screen.getByRole("button", { name: /Search/i });

    fireEvent.change(searchInput, { target: { value: "Beethoven" } });
    fireEvent.click(searchButton);

    // Check for loading state
    expect(screen.getByText(/Searching…/i)).toBeInTheDocument();
  });

  it("allows selecting between existing branches", async () => {
    (ensureWork as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const existingWorkButton = screen.getByRole("button", { name: /work1 ID: work1/i });
    fireEvent.click(existingWorkButton);

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

  it("handles existing work selection error gracefully", async () => {
    const errorMessage = "Failed to ensure work";
    (ensureWork as jest.Mock).mockRejectedValue(new Error(errorMessage));

    render(<UploadForm works={mockExistingWorks} />);

    const existingWorkButton = screen.getByRole("button", { name: /work1 ID: work1/i });
    fireEvent.click(existingWorkButton);

    await waitFor(() => {
      expect(screen.getByText(errorMessage)).toBeInTheDocument();
    });
  });

  it("displays the IMSLP permalink in upload step", async () => {
    (ensureWork as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const existingWorkButton = screen.getByRole("button", { name: /work1 ID: work1/i });
    fireEvent.click(existingWorkButton);

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /http:\/\/imslp.org\/work1/i });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "http://imslp.org/work1");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });
  });

  it("displays composer information when available", async () => {
    (ensureWork as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Ludwig van Beethoven", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const existingWorkButton = screen.getByRole("button", { name: /work1 ID: work1/i });
    fireEvent.click(existingWorkButton);

    await waitFor(() => {
      expect(screen.getByText(/Composer: Ludwig van Beethoven/i)).toBeInTheDocument();
    });
  });

  it("shows 'No suggestions available' when there are no works", async () => {
    render(<UploadForm works={[]} />);

    expect(screen.getByText(/No suggestions available. Try searching above./i)).toBeInTheDocument();
  });

  it("updates step indicator when transitioning between steps", async () => {
    (ensureWork as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    const { container } = render(<UploadForm works={mockExistingWorks} />);

    // Check step 1 is active initially
    const indicators = container.querySelectorAll("ol.flex li");
    expect(indicators[0]).toHaveClass("text-cyan-700");
    expect(indicators[1]).toHaveClass("text-slate-600");

    // Select a work
    const existingWorkButton = screen.getByRole("button", { name: /work1 ID: work1/i });
    fireEvent.click(existingWorkButton);

    await waitFor(() => {
      expect(screen.getByText(/Step 2 — Upload source for Work One/i)).toBeInTheDocument();
    });

    // Check step 2 is now active
    const updatedIndicators = container.querySelectorAll("ol.flex li");
    expect(updatedIndicators[1]).toHaveClass("text-cyan-700");
  });

  it("clears errors when query changes in search", async () => {
    const errorMessage = "Network error";
    (searchImslp as jest.Mock).mockRejectedValue(new Error(errorMessage));

    render(<UploadForm works={mockExistingWorks} />);

    const searchInput = screen.getByPlaceholderText(/Search IMSLP catalogue/i);
    const searchButton = screen.getByRole("button", { name: /Search/i });

    // First search that fails
    fireEvent.change(searchInput, { target: { value: "Beethoven" } });
    fireEvent.click(searchButton);

    await waitFor(() => {
      expect(screen.getByText(errorMessage)).toBeInTheDocument();
    });

    // Change query - error should clear
    fireEvent.change(searchInput, { target: { value: "Mozart" } });

    await waitFor(() => {
      expect(screen.queryByText(errorMessage)).not.toBeInTheDocument();
    });
  });

  it("does not show upload button as disabled when not submitting", async () => {
    (ensureWork as jest.Mock).mockResolvedValue({
      work: { workId: "work1", sourceCount: 1, availableFormats: [] },
      metadata: { workId: "work1", title: "Work One", composer: "Composer A", permalink: "http://imslp.org/work1" },
    });

    render(<UploadForm works={mockExistingWorks} />);

    const existingWorkButton = screen.getByRole("button", { name: /work1 ID: work1/i });
    fireEvent.click(existingWorkButton);

    await waitFor(() => {
      expect(screen.getByText(/Step 2 — Upload source for Work One/i)).toBeInTheDocument();
    });

    const uploadButton = screen.getByRole("button", { name: /Upload source/i });
    expect(uploadButton).not.toBeDisabled();
  });


});