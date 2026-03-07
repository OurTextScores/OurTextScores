import { jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

jest.mock("../lib/api", () => ({
  getApiBase: jest.fn(() => "http://localhost:4000/api"),
}));

jest.mock("../lib/authToken", () => ({
  getApiAuthHeaders: jest.fn(async () => ({ Authorization: "Bearer test-token" })),
}));

import ChangeReviewsPage from "./page";

global.fetch = jest.fn();

describe("ChangeReviewsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the three review sections with fetched items", async () => {
    (fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              reviewId: "owner-open-1",
              workId: "work-1",
              sourceId: "source-1",
              baseSequenceNumber: 3,
              headSequenceNumber: 4,
              reviewerUserId: "reviewer-1",
              reviewerUsername: "reviewer",
              ownerUserId: "owner-1",
              ownerUsername: "owner",
              title: "Owner review",
              status: "open",
              unresolvedThreadCount: 2,
              lastActivityAt: "2026-03-07T16:00:00.000Z",
              workTitle: "Work One",
              composer: "Composer One",
              sourceLabel: "Source One",
              branchName: "trunk",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              reviewId: "open-1",
              workId: "work-2",
              sourceId: "source-2",
              baseSequenceNumber: 1,
              headSequenceNumber: 2,
              reviewerUserId: "reviewer-1",
              reviewerUsername: "reviewer",
              ownerUserId: "owner-2",
              ownerUsername: "owner2",
              title: "Open review",
              status: "open",
              unresolvedThreadCount: 0,
              lastActivityAt: "2026-03-07T15:00:00.000Z",
              workTitle: "Work Two",
              sourceLabel: "Source Two",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              reviewId: "closed-1",
              workId: "work-3",
              sourceId: "source-3",
              baseSequenceNumber: 7,
              headSequenceNumber: 8,
              reviewerUserId: "reviewer-1",
              reviewerUsername: "reviewer",
              ownerUserId: "owner-3",
              ownerUsername: "owner3",
              title: "Closed review",
              status: "closed",
              unresolvedThreadCount: 1,
              lastActivityAt: "2026-03-07T14:00:00.000Z",
              workTitle: "Work Three",
              sourceLabel: "Source Three",
            },
          ],
        }),
      });

    render(await ChangeReviewsPage());

    expect(screen.getByRole("heading", { name: "Change Reviews" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Needs Your Response" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Open Reviews" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recently Closed" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Owner review" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open review" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Closed review" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("redirects to sign-in when the review list request is unauthorized", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    });

    await expect(ChangeReviewsPage()).rejects.toThrow("NEXT_REDIRECT");
  });
});
