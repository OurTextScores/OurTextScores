import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LyricCandidatesClient from "./lyric-candidates-client";
import {
  blankCandidate,
  buildCandidateExport,
  duplicateSlots,
  placementsFrom,
  setLine,
  setSlot,
  slotsElsewhere,
  proposedSyllables,
  reviewItems,
  setState,
  setText,
  type Inventory,
} from "./candidate-review-model";

const inventory: Inventory = {
  schemaVersion: "ots.lyric-candidate-inventory.v1",
  automaticAttachment: false,
  pageNumber: 2,
  raster: { checksumSha256: "r", width: 400, height: 300 },
  candidates: [
    {
      id: "c1",
      regionStatus: "review",
      reason: "insufficient-margin",
      box: [1, 2, 30, 40],
      rawConfidence: 0.8,
      calibratedConfidence: null,
      competingText: true,
    },
  ],
};

describe("candidate review model", () => {
  const d = blankCandidate(inventory.candidates[0]);

  it("never accepts empty text and withdraws acceptance on edit", () => {
    expect(setState(d, "accept").state).toBe("pending");
    const typed = setText(d, "dreams");
    const accepted = setState(typed, "accept");
    expect(accepted.state).toBe("accept");
    expect(setText(accepted, "dream").state).toBe("pending");
    expect(setState(accepted, "exclude").state).toBe("exclude");
  });

  it("exports page identity, boxes and no automatic attachment", () => {
    const out = buildCandidateExport("job-1", inventory, {});
    expect(out).toMatchObject({
      schemaVersion: "ots.lyric-candidate-decisions.v1",
      automaticAttachment: false,
      jobId: "job-1",
      pageNumber: 2,
      raster: { checksumSha256: "r" },
    });
    expect(out.decisions[0]).toMatchObject({ id: "c1", state: "pending", box: [1, 2, 30, 40] });
  });
});

const ocrInventory: Inventory = {
  ...inventory,
  ocrStatus: "ok",
  ocrRows: [
    {
      id: "ocr-1",
      box: [1, 2, 30, 40],
      text: "kind,",
      ocrConfidence: 0.99,
      regionCoverage: 0.8,
      semantic: "Lyrics",
      semanticScore: 0.84,
      proposedLyric: true,
      anchor: {
        staffIndex: 0,
        printedLine: 1,
        syllables: [
          { text: "kind", measureInStaff: 2, noteOrdinalInMeasure: 3, notePitch: "C4", position: "attention" as const },
        ],
      },
    },
    {
      id: "ocr-2",
      box: [50, 2, 90, 40],
      text: "a tempo.",
      ocrConfidence: 0.95,
      regionCoverage: 0.7,
      semantic: "DirectionText",
      semanticScore: 0.2,
      proposedLyric: false,
    },
  ],
};

describe("OCR rows", () => {
  it("replace bare boxes, prefill text, and record the original OCR and the gate's verdict", () => {
    const items = reviewItems(ocrInventory);
    expect(items.map((i) => [i.id, i.initialText, i.proposedLyric])).toEqual([
      ["ocr-1", "kind,", true],
      ["ocr-2", "a tempo.", false],
    ]);
    const edited = setText(blankCandidate(items[0]), "kind");
    expect(blankCandidate(items[0]).text).toBe("kind,");
    const out = buildCandidateExport("job-1", ocrInventory, { "ocr-1": setState(edited, "accept") });
    expect(out.decisions[0]).toMatchObject({
      id: "ocr-1",
      text: "kind",
      state: "accept",
      source: "ocr-row",
      originalOcrText: "kind,",
      proposedLyric: true,
    });
    expect(out.decisions[1]).toMatchObject({ text: "a tempo.", state: "pending", proposedLyric: false });
  });

  it("describes an anchor as an unconfirmed placement and exports it as a proposal", () => {
    const [first, second] = reviewItems(ocrInventory);
    expect(first.placement).toBe("Staff 1, printed line 1, measure 3 of the staff: kind→C4 (note 3)");
    expect(second.placement).toBeNull();
    const out = buildCandidateExport("job-1", ocrInventory, {});
    expect(out.decisions[0].proposedPlacement).toMatchObject({ printedLine: 1 });
    expect(out.decisions[1].proposedPlacement).toBeNull();
  });

  it("explains a row withheld for sitting under no staff", () => {
    const items = reviewItems({
      ...ocrInventory,
      ocrRows: [{ ...ocrInventory.ocrRows![0], proposedLyric: false, withheldReason: "no-staff" }],
    });
    expect(items[0].note).toMatch(/not under a staff/);
    expect(items[0].proposedLyric).toBe(false);
  });

  it("falls back to detector boxes when OCR found nothing", () => {
    expect(reviewItems({ ...inventory, ocrRows: [], ocrStatus: "ok" })[0].kind).toBe("box");
    expect(reviewItems(inventory)[0].initialText).toBe("");
  });
});

describe("LyricCandidatesClient", () => {
  beforeEach(() => {
    window.localStorage.clear();
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => inventory,
    })) as unknown as typeof fetch;
  });

  it("loads the page's inventory, serves crops from the job and accepts typed text", async () => {
    render(<LyricCandidatesClient jobId="job-1" pageNumber={2} />);
    await waitFor(() => screen.getByAltText("Detected lyric region"));
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/proxy/scanner/jobs/job-1/pages/2/lyric-candidates",
      { cache: "no-store" },
    );
    expect(screen.getByAltText("Detected lyric region")).toHaveAttribute(
      "src",
      "/api/proxy/scanner/jobs/job-1/pages/2/lyric-candidates/c1/crop",
    );
    expect(screen.getByText(/may be a direction or dynamic/)).toBeInTheDocument();
    const accept = screen.getByRole("button", { name: "Accept" });
    expect(accept).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "dreams" } });
    fireEvent.click(accept);
    expect(screen.getByTestId("accepted-count")).toHaveTextContent("1 accepted");
  });

  it("reports an unavailable inventory and an empty page", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    const { unmount } = render(<LyricCandidatesClient jobId="j" pageNumber={1} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("404"));
    unmount();
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ ...inventory, candidates: [] }),
    })) as unknown as typeof fetch;
    render(<LyricCandidatesClient jobId="j" pageNumber={1} />);
    await waitFor(() => screen.getByText(/No lyric regions were detected/));
  });
});

describe("LyricCandidatesClient with OCR rows", () => {
  it("shows the prefilled text with the gate's suggestion and accepts it unchanged", async () => {
    window.localStorage.clear();
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ocrInventory,
    })) as unknown as typeof fetch;
    render(<LyricCandidatesClient jobId="job-1" pageNumber={2} />);
    await waitFor(() => screen.getByText(/Suggested lyric/));
    expect(screen.getByText(/Withheld/)).toBeInTheDocument();
    // Neither row has notes to attach to here, so each keeps the whole-text field.
    expect(screen.getAllByRole("textbox").map((t) => (t as HTMLInputElement).value)).toEqual(["kind,", "a tempo."]);
    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]);
    expect(screen.getByTestId("accepted-count")).toHaveTextContent("1 accepted");
  });
});

describe("proposed syllables for the corrected copy", () => {
  const withIds: Inventory = {
    ...ocrInventory,
    ocrRows: ocrInventory.ocrRows!.map((r, i) => ({
      ...r,
      anchor: {
        staffIndex: 0,
        printedLine: i + 1,
        syllables: [
          { text: r.text, measureInStaff: 0, noteOrdinalInMeasure: 1, notePitch: "C4", position: "attention" as const, noteId: i === 0 ? '["P1",2,3]' : null },
        ],
      },
    })),
  };

  it("lists only accepted, unedited rows whose syllables have an exact note", () => {
    const accepted = { "ocr-1": setState(blankCandidate({ id: "ocr-1", initialText: "kind," }), "accept"), "ocr-2": setState(blankCandidate({ id: "ocr-2", initialText: "a tempo." }), "accept") };
    expect(proposedSyllables(withIds, accepted)).toEqual([
      { candidateId: "ocr-1", text: "kind,", noteId: '["P1",2,3]', printedLine: 1 },
    ]);
    // Not accepted, or edited after acceptance: nothing is proposed.
    expect(proposedSyllables(withIds, {})).toEqual([]);
    expect(proposedSyllables(withIds, { "ocr-1": { ...accepted["ocr-1"], text: "kind" } })).toEqual([]);
  });

  it("adds them to the copy form unconfirmed, with the proposed note and line", async () => {
    window.localStorage.clear();
    global.fetch = jest.fn(async (url: string) =>
      String(url).endsWith("/notes")
        ? { ok: true, json: async () => ({ musicXmlSha256: "x", notes: [{ id: '["P1",2,3]', partId: "P1", measure: 2, measureLabel: "2", noteOrdinal: 3, onsetQuarterNotes: 1, pitch: "C4", voice: "1", staff: "1", occupiedLines: [] }] }) }
        : { ok: true, json: async () => withIds },
    ) as unknown as typeof fetch;
    render(<LyricCandidatesClient jobId="job-1" pageNumber={2} />);
    await waitFor(() => screen.getAllByRole("button", { name: "Accept" }));
    expect(screen.queryByText(/proposed syllables from accepted rows/)).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]);
    const add = await screen.findByRole("button", { name: /Add 1 proposed syllables/ });
    fireEvent.click(add);
    expect(await screen.findByText("Syllable 1")).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox").filter((b) => /confirmed/.test(b.closest("label")?.textContent ?? ""));
    expect(boxes.length).toBe(3);
    expect(boxes.every((b) => !(b as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole("button", { name: "Download corrected score copy" })).toBeDisabled();
    // Adding again does not duplicate the same proposal.
    fireEvent.click(add);
    expect(screen.queryByText("Syllable 2")).toBeNull();
  });

  it("keeps the proposals disabled until the note choices load, so a late draft cannot wipe added rows", async () => {
    window.localStorage.clear();
    let release: (value: unknown) => void = () => undefined;
    const notesReady = new Promise((resolve) => (release = resolve));
    global.fetch = jest.fn(async (url: string) =>
      String(url).endsWith("/notes")
        ? notesReady.then(() => ({ ok: true, json: async () => ({ musicXmlSha256: "x", notes: [] }) }))
        : { ok: true, json: async () => withIds },
    ) as unknown as typeof fetch;
    render(<LyricCandidatesClient jobId="job-1" pageNumber={2} />);
    await waitFor(() => screen.getAllByRole("button", { name: "Accept" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]);
    const add = await screen.findByRole("button", { name: /Add 1 proposed syllables/ });
    expect(add).toBeDisabled();
    release(null);
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    expect(await screen.findByText("Syllable 1")).toBeInTheDocument();
  });

  it("proposes only the nearest syllable when several land on one note and line, and flags duplicates", () => {
    const crowded: Inventory = {
      ...ocrInventory,
      ocrRows: ocrInventory.ocrRows!.map((r, i) => ({
        ...r,
        anchor: {
          staffIndex: 0,
          printedLine: 1,
          syllables: [
            { text: i === 0 ? "far" : "near", measureInStaff: 0, noteOrdinalInMeasure: 1, notePitch: "C4", position: "attention" as const, noteId: '["P1",1,1]', distancePx: i === 0 ? 30 : 4 },
          ],
        },
      })),
    };
    const accepted = {
      "ocr-1": setState(blankCandidate({ id: "ocr-1", initialText: "kind," }), "accept"),
      "ocr-2": setState(blankCandidate({ id: "ocr-2", initialText: "a tempo." }), "accept"),
    };
    expect(proposedSyllables(crowded, accepted).map((p) => p.text)).toEqual(["near"]);
    expect(duplicateSlots([{ noteId: "n", printedLine: 1 }, { noteId: "n", printedLine: 2 }, { noteId: "n", printedLine: 1 }, { noteId: "", printedLine: 1 }])).toEqual([2]);
  });
});

describe("note decisions on each row", () => {
  const choices = [
    { number: 1, noteId: '["P1",1,1]', x: 100, pitch: "C4", measure: 1, ordinal: 1 },
    { number: 2, noteId: '["P1",1,2]', x: 160, pitch: "D4", measure: 1, ordinal: 2 },
    { number: 3, noteId: '["P1",1,3]', x: 220, pitch: "E4", measure: 1, ordinal: 3 },
  ];
  const syllable = (text: string, noteId: string | null, distancePx: number) => ({
    text,
    measureInStaff: 0,
    noteOrdinalInMeasure: 1,
    notePitch: "C4",
    position: "attention" as const,
    noteId,
    distancePx,
  });
  const rowWith = (syllables: ReturnType<typeof syllable>[], text = "wish -ing") => ({
    ...ocrInventory.ocrRows![0],
    text,
    noteChoices: choices,
    anchor: { staffIndex: 0, printedLine: 1, syllables },
  });
  const placed: Inventory = {
    ...ocrInventory,
    ocrRows: [rowWith([syllable("wish", choices[0].noteId, 5), syllable("ing", choices[1].noteId, 9)])],
  };

  it("starts with the proposed text under its note and blanks elsewhere, and any edit withdraws acceptance", () => {
    const [item] = reviewItems(placed);
    const start = blankCandidate(item);
    expect(start.slots).toEqual({ [choices[0].noteId]: "wish", [choices[1].noteId]: "ing" });
    let d = setState(start, "accept");
    d = setSlot(d, choices[2].noteId, "x");
    expect(d.state).toBe("pending");
    d = setSlot(setState(d, "accept"), choices[1].noteId, "");
    expect(d.state).toBe("pending");
    d = setLine(setState(d, "accept"), 2);
    expect(d.state).toBe("pending");
    const plan = placementsFrom([item], { [item.id]: setState(d, "accept") });
    expect(plan.placements).toEqual([
      { candidateId: "ocr-1", text: "wish", noteId: choices[0].noteId, printedLine: 2 },
      { candidateId: "ocr-1", text: "x", noteId: choices[2].noteId, printedLine: 2 },
    ]);
    expect(plan.conflicts).toEqual([]);
  });

  it("splits a lyric by typing its parts under neighbouring notes", () => {
    const [item] = reviewItems({ ...placed, ocrRows: [rowWith([syllable("hin-nen", choices[0].noteId, 5)], "hin-nen")] });
    let d = setSlot(blankCandidate(item), choices[0].noteId, "hin");
    d = setSlot(d, choices[1].noteId, "nen");
    const plan = placementsFrom([item], { [item.id]: setState(d, "accept") });
    expect(plan.placements.map((p) => [p.text, p.noteId])).toEqual([
      ["hin", choices[0].noteId],
      ["nen", choices[1].noteId],
    ]);
  });

  it("keeps a syllable with no note of its own as 'not placed' until the reviewer types it somewhere", () => {
    const crowded: Inventory = {
      ...placed,
      ocrRows: [rowWith([syllable("far", choices[0].noteId, 30), syllable("near", choices[0].noteId, 4)])],
    };
    const [item] = reviewItems(crowded);
    // The nearer syllable keeps the note; the other starts unplaced.
    const start = blankCandidate(item);
    expect(start.slots).toEqual({ [choices[0].noteId]: "near" });
    expect(start.unplaced).toEqual(["far"]);
    const accepted = { [item.id]: setState(start, "accept") };
    expect(placementsFrom([item], accepted).leftOut).toEqual(["far"]);
    const typed = { [item.id]: setState(setSlot(start, choices[1].noteId, "far"), "accept") };
    expect(placementsFrom([item], typed).leftOut).toEqual([]);
  });

  it("flags two rows that put text on one note and line", () => {
    const [a] = reviewItems(placed);
    const b = { ...a, id: "ocr-9" };
    const decisions = {
      [a.id]: setState(setSlot(blankCandidate(a), choices[2].noteId, "x"), "accept"),
      [b.id]: setState(setSlot(blankCandidate(b), choices[2].noteId, "y"), "accept"),
    };
    // b is a copy of a, so its proposed text collides too: every shared note is reported once.
    expect(placementsFrom([a, b], decisions).conflicts).toEqual(["wish / wish", "ing / ing", "x / y"]);
  });

  it("adds the accepted text under its notes to the score, including text typed under a blank note", async () => {
    window.localStorage.clear();
    const calls: { url: string; body?: string }[] = [];
    const inventory: Inventory = { ...placed, ocrRows: [rowWith([syllable("wish -ing", choices[0].noteId, 5)])] };
    global.fetch = jest.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body });
      if (String(url).endsWith("/notes"))
        return { ok: true, json: async () => ({ musicXmlSha256: "sha", notes: choices.map((c) => ({ id: c.noteId, measureLabel: "1", noteOrdinal: c.ordinal, pitch: c.pitch })) }) };
      if (String(url).endsWith("/save-lyrics")) return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => inventory };
    }) as unknown as typeof fetch;
    render(<LyricCandidatesClient jobId="job-1" pageNumber={2} />);
    await waitFor(() => screen.getByLabelText("Text for note 2 of wish -ing"));
    expect(screen.getByAltText(/numbered lines mark the notes/)).toHaveAttribute("src", expect.stringContaining("?view=placement"));
    // Split: "wish" stays on note 1 (edit the text), "ing" goes in the blank under note 2.
    fireEvent.change(screen.getByLabelText("Text for note 1 of wish -ing"), { target: { value: "wish" } });
    fireEvent.change(screen.getByLabelText("Text for note 2 of wish -ing"), { target: { value: "ing" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    const open = await screen.findByRole("button", { name: "Add accepted lyrics and staff text to the score" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    const confirm = screen.getByRole("button", { name: "Add to the score" });
    fireEvent.click(confirm);
    expect(await screen.findByText(/Added 2 lyric syllables to the scan's score/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View the score" })).toHaveAttribute("href", "/scanner/job-1");
    const posted = JSON.parse(calls.find((c) => c.url.endsWith("/save-lyrics"))!.body!);
    expect(posted.automaticAttachment).toBe(false);
    expect(posted.placements.map((p: { text: string; noteId: string; printedLine: number; noteConfirmed: boolean }) => [p.text, p.noteId, p.printedLine, p.noteConfirmed])).toEqual([
      ["wish", choices[0].noteId, 1, true],
      ["ing", choices[1].noteId, 1, true],
    ]);
  });

  it("shows the note row and the row's text for a decision saved by an older version of the page", async () => {
    window.localStorage.clear();
    // Version 1 stored {id, text, state}; version 2 added per-token `syllables`. Both must still show the text.
    window.localStorage.setItem(
      `ots-lyric-candidates-job-1-2-${placed.raster.checksumSha256}`,
      JSON.stringify({ "ocr-1": { id: "ocr-1", text: "wish -ing", state: "pending", printedLine: 1, syllables: [{ text: "wish", noteId: choices[0].noteId }, { text: "ing", noteId: choices[1].noteId }] } }),
    );
    global.fetch = jest.fn(async (url: string) =>
      String(url).endsWith("/notes")
        ? { ok: true, json: async () => ({ musicXmlSha256: "sha", notes: [] }) }
        : { ok: true, json: async () => placed },
    ) as unknown as typeof fetch;
    render(<LyricCandidatesClient jobId="job-1" pageNumber={2} />);
    await waitFor(() => screen.getByLabelText("Text for note 1 of wish -ing"));
    expect((screen.getByLabelText("Text for note 1 of wish -ing") as HTMLInputElement).value).toBe("wish");
    expect((screen.getByLabelText("Text for note 2 of wish -ing") as HTMLInputElement).value).toBe("ing");
    expect((screen.getByLabelText("Text for note 3 of wish -ing") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("wish -ing", { selector: "strong" })).toBeInTheDocument();
  });

  it("shows a note another row already fills, read-only, so a blank means no syllable anywhere", () => {
    const [a] = reviewItems(placed);
    const b = { ...a, id: "ocr-9", initialText: "next row", defaultSyllables: [{ text: "ich", noteId: choices[2].noteId }] };
    const decisions = { [b.id]: blankCandidate(b) };
    expect(slotsElsewhere([a, b], decisions, a.id, 1)).toEqual({ [choices[2].noteId]: { text: "ich", rowText: "next row" } });
    // Another lyric line, an excluded row, and the row itself do not count.
    expect(slotsElsewhere([a, b], decisions, a.id, 2)).toEqual({});
    expect(slotsElsewhere([a, b], { [b.id]: { ...blankCandidate(b), state: "exclude" as const } }, a.id, 1)).toEqual({});
    expect(slotsElsewhere([a, b], decisions, b.id, 1)).toEqual({ [choices[0].noteId]: { text: "wish", rowText: a.initialText }, [choices[1].noteId]: { text: "ing", rowText: a.initialText } });
  });
});
