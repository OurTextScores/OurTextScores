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

export type SyllableAnchor = {
  text: string;
  measureInStaff: number;
  noteOrdinalInMeasure: number | null;
  notePitch: string | null;
  position: "attention" | "interpolated" | "none";
  noteId?: string | null;
};

export type RowAnchor = {
  staffIndex: number;
  printedLine: number;
  syllables: SyllableAnchor[];
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
  anchor?: RowAnchor | null;
  withheldReason?: "no-staff" | "far-from-notes" | "credit-like" | "footer" | null;
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
  /** Where the row sits in the recognised score; geometry only, unconfirmed. */
  placement: string | null;
  anchor: RowAnchor | null;
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
export function describePlacement(anchor: RowAnchor | null | undefined): string | null {
  if (!anchor) return null;
  const notes = anchor.syllables
    .map((s) =>
      s.noteOrdinalInMeasure === null
        ? `${s.text}→?`
        : `${s.text}→${s.notePitch ?? "?"} (note ${s.noteOrdinalInMeasure}${s.position === "interpolated" ? ", estimated" : ""})`,
    )
    .join(", ");
  const measures = [...new Set(anchor.syllables.map((s) => s.measureInStaff + 1))].join("–");
  return `Staff ${anchor.staffIndex + 1}, printed line ${anchor.printedLine}, measure ${measures} of the staff: ${notes}`;
}

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
        : r.withheldReason === "no-staff"
          ? "Withheld: not under a staff (a title, credit or page number?). You can still accept it."
          : r.withheldReason === "far-from-notes"
            ? "Withheld: under a staff but far from its notes (a publisher or engraver credit?). You can still accept it."
            : r.withheldReason === "footer"
              ? "Withheld: in the page's bottom margin (an imprint, plate number or folio?). You can still accept it."
              : r.withheldReason === "credit-like"
              ? "Withheld: looks like a publisher, edition or plate-number line. You can still accept it."
            : "Withheld: reads like a direction or unclear. You can still accept it.",
      placement: describePlacement(r.anchor),
      anchor: r.anchor ?? null,
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
    placement: null,
    anchor: null,
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
      proposedPlacement: c.anchor,
    })),
  };
}

export type ProposedSyllable = {
  candidateId: string;
  text: string;
  noteId: string;
  printedLine: number;
};

/**
 * Syllables the scanner proposes for accepted, UNEDITED OCR rows, each with the exact recognised note it
 * points at. Edited rows are left out: corrected text needs fresh positioning by the reviewer.
 */
export function proposedSyllables(
  inventory: Inventory,
  decisions: Record<string, CandidateDecision>,
): ProposedSyllable[] {
  const out: ProposedSyllable[] = [];
  for (const row of inventory.ocrRows ?? []) {
    const decision = decisions[row.id];
    if (!decision || decision.state !== "accept" || decision.text !== row.text)
      continue;
    for (const syllable of row.anchor?.syllables ?? []) {
      if (syllable.noteId)
        out.push({
          candidateId: row.id,
          text: syllable.text,
          noteId: syllable.noteId,
          printedLine: row.anchor!.printedLine,
        });
    }
  }
  return out;
}
