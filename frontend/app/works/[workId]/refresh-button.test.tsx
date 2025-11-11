"use client";

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import RefreshImslpButton from "./refresh-button";
import { useRouter } from "next/navigation";
import * as api from "../../lib/api";
import React from "react";

// Mock the fetch function
global.fetch = jest.fn();

// Mock the getPublicApiBase function
jest.mock("../../lib/api", () => ({
  ...jest.requireActual("../../lib/api"),
  getPublicApiBase: jest.fn(() => "/api"),
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

describe("RefreshImslpButton", () => {
  const workId = "test-work-id";
  const mockRouter = {
    refresh: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue(mockRouter);
  });

  it("renders the button", () => {
    render(<RefreshImslpButton workId={workId} />);
    expect(screen.getByRole("button", { name: /Refresh IMSLP metadata/i })).toBeInTheDocument();
  });

  it("calls the refresh API and router.refresh on success", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
    });

    render(<RefreshImslpButton workId={workId} />);

    const button = screen.getByRole("button", { name: /Refresh IMSLP metadata/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        `/api/imslp/works/${encodeURIComponent(workId)}/refresh`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );
    });

    await waitFor(() => {
      expect(mockRouter.refresh).toHaveBeenCalled();
    });
  });

  it("displays an error message on API failure", async () => {
    const errorMessage = "Refresh failed";
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      text: () => Promise.resolve(errorMessage),
    });

    render(<RefreshImslpButton workId={workId} />);

    const button = screen.getByRole("button", { name: /Refresh IMSLP metadata/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText(errorMessage)).toBeInTheDocument();
    });

    expect(mockRouter.refresh).not.toHaveBeenCalled();
  });

  it("displays an error message on network failure", async () => {
    const errorMessage = "Network error";
    (fetch as jest.Mock).mockRejectedValueOnce(new Error(errorMessage));

    render(<RefreshImslpButton workId={workId} />);

    const button = screen.getByRole("button", { name: /Refresh IMSLP metadata/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText(errorMessage)).toBeInTheDocument();
    });

    expect(mockRouter.refresh).not.toHaveBeenCalled();
  });
});
