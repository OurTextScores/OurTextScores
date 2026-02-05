"use client";

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import EditMetadataForm from "./edit-metadata-form";
import { updateWorkMetadata } from "../../lib/api";
import { useRouter } from "next/navigation";
import React from "react";

// Mock dependencies
jest.mock("../../lib/api", () => ({
  updateWorkMetadata: jest.fn(),
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
        callback();
        setIsPending(false);
      };
      return [isPending, startTransition];
    },
  };
});

describe("EditMetadataForm", () => {
  const workId = "test-work-id";
  const initial = {
    title: "Initial Title",
    composer: "Initial Composer",
    catalogNumber: "Initial Catalogue",
  };
  const mockRouter = {
    refresh: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue(mockRouter);
  });

  it("renders the form with initial values", () => {
    render(<EditMetadataForm workId={workId} initial={initial} />);

    expect(screen.getByLabelText(/title/i)).toHaveValue(initial.title);
    expect(screen.getByLabelText(/composer/i)).toHaveValue(initial.composer);
    expect(screen.getByLabelText(/catalog number/i)).toHaveValue(initial.catalogNumber);
  });

  it("submits the form and shows a saved message on success", async () => {
    (updateWorkMetadata as jest.Mock).mockResolvedValueOnce({});

    render(<EditMetadataForm workId={workId} initial={initial} />);

    const titleInput = screen.getByLabelText(/title/i);
    const composerInput = screen.getByLabelText(/composer/i);
    const catalogInput = screen.getByLabelText(/catalog number/i);
    const saveButton = screen.getByRole("button", { name: /save/i });

    fireEvent.change(titleInput, { target: { value: "New Title" } });
    fireEvent.change(composerInput, { target: { value: "New Composer" } });
    fireEvent.change(catalogInput, { target: { value: "New Catalogue" } });
    fireEvent.submit(saveButton);

    await waitFor(() => {
      expect(updateWorkMetadata).toHaveBeenCalledWith(workId, {
        title: "New Title",
        composer: "New Composer",
        catalogNumber: "New Catalogue",
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/saved/i)).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(mockRouter.refresh).toHaveBeenCalled();
    });
  });

  it("shows an error message on failure", async () => {
    const errorMessage = "Failed to save";
    (updateWorkMetadata as jest.Mock).mockRejectedValueOnce(new Error(errorMessage));

    render(<EditMetadataForm workId={workId} initial={initial} />);

    const saveButton = screen.getByRole("button", { name: /save/i });
    fireEvent.submit(saveButton);

    await waitFor(() => {
      expect(screen.getByText(errorMessage)).toBeInTheDocument();
    });
  });
});
