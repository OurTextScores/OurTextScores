import { describeDuration } from "./page-review";

describe("describeDuration", () => {
  it("names ordinary note values", () => {
    expect(describeDuration("4")).toBe("quarter");
    expect(describeDuration("16")).toBe("sixteenth");
    expect(describeDuration("1")).toBe("whole");
  });

  it("names tuplets rather than inventing a fraction", () => {
    // kern is "how many fit in a whole note", so a non-power-of-two base is a
    // tuplet: `note_48` is 48 in the space of 32, a triplet thirty-second —
    // not the "1/48 note" a naive reading produces.
    expect(describeDuration("48")).toBe("triplet thirty-second");
    expect(describeDuration("12")).toBe("triplet eighth");
    expect(describeDuration("3")).toBe("triplet half");
    expect(describeDuration("24")).toBe("triplet sixteenth");
  });

  it("names the other tuplet families", () => {
    expect(describeDuration("20")).toBe("quintuplet sixteenth");
    expect(describeDuration("7")).toBe("septuplet quarter");
    expect(describeDuration("18")).toBe("nonuplet sixteenth");
  });

  it("falls back to a ratio it can state exactly", () => {
    // Better an honest "11:8 eighth" than a wrong note name.
    expect(describeDuration("11")).toBe("11:8 eighth");
  });

  it("handles dots, grace notes and rests", () => {
    expect(describeDuration("4.")).toBe("dotted quarter");
    expect(describeDuration("4..")).toBe("double-dotted quarter");
    expect(describeDuration("8G")).toBe("grace eighth");
    expect(describeDuration("0")).toBe("whole-measure rest");
    expect(describeDuration("4m")).toBe("multi-measure rest");
  });
});
