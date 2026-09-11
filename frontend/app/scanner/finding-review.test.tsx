import { act, fireEvent, render, screen } from "@testing-library/react";

import { FindingReview } from "./finding-review";

/**
 * The seam between the embed and the host.
 *
 * The embed owns navigation and editing; the host owns the decisions, because a
 * disposition is a scanner concept with a scanner API behind it. The join is a message
 * saying which issue is on screen -- and if it fails, the host's controls answer a
 * different question from the one being shown, which is exactly the failure the original
 * Dismiss and Expected buttons had, in a new place.
 */
const PROPS = {
  jobId: "job-1",
  pageNumber: 3,
  engineId: "ots-homr",
  readingUrl: "/api/proxy/scanner/jobs/job-1/artifacts/musicxml?page=3&engine=ots-homr",
  findings: [{ kind: "clef_profile_mismatch", message: "x", system: 0 }],
};

function sendIssue(issue: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "ots-finding-issue", ...issue },
        origin: window.location.origin,
      }),
    );
  });
}

const CLEF_ISSUE = {
  kind: "clef_profile_mismatch",
  part: "cello",
  message: "staff 3 decoded clef 'C3', profile part 'cello' expects one of ['F4']",
  index: 0,
  total: 3,
  places: 2,
};

describe("FindingReview", () => {
  it("shows nothing when there is nothing to review", () => {
    const { container } = render(<FindingReview {...PROPS} findings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("embeds the editor in findings mode, with one reading and no comparison", () => {
    // A second reading would mean the caller wanted the comparison view; the embed
    // refuses `compareRight` in this mode for that reason.
    render(<FindingReview {...PROPS} />);
    const src = screen.getByTestId("finding-review-embed").getAttribute("src")!;
    const query = new URL(src, "https://example.test").searchParams;
    expect(query.get("compareMode")).toBe("findings");
    expect(query.get("compareLeft")).toBe(PROPS.readingUrl);
    expect(query.get("compareRight")).toBeNull();
    // Depth matters: the document addresses its crops and `../merged` relatively.
    expect(query.get("compareRegions")).toBe(
      "/api/proxy/scanner/jobs/job-1/pages/3/findings/regions?engine=ots-homr",
    );
  });

  it("offers no decision until the embed says what is on screen", () => {
    // Controls without a subject would record a decision about the wrong finding.
    render(<FindingReview {...PROPS} onDecide={jest.fn()} />);
    expect(screen.queryByTestId("finding-review-decision")).toBeNull();
  });

  it("records the decision against the issue the embed is showing", () => {
    const onDecide = jest.fn();
    render(<FindingReview {...PROPS} onDecide={onDecide} />);
    sendIssue(CLEF_ISSUE);
    fireEvent.click(screen.getByTestId("finding-review-acknowledge"));
    expect(onDecide).toHaveBeenCalledWith({
      kind: "clef_profile_mismatch",
      part: "cello",
      disposition: "acknowledged",
    });
  });

  it("follows the embed to the next issue", () => {
    const onDecide = jest.fn();
    render(<FindingReview {...PROPS} onDecide={onDecide} />);
    sendIssue(CLEF_ISSUE);
    sendIssue({ ...CLEF_ISSUE, kind: "dangling_slur_start", part: null, index: 1 });
    fireEvent.click(screen.getByTestId("finding-review-flag"));
    expect(onDecide).toHaveBeenCalledWith({
      kind: "dangling_slur_start",
      part: null,
      disposition: "reading-flagged",
    });
  });

  it("derives the profile amendment from the message the embed sent", () => {
    // The message travels precisely so this control can exist; without it the amendment
    // cannot be derived and the control would never appear.
    const onDecide = jest.fn();
    render(<FindingReview {...PROPS} onDecide={onDecide} />);
    sendIssue(CLEF_ISSUE);
    fireEvent.click(screen.getByTestId("finding-review-amend"));
    expect(onDecide).toHaveBeenCalledWith({
      kind: "clef_profile_mismatch",
      part: "cello",
      disposition: "profile-amended",
      amendment: { stableId: "cello", addClefs: ["C3"] },
    });
  });

  it("offers no amendment for a kind that has no profile answer", () => {
    render(<FindingReview {...PROPS} onDecide={jest.fn()} />);
    sendIssue({ ...CLEF_ISSUE, kind: "profile_layout_deviation", part: null });
    expect(screen.queryByTestId("finding-review-amend")).toBeNull();
    expect(screen.getByTestId("finding-review-acknowledge")).toBeInTheDocument();
  });

  it("states a standing decision instead of offering the controls again", () => {
    render(
      <FindingReview
        {...PROPS}
        onDecide={jest.fn()}
        dispositions={[
          { kind: "clef_profile_mismatch", part: "cello", disposition: "profile-amended" },
        ]}
      />,
    );
    sendIssue(CLEF_ISSUE);
    expect(screen.getByTestId("finding-review-standing")).toHaveTextContent(
      "Profile widened to expect this",
    );
    expect(screen.queryByTestId("finding-review-amend")).toBeNull();
  });

  it("prefers a part-specific decision over a kind-wide one", () => {
    render(
      <FindingReview
        {...PROPS}
        dispositions={[
          { kind: "clef_profile_mismatch", part: null, disposition: "reading-flagged" },
          { kind: "clef_profile_mismatch", part: "cello", disposition: "acknowledged" },
        ]}
      />,
    );
    sendIssue(CLEF_ISSUE);
    expect(screen.getByTestId("finding-review-standing")).toHaveAttribute(
      "data-disposition",
      "acknowledged",
    );
  });

  it("can withdraw a decision, returning the issue to open work", () => {
    const onWithdraw = jest.fn();
    render(
      <FindingReview
        {...PROPS}
        onWithdraw={onWithdraw}
        dispositions={[
          { kind: "clef_profile_mismatch", part: "cello", disposition: "acknowledged" },
        ]}
      />,
    );
    sendIssue(CLEF_ISSUE);
    fireEvent.click(screen.getByTestId("finding-review-withdraw"));
    expect(onWithdraw).toHaveBeenCalledWith({
      kind: "clef_profile_mismatch",
      part: "cello",
    });
  });

  it("ignores a message from another origin", () => {
    // The embed is served from this site; an issue from anywhere else is not it talking.
    render(<FindingReview {...PROPS} onDecide={jest.fn()} />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "ots-finding-issue", ...CLEF_ISSUE },
          origin: "https://elsewhere.test",
        }),
      );
    });
    expect(screen.queryByTestId("finding-review-decision")).toBeNull();
  });

  it("ignores a message that names no kind", () => {
    render(<FindingReview {...PROPS} onDecide={jest.fn()} />);
    sendIssue({ ...CLEF_ISSUE, kind: "" });
    expect(screen.queryByTestId("finding-review-decision")).toBeNull();
  });
});

describe("flagging every example of an issue", () => {
  it("records the decision kind-wide, not against the example's part", () => {
    // Part-specific and kind-wide are different rows on the server, and the narrower one
    // wins when both exist. "All examples" has to write the wider one or it would only
    // answer for the part on screen.
    const onDecide = jest.fn();
    render(<FindingReview {...PROPS} onDecide={onDecide} />);
    sendIssue(CLEF_ISSUE);
    fireEvent.click(screen.getByTestId("finding-review-flag-all"));
    expect(onDecide).toHaveBeenCalledWith({
      kind: "clef_profile_mismatch",
      part: null,
      disposition: "reading-flagged",
    });
  });

  it("still offers the narrower answer beside it", () => {
    const onDecide = jest.fn();
    render(<FindingReview {...PROPS} onDecide={onDecide} />);
    sendIssue(CLEF_ISSUE);
    fireEvent.click(screen.getByTestId("finding-review-flag"));
    expect(onDecide).toHaveBeenCalledWith({
      kind: "clef_profile_mismatch",
      part: "cello",
      disposition: "reading-flagged",
    });
  });

  it("names how many examples it covers", () => {
    render(<FindingReview {...PROPS} onDecide={jest.fn()} />);
    sendIssue(CLEF_ISSUE);
    expect(screen.getByTestId("finding-review-flag-all")).toHaveTextContent(
      "Flag all 2 examples",
    );
  });

  it("is absent when the finding names no part", () => {
    // With no part, "this example" and "all of them" are the same decision, and two
    // buttons for one outcome is what the removed Dismiss/Expected pair did.
    render(<FindingReview {...PROPS} onDecide={jest.fn()} />);
    sendIssue({ ...CLEF_ISSUE, part: null });
    expect(screen.queryByTestId("finding-review-flag-all")).toBeNull();
    expect(screen.getByTestId("finding-review-flag")).toBeInTheDocument();
  });

  it("is absent when there is only one example", () => {
    render(<FindingReview {...PROPS} onDecide={jest.fn()} />);
    sendIssue({ ...CLEF_ISSUE, places: 1 });
    expect(screen.queryByTestId("finding-review-flag-all")).toBeNull();
  });

  it("offers controls as buttons, not links", () => {
    render(
      <FindingReview
        {...PROPS}
        onDecide={jest.fn()}
        onWithdraw={jest.fn()}
        dispositions={[
          { kind: "clef_profile_mismatch", part: "cello", disposition: "acknowledged" },
        ]}
      />,
    );
    sendIssue(CLEF_ISSUE);
    expect(screen.getByTestId("finding-review-withdraw").tagName).toBe("BUTTON");
  });
});
