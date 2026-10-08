import { TextEncoder } from "util";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LyricReviewClient from "./lyric-review-client";
import {
  applyChange,
  blankDecision,
  buildExport,
  isReady,
  type InventoryRow,
} from "./lyric-review-model";

const row = (id: string, order: number, score = "S"): InventoryRow => ({
  id,
  score,
  text: "dreams",
  physicalRowOrder: order,
  generatedNote: {
    physical_measure: 4,
    onset_quarters: "0",
    pitch: "D5",
    source_part: "P1",
  },
  image: `${id}.jpg`,
  pageSha256: "p",
  musicXmlSha256: "x",
  predictions_sha256: "z",
});

describe("lyric review model", () => {
  const r = row("a", 1);

  it("only confirms a line once one is chosen", () => {
    let d = blankDecision(r);
    d = applyChange(r, d, { verseConfirmed: true });
    expect(d.verseConfirmed).toBe(false);
    d = applyChange(r, d, { printedLine: 1 });
    d = applyChange(r, d, { verseConfirmed: true });
    expect(d.verseConfirmed).toBe(true);
    d = applyChange(r, d, { printedLine: 2 });
    expect(d.verseConfirmed).toBe(false);
  });

  it("editing text invalidates text and note confirmation", () => {
    let d = blankDecision(r);
    for (const c of [
      { printedLine: 1 },
      { textConfirmed: true },
      { verseConfirmed: true },
      { noteConfirmed: true },
    ])
      d = applyChange(r, d, c);
    expect(isReady(r, d)).toBe(true);
    d = applyChange(r, d, { text: "dream" });
    expect(d.textConfirmed || d.noteConfirmed).toBe(false);
    expect(d.verseConfirmed).toBe(true);
    expect(applyChange(r, d, { noteConfirmed: true }).noteConfirmed).toBe(false);
  });

  it("exports the v2 schema with frozen evidence and no automatic attachment", () => {
    const out = buildExport([r], {});
    expect(out.schemaVersion).toBe("ots.lyric-placement-decisions.v2");
    expect(out.automaticAttachment).toBe(false);
    expect(out.decisions[0]).toMatchObject({
      id: "a",
      printedLine: null,
      pageSha256: "p",
      predictions_sha256: "z",
    });
    expect(out.decisions[0]).not.toHaveProperty("verse");
  });
});

describe("LyricReviewClient", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.assign(globalThis, { TextEncoder });
    const inventory = [row("a", 1), row("b", 2)];
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => inventory,
    })) as unknown as typeof fetch;
    Object.defineProperty(globalThis, "crypto", {
      value: { subtle: { digest: async () => new Uint8Array(32).buffer } },
      configurable: true,
    });
  });

  it("counts a case confirmed only after all three confirmations", async () => {
    render(<LyricReviewClient baseUrl="/lyric-review" />);
    await waitFor(() => screen.getAllByText(/S — dreams/));
    const count = screen.getByTestId("confirmed-count");
    expect(count).toHaveTextContent("0 fully confirmed");
    const article = screen.getAllByRole("article")[0];
    const box = (name: RegExp) =>
      Array.from(article.querySelectorAll("label"))
        .find((l) => name.test(l.textContent ?? ""))!
        .querySelector("input")!;
    fireEvent.click(box(/Selected line correct/));
    expect(box(/Selected line correct/)).not.toBeChecked();
    fireEvent.change(article.querySelector("select")!, {
      target: { value: "1" },
    });
    fireEvent.click(box(/Selected line correct/));
    fireEvent.click(box(/Text correct/));
    fireEvent.click(box(/Blue note correct/));
    expect(count).toHaveTextContent("1 fully confirmed");
    expect(article.querySelectorAll("option")).toHaveLength(3);
  });

  it("shows an error when the inventory is missing", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    render(<LyricReviewClient baseUrl="/lyric-review" />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("404"),
    );
  });
});
