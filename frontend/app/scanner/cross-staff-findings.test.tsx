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
