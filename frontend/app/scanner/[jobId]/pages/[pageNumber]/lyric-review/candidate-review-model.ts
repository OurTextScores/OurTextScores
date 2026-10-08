/** Text review of detector-found lyric boxes. Transcription is manual: no OCR exists yet. */

export const CANDIDATE_DECISION_SCHEMA = "ots.lyric-candidate-decisions.v1";

export type Candidate = {
  id: string;
  regionStatus: "accepted" | "review";
  reason: string;
  box: [number, number, number, number];
  rawConfidence: number;
  calibratedConfidence: number | null;
  competingText: boolean;
};

export type OcrRow = {
  id: string;
  box: [number, number, number, number];
  text: string;
  ocrConfidence: number;
  regionCoverage: number;
  semantic: "Lyrics" | "DirectionText" | "Unknown";
  semanticScore: number | null;
  proposedLyric: boolean;
};

/** One thing to review: a detector box with no text, or an OCR row with its unreviewed text. */
export type ReviewItem = {
  id: string;
  kind: "box" | "ocr";
  box: [number, number, number, number];
  initialText: string;
  /** The semantic gate's suggestion; null for a bare detector box. */
  proposedLyric: boolean | null;
  note: string;
};

export type Inventory = {
  schemaVersion: string;
  automaticAttachment: false;
  pageNumber: number;
  raster: { checksumSha256: string; width: number; height: number };
  candidates: Candidate[];
  ocrRows?: OcrRow[];
  ocrStatus?: "ok" | "failed" | "absent";
};

export type CandidateDecision = {
  id: string;
  text: string;
  state: "pending" | "accept" | "exclude";
};

/** OCR rows when the provider read the page; otherwise the bare detector boxes. */
export function reviewItems(inventory: Inventory): ReviewItem[] {
  if (inventory.ocrRows && inventory.ocrRows.length > 0)
    return inventory.ocrRows.map((r) => ({
      id: r.id,
      kind: "ocr" as const,
      box: r.box,
      initialText: r.text,
      proposedLyric: r.proposedLyric,
      note: r.proposedLyric
        ? "Suggested lyric (text read by OCR, not yet checked)"
        : "Withheld: reads like a direction or unclear. You can still accept it.",
    }));
  return inventory.candidates.map((c) => ({
    id: c.id,
    kind: "box" as const,
    box: c.box,
    initialText: "",
    proposedLyric: null,
    note:
      (c.regionStatus === "review"
        ? `Needs review (${c.reason})`
        : "Detected") +
      (c.competingText ? " — may be a direction or dynamic" : ""),
  }));
}

export const blankCandidate = (c: { id: string; initialText?: string }): CandidateDecision => ({
  id: c.id,
  text: c.initialText ?? "",
  state: "pending",
});

/** Editing text withdraws an acceptance; empty text can never be accepted. */
export function setText(d: CandidateDecision, text: string): CandidateDecision {
  return { ...d, text, state: d.state === "accept" ? "pending" : d.state };
}

export function setState(
  d: CandidateDecision,
  state: CandidateDecision["state"],
): CandidateDecision {
  if (state === "accept" && d.text.trim() === "") return d;
  return { ...d, state };
}

export function buildCandidateExport(
  jobId: string,
  inventory: Inventory,
  decisions: Record<string, CandidateDecision>,
) {
  const items = reviewItems(inventory);
  return {
    schemaVersion: CANDIDATE_DECISION_SCHEMA,
    automaticAttachment: false,
    jobId,
    pageNumber: inventory.pageNumber,
    raster: inventory.raster,
    decisions: items.map((c) => ({
      ...(decisions[c.id] ?? blankCandidate(c)),
      box: c.box,
      source: c.kind === "ocr" ? "ocr-row" : "detector-box",
      originalOcrText: c.kind === "ocr" ? c.initialText : null,
      proposedLyric: c.proposedLyric,
    })),
  };
}
