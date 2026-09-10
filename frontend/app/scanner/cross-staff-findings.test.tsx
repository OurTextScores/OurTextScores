import { render, screen } from "@testing-library/react";
import { CrossStaffFindings } from "./cross-staff-findings";
import type { ScannerCrossStaffFinding } from "./scanner-types";

const deviation = (system: number): ScannerCrossStaffFinding => ({
  kind: "profile_layout_deviation",
  message: "profile expects 4 staff(s) per system, detected geometry implies 1",
  system,
});

describe("CrossStaffFindings", () => {
  it("shows nothing at all when there is nothing to say", () => {
    const { container } = render(<CrossStaffFindings findings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("asks for nothing: no buttons, no controls", () => {
    // Dismiss and "Expected" both ran the same code and recorded no judgement. A
    // control that claims a consequence it does not have is worse than none.
    render(<CrossStaffFindings findings={[deviation(0), deviation(1)]} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("groups repetitions of one disagreement into a single row with a count", () => {
    // Eleven rows of the same finding bury everything else on the page.
    render(
      <CrossStaffFindings
        findings={[
          ...Array.from({ length: 11 }, (_, index) => deviation(index)),
          {
            kind: "dangling_slur_start",
            message: "slur never closed",
            system: 2,
          },
        ]}
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
      <CrossStaffFindings
        findings={[{ kind: "something_new", message: "a new one" }]}
      />,
    );
    const row = screen.getByTestId("cross-staff-finding");
    expect(row).toHaveTextContent("something new");
    expect(row).toHaveTextContent("a new one");
  });

  it("says which system and part a finding concerns", () => {
    render(
      <CrossStaffFindings
        findings={[
          {
            kind: "clef_profile_mismatch",
            message: "decoded 'G2', expected one of ['F4']",
            system: 2,
            part: "cello",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("cross-staff-finding")).toHaveTextContent(
      "System 3: cello — decoded 'G2', expected one of ['F4']",
    );
  });
});
