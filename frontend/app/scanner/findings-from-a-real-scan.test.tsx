/**
 * The surface, against findings a real scan actually produced.
 *
 * Every other test here builds its own fixtures, which proves the component works on
 * the shapes I imagined. These three came off a live OTS-HOMR v7 run over a quartet
 * page with a string-quartet profile, so they also prove the shapes agree end to end -
 * the provider's field names, the optional fields it omits, and the kinds it emits.
 */
import { render, screen } from "@testing-library/react";
import { CrossStaffFindings } from "@/app/scanner/cross-staff-findings";
const real = [
  {
    kind: "profile_layout_deviation",
    message:
      "profile expects 4 staff(s) per system, detected geometry implies 3",
    system: 0,
  },
  {
    kind: "key_signature_mismatch",
    message: "key signature sequences disagree across the system",
    system: 1,
    staffIndices: [0, 1, 2, 3],
  },
  {
    kind: "dangling_slur_stop",
    message: "staff 0 slot 1: slur stop with no open start",
    system: 0,
    staffIndices: [0],
  },
];
it("renders the findings a real scan produced", () => {
  // The layout deviation is the profile earning its keep: system 0 really did detect
  // three staves for a four-part score, which nothing surfaced before.
  render(<CrossStaffFindings jobId="real" findings={real} />);
  expect(screen.getAllByTestId("cross-staff-finding")).toHaveLength(3);
  expect(
    screen.getByText(/different number of staves than expected/i),
  ).toBeInTheDocument();
  expect(screen.getByText(/detected geometry implies 3/)).toBeInTheDocument();
  expect(
    screen.getAllByRole("button", { name: /the score really is like this/i }),
  ).toHaveLength(1);
});
