import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LyricCandidatesClient from "./lyric-candidates-client";
import {
  blankCandidate,
  buildCandidateExport,
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
    expect(screen.getAllByRole("textbox").map((t) => (t as HTMLInputElement).value)).toEqual(["kind,", "a tempo."]);
    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]);
    expect(screen.getByTestId("accepted-count")).toHaveTextContent("1 accepted");
  });
});
