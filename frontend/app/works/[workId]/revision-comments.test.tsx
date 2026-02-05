"use client";

import { render, screen } from "@testing-library/react";
import RevisionComments from "./revision-comments";

describe("RevisionComments", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("renders linked username badges for comments", async () => {
    const comments = [
      {
        commentId: "c1",
        userId: "u1",
        username: "alice",
        content: "Hello there",
        voteScore: 0,
        createdAt: new Date().toISOString(),
        replies: []
      }
    ];

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => comments
    }) as any;

    render(
      <RevisionComments
        workId="work-1"
        sourceId="source-1"
        revisionId="rev-1"
        currentUser={null}
      />
    );

    const badge = await screen.findByRole("link", { name: "alice" });
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("href", "/users/alice");
  });
});
