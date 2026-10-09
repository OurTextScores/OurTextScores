import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LyricCandidatesClient from "./lyric-candidates-client";
import { directionItems, directionPlan, blankDirection, type DirectionDecision } from "./direction-review-model";
import { reviewItems, type Inventory, type OcrRow } from "./candidate-review-model";

const choices = [
  { number: 1, noteId: '["P1",1,1]', x: 100, pitch: "C4", measure: 1, ordinal: 1 },
  { number: 2, noteId: '["P1",1,2]', x: 160, pitch: "D4", measure: 1, ordinal: 2 },
];
const row = (over: Partial<OcrRow>): OcrRow => ({
  id: "d-1",
  box: [90, 20, 180, 45],
  text: "cresc. poco a poco",
  ocrConfidence: 0.9,
  regionCoverage: 0,
  semantic: "DirectionText",
  semanticScore: 0.1,
  proposedLyric: false,
  kind: "words",
  proposedDirection: true,
  anchor: {
    staffIndex: 0,
    printedLine: 1,
    placement: "above",
    syllables: [{ text: "cresc.", measureInStaff: 0, noteOrdinalInMeasure: 1, notePitch: "C4", position: "attention", noteId: choices[0].noteId, distancePx: 10 }],
  },
  noteChoices: choices,
  withheldReason: null,
  ...over,
});
const inventory = (rows: OcrRow[]): Inventory => ({
  schemaVersion: "ots.lyric-candidate-inventory.v1",
  automaticAttachment: false,
  pageNumber: 1,
  raster: { checksumSha256: "r", width: 400, height: 300 },
  candidates: [],
  ocrRows: rows,
  ocrStatus: "ok",
});

describe("direction review model", () => {
  const rows = [
    row({}),
    row({ id: "d-2", text: "mf", kind: "dynamic", mark: "mf" }),
    row({ id: "d-3", text: "Peters Verlag", proposedDirection: false, withheldReason: "credit-like" }),
    row({ id: "l-1", kind: "lyric", text: "wish", proposedLyric: true, proposedDirection: undefined }),
  ];

  it("lists only offered direction rows, and keeps them out of the lyric review", () => {
    const inv = inventory(rows);
    expect(directionItems(inv).map((i) => [i.id, i.kind, i.initialText])).toEqual([
      ["d-1", "words", "cresc. poco a poco"],
      ["d-2", "dynamic", "mf"],
    ]);
    expect(reviewItems(inv).map((i) => i.id)).toEqual(["l-1"]);
  });

  it("defaults to the nearest note and the scanner's placement, and plans only accepted decisions with a note", () => {
    const items = directionItems(inventory(rows));
    const start = blankDirection(items[0]);
    expect(start).toMatchObject({ state: "pending", noteId: choices[0].noteId, placement: "above" });
    expect(directionPlan(items, {}).directions).toEqual([]);
    const accepted: Record<string, DirectionDecision> = {
      "d-1": { ...start, state: "accept", text: " dolce " },
      "d-2": { ...blankDirection(items[1]), state: "accept", noteId: null },
    };
    const plan = directionPlan(items, accepted);
    expect(plan.directions).toEqual([{ candidateId: "d-1", kind: "words", text: "dolce", noteId: choices[0].noteId, placement: "above" }]);
    expect(plan.leftOut).toEqual(["mf"]);
  });

  it("remembers who read a row, and says so on the card", () => {
    const inv = inventory([row({ id: "c-1", text: "f", kind: "dynamic", mark: "f", source: "classifier" }), row({ id: "o-1", text: "p", kind: "dynamic", mark: "p" })]);
    expect(directionItems(inv).map((i) => [i.id, i.source])).toEqual([["c-1", "classifier"], ["o-1", "ocr"]]);
  });

  it("flags the same mark twice on one note", () => {
    const items = directionItems(inventory([row({ id: "a", text: "p", kind: "dynamic", mark: "p" }), row({ id: "b", text: "p", kind: "dynamic", mark: "p" })]));
    const accepted = Object.fromEntries(items.map((i) => [i.id, { ...blankDirection(i), state: "accept" as const }]));
    const plan = directionPlan(items, accepted);
    expect(plan.directions).toHaveLength(1);
    expect(plan.conflicts).toEqual(["“p” twice on one note"]);
  });
});

describe("directions in the review page", () => {
  it("accepts a direction and a dynamic and sends them with the confirmation to save-lyrics", async () => {
    window.localStorage.clear();
    const calls: { url: string; body?: string }[] = [];
    const inv = inventory([row({}), row({ id: "d-2", text: "mf", kind: "dynamic", mark: "mf", box: [150, 120, 180, 140], anchor: { staffIndex: 0, printedLine: 1, placement: "below", syllables: [{ text: "mf", measureInStaff: 0, noteOrdinalInMeasure: 2, notePitch: "D4", position: "attention", noteId: choices[1].noteId, distancePx: 5 }] } })]);
    global.fetch = jest.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body });
      if (String(url).endsWith("/notes"))
        return { ok: true, json: async () => ({ musicXmlSha256: "sha", notes: choices.map((c) => ({ id: c.noteId, measureLabel: "1", noteOrdinal: c.ordinal, pitch: c.pitch })) }) };
      if (String(url).endsWith("/save-lyrics")) return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => inv };
    }) as unknown as typeof fetch;
    render(<LyricCandidatesClient jobId="job-1" pageNumber={1} />);
    await waitFor(() => screen.getByLabelText("Direction text for cresc. poco a poco"));
    expect(screen.getByRole("heading", { name: "Directions and dynamics" })).toBeInTheDocument();
    expect(screen.getAllByText(/read by OCR, not yet checked/).length).toBe(2);
    fireEvent.change(screen.getByLabelText("Direction text for cresc. poco a poco"), { target: { value: "cresc." } });
    fireEvent.change(screen.getByLabelText("Dynamic mark for mf"), { target: { value: "f" } });
    const accepts = screen.getAllByRole("button", { name: "Accept" });
    accepts.forEach((button) => fireEvent.click(button));
    expect(screen.getByTestId("direction-state-d-1")).toHaveTextContent("accept");
    const open = await screen.findByRole("button", { name: "Add accepted lyrics to the score" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    expect(screen.getByRole("list", { name: "Directions to add" })).toHaveTextContent("cresc.");
    fireEvent.click(screen.getByLabelText(/I checked these syllables/));
    fireEvent.click(screen.getByRole("button", { name: "Add lyrics to the score" }));
    expect(await screen.findByText(/and 2 directions or dynamics/)).toBeInTheDocument();
    const posted = JSON.parse(calls.find((c) => c.url.endsWith("/save-lyrics"))!.body!);
    expect(posted.placements).toEqual([]);
    expect(posted.directions.map((d: Record<string, unknown>) => [d.candidateId, d.kind, d.text, d.mark, d.noteId, d.placement, d.textConfirmed, d.noteConfirmed])).toEqual([
      ["d-1", "words", "cresc.", undefined, choices[0].noteId, "above", true, true],
      ["d-2", "dynamic", "f", "f", choices[1].noteId, "below", true, true],
    ]);
  });
});
