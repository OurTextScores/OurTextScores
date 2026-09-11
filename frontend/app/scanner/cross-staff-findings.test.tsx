import { fireEvent, render, screen } from "@testing-library/react";
import { CrossStaffFindings } from "./cross-staff-findings";
import type { ScannerCrossStaffFinding } from "./scanner-types";

const deviation = (system: number): ScannerCrossStaffFinding => ({
  kind: "profile_layout_deviation",
  message: "profile expects 4 staff(s) per system, detected geometry implies 1",
  system,
});

/** One engine's worth of findings, the shape the panel now takes. */
function from(findings: ScannerCrossStaffFinding[], engineId = "ots-homr") {
  return [{ engineId, findings }];
}

/** The props that let a finding be located; omitted, the panel stays read-only text. */
const LOCATABLE = { jobId: "job-1", pageNumber: 3, statusVersion: 7 };

describe("CrossStaffFindings", () => {
  it("shows nothing at all when there is nothing to say", () => {
    const { container } = render(<CrossStaffFindings sources={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing when every engine reported nothing", () => {
    const { container } = render(<CrossStaffFindings sources={from([])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("groups repetitions of one disagreement into a single row with a count", () => {
    // Eleven rows of the same finding bury everything else on the page.
    render(
      <CrossStaffFindings
        sources={from([
          ...Array.from({ length: 11 }, (_, index) => deviation(index)),
          { kind: "dangling_slur_start", message: "slur never closed", system: 2 },
        ])}
      />,
    );
    const rows = screen.getAllByTestId("cross-staff-finding");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-count", "11");
    expect(rows[0]).toHaveTextContent("11 places");
    expect(rows[0]).toHaveTextContent("…and 7 more like it");
  });

  it("names a kind it has no copy for rather than hiding it", () => {
    render(
      <CrossStaffFindings sources={from([{ kind: "something_new", message: "a new one" }])} />,
    );
    const row = screen.getByTestId("cross-staff-finding");
    expect(row).toHaveTextContent("something new");
    expect(row).toHaveTextContent("a new one");
  });

  it("says which system and part a finding concerns", () => {
    render(
      <CrossStaffFindings
        sources={from([
          {
            kind: "clef_profile_mismatch",
            message: "decoded 'G2', expected one of ['F4']",
            system: 2,
            part: "cello",
          },
        ])}
      />,
    );
    expect(screen.getByTestId("cross-staff-finding")).toHaveTextContent(
      "System 3: cello — decoded 'G2', expected one of ['F4']",
    );
  });

  it("still records no judgement: the only controls show and hide a picture", () => {
    // Dismiss and "Expected" both ran the same code and recorded no judgement. Showing
    // a crop claims nothing, so it is allowed here where those were not.
    render(<CrossStaffFindings {...LOCATABLE} sources={from([deviation(0)])} />);
    expect(
      screen.getAllByRole("button").every((button) => button.textContent === "Show me"),
    ).toBe(true);
  });
});

describe("locating a finding on the page", () => {
  it("offers nothing to click without the job context to address a crop", () => {
    render(<CrossStaffFindings sources={from([deviation(0)])} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("fetches no image until asked", () => {
    // A page can carry seventeen findings; rendering seventeen crops nobody asked for
    // costs seventeen server-side image extractions.
    render(<CrossStaffFindings {...LOCATABLE} sources={from([deviation(0)])} />);
    expect(screen.queryByTestId("cross-staff-finding-crop")).toBeNull();
  });

  it("addresses the crop by engine and by index within that engine's findings", () => {
    // The pair is the address. Flattening across engines, as the panel used to, loses it.
    render(
      <CrossStaffFindings
        {...LOCATABLE}
        sources={[
          { engineId: "transcoda", findings: [deviation(0)] },
          { engineId: "ots-homr", findings: [deviation(1), deviation(2)] },
        ]}
      />,
    );
    fireEvent.click(screen.getAllByTestId("cross-staff-finding-show")[2]);
    expect(screen.getByTestId("cross-staff-finding-crop")).toHaveAttribute(
      "src",
      "/api/proxy/scanner/jobs/job-1/pages/3/engines/ots-homr/findings/1/crop?statusVersion=7",
    );
  });

  it("offers no crop for a page-level finding, rather than one that will fail", () => {
    // `page_staff_count_mismatch` is raised with staff positions and no system at all.
    // The server refuses to place it, so promising a picture would be a broken promise.
    render(
      <CrossStaffFindings
        {...LOCATABLE}
        sources={from([
          { kind: "page_staff_count_mismatch", message: "a system has a different count" },
        ])}
      />,
    );
    expect(screen.queryAllByTestId("cross-staff-finding-show")).toHaveLength(0);
  });

  it("says it could not be located when the server refuses", () => {
    // The server refuses a crop it cannot place rather than guessing. That is a real
    // answer and beats an empty frame.
    render(<CrossStaffFindings {...LOCATABLE} sources={from([deviation(0)])} />);
    fireEvent.click(screen.getByTestId("cross-staff-finding-show"));
    fireEvent.error(screen.getByTestId("cross-staff-finding-crop"));
    expect(screen.getByTestId("cross-staff-finding-crop-unavailable")).toHaveTextContent(
      "could not be located",
    );
    expect(screen.queryByTestId("cross-staff-finding-crop")).toBeNull();
  });

  it("can be hidden again", () => {
    render(<CrossStaffFindings {...LOCATABLE} sources={from([deviation(0)])} />);
    fireEvent.click(screen.getByTestId("cross-staff-finding-show"));
    expect(screen.getByTestId("cross-staff-finding-crop")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Hide"));
    expect(screen.queryByTestId("cross-staff-finding-crop")).toBeNull();
    expect(screen.getByTestId("cross-staff-finding-show")).toBeInTheDocument();
  });
});

describe("fixing the reading", () => {
  const editorUrlFor = (engineId: string, finding: { kind: string; part?: string }) =>
    `/score-editor/index.html?engine=${engineId}&kind=${finding.kind}` +
    (finding.part ? `&part=${finding.part}` : "");

  it("carries the finding's kind and part to the editor", () => {
    // The save is attributed from this, so losing it here files the edit as a
    // disagreement between engines that never happened.
    render(
      <CrossStaffFindings
        {...LOCATABLE}
        editorUrlFor={editorUrlFor}
        sources={from([
          {
            kind: "clef_profile_mismatch",
            message: "decoded 'G2'",
            system: 2,
            part: "cello",
          },
        ])}
      />,
    );
    expect(screen.getByTestId("cross-staff-finding-fix")).toHaveAttribute(
      "href",
      "/score-editor/index.html?engine=ots-homr&kind=clef_profile_mismatch&part=cello",
    );
  });

  it("omits the part when the finding named none", () => {
    render(
      <CrossStaffFindings
        {...LOCATABLE}
        editorUrlFor={editorUrlFor}
        sources={from([{ kind: "dangling_slur_start", message: "y", system: 0 }])}
      />,
    );
    expect(screen.getByTestId("cross-staff-finding-fix")).toHaveAttribute(
      "href",
      "/score-editor/index.html?engine=ots-homr&kind=dangling_slur_start",
    );
  });

  it("names the engine that raised it, not the first engine on the page", () => {
    render(
      <CrossStaffFindings
        {...LOCATABLE}
        editorUrlFor={editorUrlFor}
        sources={[
          { engineId: "transcoda", findings: [] },
          {
            engineId: "ots-homr",
            findings: [{ kind: "time_signature_mismatch", message: "z", system: 1 }],
          },
        ]}
      />,
    );
    expect(screen.getByTestId("cross-staff-finding-fix")).toHaveAttribute(
      "href",
      expect.stringContaining("engine=ots-homr") as unknown as string,
    );
  });

  it("offers the fix for a page-level finding, which has no crop but is still real", () => {
    // Not locatable is not the same as not actionable: the reading can still be wrong.
    render(
      <CrossStaffFindings
        {...LOCATABLE}
        editorUrlFor={editorUrlFor}
        sources={from([{ kind: "page_staff_count_mismatch", message: "w" }])}
      />,
    );
    expect(screen.queryAllByTestId("cross-staff-finding-show")).toHaveLength(0);
    expect(screen.getByTestId("cross-staff-finding-fix")).toBeInTheDocument();
  });

  it("offers nothing when the host cannot build an editor URL", () => {
    render(<CrossStaffFindings {...LOCATABLE} sources={from([deviation(0)])} />);
    expect(screen.queryAllByTestId("cross-staff-finding-fix")).toHaveLength(0);
  });
});

describe("recording a decision", () => {
  const clef = {
    kind: "clef_profile_mismatch",
    message:
      "staff 3 decoded clef 'C3', profile part 'cello' expects one of ['F4']",
    system: 2,
    part: "cello",
  };

  it("offers nothing without somewhere to record it", () => {
    // The rule the removed buttons broke: a control claiming a consequence it does not
    // have is worse than no control.
    render(<CrossStaffFindings {...LOCATABLE} sources={from([clef])} />);
    expect(screen.queryAllByTestId("cross-staff-finding-acknowledge")).toHaveLength(0);
    expect(screen.queryAllByTestId("cross-staff-finding-amend")).toHaveLength(0);
  });

  it("widens the profile by the clef that was decoded", () => {
    const onDecide = jest.fn();
    render(
      <CrossStaffFindings {...LOCATABLE} onDecide={onDecide} sources={from([clef])} />,
    );
    fireEvent.click(screen.getByTestId("cross-staff-finding-amend"));
    expect(onDecide).toHaveBeenCalledWith({
      kind: "clef_profile_mismatch",
      part: "cello",
      disposition: "profile-amended",
      amendment: { stableId: "cello", addClefs: ["C3"] },
    });
  });

  it("names the clef in the control, so the consequence is visible before clicking", () => {
    render(
      <CrossStaffFindings {...LOCATABLE} onDecide={jest.fn()} sources={from([clef])} />,
    );
    expect(screen.getByTestId("cross-staff-finding-amend")).toHaveTextContent(
      "widen the profile to C3",
    );
  });

  it("offers no amendment where none can be derived", () => {
    // Refuse rather than guess: an amendment built from an unrecognised message would
    // change what every later page is decoded against.
    const onDecide = jest.fn();
    render(
      <CrossStaffFindings
        {...LOCATABLE}
        onDecide={onDecide}
        sources={from([deviation(0)])}
      />,
    );
    expect(screen.queryAllByTestId("cross-staff-finding-amend")).toHaveLength(0);
    // The other two still stand: the finding can be checked or flagged regardless.
    expect(screen.getByTestId("cross-staff-finding-acknowledge")).toBeInTheDocument();
    expect(screen.getByTestId("cross-staff-finding-flag")).toBeInTheDocument();
  });

  it("decides for the whole kind and part at once, never per page", () => {
    // The same disagreement recurs on every page of a movement; asking per page trains
    // reviewers to dismiss the category unread.
    const onDecide = jest.fn();
    render(
      <CrossStaffFindings
        {...LOCATABLE}
        onDecide={onDecide}
        sources={from([deviation(0), deviation(1), deviation(2)])}
      />,
    );
    expect(screen.getAllByTestId("cross-staff-finding-acknowledge")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("cross-staff-finding-acknowledge"));
    expect(onDecide).toHaveBeenCalledWith({
      kind: "profile_layout_deviation",
      part: null,
      disposition: "acknowledged",
    });
  });
});

describe("showing a standing decision", () => {
  const clef = {
    kind: "clef_profile_mismatch",
    message: "staff 3 decoded clef 'C3', profile part 'cello' expects one of ['F4']",
    system: 2,
    part: "cello",
  };

  it("states the decision and hides the controls", () => {
    render(
      <CrossStaffFindings
        {...LOCATABLE}
        onDecide={jest.fn()}
        sources={from([clef])}
        dispositions={[
          { kind: "clef_profile_mismatch", part: "cello", disposition: "profile-amended" },
        ]}
      />,
    );
    expect(screen.getByTestId("cross-staff-finding-disposition")).toHaveTextContent(
      "Profile widened to expect this",
    );
    expect(screen.queryAllByTestId("cross-staff-finding-amend")).toHaveLength(0);
  });

  it("keeps a flagged finding visible as open work", () => {
    // Hiding it because someone noticed it would lose the only record that anything is
    // wrong.
    render(
      <CrossStaffFindings
        {...LOCATABLE}
        sources={from([clef])}
        dispositions={[
          { kind: "clef_profile_mismatch", part: "cello", disposition: "reading-flagged" },
        ]}
      />,
    );
    const row = screen.getByTestId("cross-staff-finding-disposition");
    expect(row).toHaveAttribute("data-disposition", "reading-flagged");
    expect(row).toHaveTextContent("Flagged as misread");
  });

  it("never removes a finding — suppression is a view, not a deletion", () => {
    render(
      <CrossStaffFindings
        {...LOCATABLE}
        sources={from([clef, deviation(0)])}
        dispositions={[
          { kind: "clef_profile_mismatch", part: "cello", disposition: "acknowledged" },
        ]}
      />,
    );
    expect(screen.getAllByTestId("cross-staff-finding")).toHaveLength(2);
  });

  it("sorts answered groups below open ones", () => {
    render(
      <CrossStaffFindings
        {...LOCATABLE}
        sources={from([clef, deviation(0)])}
        dispositions={[
          { kind: "clef_profile_mismatch", part: "cello", disposition: "acknowledged" },
        ]}
      />,
    );
    const rows = screen.getAllByTestId("cross-staff-finding");
    expect(rows[0]).toHaveAttribute("data-kind", "profile_layout_deviation");
    expect(rows[1]).toHaveAttribute("data-kind", "clef_profile_mismatch");
  });

  it("prefers a part-specific decision over a kind-wide one", () => {
    // The narrower statement is the more considered one, matching the server.
    render(
      <CrossStaffFindings
        {...LOCATABLE}
        sources={from([clef])}
        dispositions={[
          { kind: "clef_profile_mismatch", part: null, disposition: "reading-flagged" },
          { kind: "clef_profile_mismatch", part: "cello", disposition: "acknowledged" },
        ]}
      />,
    );
    expect(screen.getByTestId("cross-staff-finding-disposition")).toHaveAttribute(
      "data-disposition",
      "acknowledged",
    );
  });

  it("does not apply another part's decision to a finding with no part", () => {
    render(
      <CrossStaffFindings
        {...LOCATABLE}
        sources={from([deviation(0)])}
        dispositions={[
          { kind: "profile_layout_deviation", part: "cello", disposition: "acknowledged" },
        ]}
      />,
    );
    expect(screen.queryAllByTestId("cross-staff-finding-disposition")).toHaveLength(0);
  });

  it("can be withdrawn, returning the finding to open work", () => {
    const onWithdraw = jest.fn();
    render(
      <CrossStaffFindings
        {...LOCATABLE}
        onWithdraw={onWithdraw}
        sources={from([clef])}
        dispositions={[
          { kind: "clef_profile_mismatch", part: "cello", disposition: "acknowledged" },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("cross-staff-finding-withdraw"));
    expect(onWithdraw).toHaveBeenCalledWith({
      kind: "clef_profile_mismatch",
      part: "cello",
    });
  });
});
