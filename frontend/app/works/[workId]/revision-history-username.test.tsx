import { jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

// Import the component for testing
import RevisionHistory from "./revision-history";

describe("RevisionHistory UserBadge", () => {
  const mockRevisions = [
    {
      revisionId: "rev1",
      sequenceNumber: 1,
      createdAt: "2024-01-01T10:00:00Z",
      createdBy: "user123",
      createdByUsername: "johndoe",
      validation: { status: "passed" },
      fossilBranch: "trunk",
    },
    {
      revisionId: "rev2",
      sequenceNumber: 2,
      createdAt: "2024-01-02T10:00:00Z",
      createdBy: "user456",
      // No username set
      validation: { status: "passed" },
      fossilBranch: "trunk",
    },
  ];

  it("displays username when available", () => {
    render(
      <RevisionHistory
        workId="work1"
        sourceId="source1"
        revisions={mockRevisions}
        branchNames={["trunk"]}
        publicApiBase="http://localhost:4000/api"
      />
    );

    // Should show username for first revision, linked to the user profile
    const usernameLink = screen.getByText("johndoe");
    expect(usernameLink).toBeInTheDocument();
    expect(usernameLink.closest("a")).toHaveAttribute("href", "/users/johndoe");
  });

  it("displays userId when username is not available", () => {
    render(
      <RevisionHistory
        workId="work1"
        sourceId="source1"
        revisions={mockRevisions}
        branchNames={["trunk"]}
        publicApiBase="http://localhost:4000/api"
      />
    );

    // Should show userId for second revision
    expect(screen.getByText("user456")).toBeInTheDocument();
  });

  it("displays 'unknown' when no userId is provided", () => {
    const revisionsWithUnknown = [
      {
        revisionId: "rev3",
        sequenceNumber: 3,
        createdAt: "2024-01-03T10:00:00Z",
        // No createdBy field
        validation: { status: "passed" },
        fossilBranch: "trunk",
      },
    ];

    render(
      <RevisionHistory
        workId="work1"
        sourceId="source1"
        revisions={revisionsWithUnknown}
        branchNames={["trunk"]}
        publicApiBase="http://localhost:4000/api"
      />
    );

    // Should show 'unknown' when no userId
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });
});
