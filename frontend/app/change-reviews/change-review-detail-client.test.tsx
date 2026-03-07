import { jest } from "@jest/globals";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import ChangeReviewDetailClient from "./change-review-detail-client";

global.fetch = jest.fn();

const initialReview = {
  reviewId: "review-1",
  workId: "work-1",
  sourceId: "source-1",
  branchName: "trunk",
  baseRevisionId: "rev-1",
  headRevisionId: "rev-2",
  baseSequenceNumber: 1,
  headSequenceNumber: 2,
  reviewerUserId: "reviewer-1",
  reviewerUsername: "reviewer",
  ownerUserId: "owner-1",
  ownerUsername: "owner",
  title: "Review 1 -> 2",
  summary: "",
  status: "draft" as const,
  unresolvedThreadCount: 0,
  openThreadCount: 0,
  resolvedThreadCount: 0,
  lastActivityAt: "2026-03-07T16:00:00.000Z",
  createdAt: "2026-03-07T15:59:00.000Z",
  work: { workId: "work-1", title: "Work One", composer: "Composer One" },
  source: { sourceId: "source-1", label: "Source One", sourceType: "score" },
  permissions: {
    canRead: true,
    canEditDraft: true,
    canAddThread: true,
    canSubmit: true,
    canClose: false,
    canWithdraw: true,
    canReply: false,
    canResolve: false,
  },
};

const initialDiff = {
  reviewId: "review-1",
  fileKind: "canonical" as const,
  baseRevisionId: "rev-1",
  headRevisionId: "rev-2",
  hunks: [
    {
      hunkId: "hunk-1",
      header: "@@ -1,1 +1,1 @@",
      lines: [
        {
          anchorId: "anchor-1",
          type: "add" as const,
          oldLineNumber: undefined,
          newLineNumber: 1,
          content: "<measure number=\"2\">",
          commentable: true,
          lineHash: "hash-1",
          hunkHeader: "@@ -1,1 +1,1 @@",
        },
      ],
    },
  ],
  threads: [],
};

describe("ChangeReviewDetailClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates a new thread and refreshes the review detail", async () => {
    const user = userEvent.setup();
    (fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...initialReview,
          unresolvedThreadCount: 1,
          openThreadCount: 1,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...initialDiff,
          threads: [
            {
              threadId: "thread-1",
              status: "open",
              diffAnchor: { anchorId: "anchor-1", lineText: "<measure number=\"2\">" },
              comments: [
                {
                  commentId: "comment-1",
                  userId: "reviewer-1",
                  username: "reviewer",
                  content: "Please verify this measure.",
                  createdAt: "2026-03-07T16:05:00.000Z",
                },
              ],
            },
          ],
        }),
      });

    render(<ChangeReviewDetailClient initialReview={initialReview} initialDiff={initialDiff} />);

    await user.click(screen.getByRole("button", { name: "Add Thread" }));
    await user.type(screen.getByPlaceholderText("Write a review comment on this changed line"), "Please verify this measure.");
    await user.click(screen.getByRole("button", { name: "Save Thread" }));

    await waitFor(() => {
      expect(screen.getByText("Please verify this measure.")).toBeInTheDocument();
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/proxy/change-reviews/review-1/threads",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          anchorId: "anchor-1",
          content: "Please verify this measure.",
        }),
      }),
    );
  });

  it("submits a draft review and refreshes to open status", async () => {
    const user = userEvent.setup();
    (fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...initialReview,
          status: "open",
          summary: "Please review the updated measure.",
          permissions: {
            ...initialReview.permissions,
            canSubmit: false,
            canAddThread: false,
            canReply: true,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => initialDiff,
      });

    render(<ChangeReviewDetailClient initialReview={initialReview} initialDiff={initialDiff} />);

    await user.type(screen.getByPlaceholderText("Optional review summary"), "Please review the updated measure.");
    await user.click(screen.getByRole("button", { name: "Submit Review" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Submit Review" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Withdraw Review" })).toBeInTheDocument();
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/proxy/change-reviews/review-1/submit",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          summary: "Please review the updated measure.",
        }),
      }),
    );
  });
});
