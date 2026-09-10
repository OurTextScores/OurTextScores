import { fireEvent, render, screen } from "@testing-library/react";
import { CrossStaffFindings, dismissalKey } from "./cross-staff-findings";
import type { ScannerCrossStaffFinding } from "./scanner-types";

const clef = (part = "cello", system = 2): ScannerCrossStaffFinding => ({
  kind: "clef_profile_mismatch",
  message: `staff 3 decoded clef 'G2', profile part '${part}' expects one of ['F4']`,
  system,
  staffIndices: [3],
  part,
});

describe("CrossStaffFindings", () => {
  beforeEach(() => window.localStorage.clear());

  it("shows nothing at all when there is nothing to say", () => {
    const { container } = render(
      <CrossStaffFindings jobId="job-1" findings={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("offers the profile reading, not only the recognition one", () => {
    // A cello in tenor clef against a profile expecting bass is ordinary music. The
    // control has to let a reviewer say the score is right, or they learn to ignore
    // the whole category.
    render(<CrossStaffFindings jobId="job-1" findings={[clef()]} />);
    expect(
      screen.getByRole("button", { name: /the score really is like this/i }),
    ).toBeInTheDocument();
  });

  it("dismisses per part and kind, not per page", () => {
    // The same finding recurs on every page of a movement; asking about each one
    // separately trains reviewers to dismiss the category unread.
    render(
      <CrossStaffFindings
        jobId="job-1"
        findings={[clef("cello", 0), clef("cello", 1), clef("viola", 0)]}
      />,
    );
    expect(screen.getAllByTestId("cross-staff-finding")).toHaveLength(3);

    fireEvent.click(screen.getAllByTestId("btn-dismiss-finding")[0]);
    const left = screen.getAllByTestId("cross-staff-finding");
    expect(left).toHaveLength(1);
    expect(left[0]).toHaveTextContent("viola");
  });

  it("remembers a dismissal for the scan", () => {
    const findings = [clef()];
    const { unmount } = render(
      <CrossStaffFindings jobId="job-1" findings={findings} />,
    );
    fireEvent.click(screen.getByTestId("btn-dismiss-finding"));
    unmount();

    render(<CrossStaffFindings jobId="job-1" findings={findings} />);
    expect(screen.queryByTestId("cross-staff-finding")).not.toBeInTheDocument();
    expect(screen.getByTestId("findings-all-dismissed")).toBeInTheDocument();
  });

  it("keeps dismissals separate between scans", () => {
    const findings = [clef()];
    const { unmount } = render(
      <CrossStaffFindings jobId="job-1" findings={findings} />,
    );
    fireEvent.click(screen.getByTestId("btn-dismiss-finding"));
    unmount();

    render(<CrossStaffFindings jobId="job-2" findings={findings} />);
    expect(screen.getByTestId("cross-staff-finding")).toBeInTheDocument();
  });

  it("shows every finding when storage is unavailable", () => {
    // Failing open: a finding shown twice is noise, one silently hidden is a lost
    // review.
    const getItem = jest
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    render(<CrossStaffFindings jobId="job-1" findings={[clef()]} />);
    expect(screen.getByTestId("cross-staff-finding")).toBeInTheDocument();
    getItem.mockRestore();
  });

  it("names a finding it has no copy for rather than hiding it", () => {
    render(
      <CrossStaffFindings
        jobId="job-1"
        findings={[{ kind: "something_new", message: "a new disagreement" }]}
      />,
    );
    expect(screen.getByTestId("cross-staff-finding")).toHaveTextContent(
      "something new",
    );
    expect(screen.getByTestId("cross-staff-finding")).toHaveTextContent(
      "a new disagreement",
    );
  });

  it("keys dismissal on kind and part", () => {
    expect(dismissalKey(clef())).toEqual("clef_profile_mismatch:cello");
    expect(dismissalKey({ kind: "k", message: "m" })).toEqual("k:*");
  });
});
