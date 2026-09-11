import { amendmentFor } from "./finding-amendment";

/** The exact message homr emits, from `cross_staff_consistency.check_clefs`. */
const real = {
  kind: "clef_profile_mismatch",
  message:
    "staff 3 decoded clef 'C3', profile part 'cello' expects one of ['F4', 'C4', 'G2']",
  system: 2,
  part: "cello",
};

describe("amendmentFor", () => {
  it("widens the part by the clef that was actually decoded", () => {
    expect(amendmentFor(real)).toEqual({ stableId: "cello", addClefs: ["C3"] });
  });

  it("refuses a message it does not recognise, rather than guessing", () => {
    // Parsing prose is the weak link. A wrong clef here goes into the profile and
    // changes what every later page is decoded against.
    expect(amendmentFor({ ...real, message: "the clef looks wrong" })).toBeNull();
    expect(amendmentFor({ ...real, message: "" })).toBeNull();
    expect(amendmentFor({ ...real, message: undefined as never })).toBeNull();
  });

  it("refuses when the finding names no part", () => {
    // The backend refuses an amendment that names no part; offering the control would
    // promise something that cannot happen.
    expect(amendmentFor({ ...real, part: undefined })).toBeNull();
  });

  it("offers nothing for kinds that have no profile answer", () => {
    // Widening a staff count would answer a geometry disagreement by changing what the
    // score is declared to be — a much stronger claim than the finding supports.
    for (const kind of [
      "profile_layout_deviation",
      "dangling_slur_start",
      "time_signature_mismatch",
      "page_staff_count_mismatch",
    ]) {
      expect(amendmentFor({ ...real, kind })).toBeNull();
    }
  });

  it("reads only the decoded clef, never the expected ones", () => {
    // The expected list appears later in the same message; matching it would add a clef
    // the profile already has and silently no-op.
    expect(amendmentFor(real)!.addClefs).toEqual(["C3"]);
  });

  it("handles every clef shape homr emits", () => {
    for (const clef of ["G2", "F4", "C3", "C4"]) {
      expect(
        amendmentFor({
          ...real,
          message: `staff 0 decoded clef '${clef}', profile part 'x' expects one of ['G2']`,
        })!.addClefs,
      ).toEqual([clef]);
    }
  });
});
