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
  distancePx?: number | null;
};

export type RowAnchor = {
  staffIndex: number;
  printedLine: number;
  syllables: SyllableAnchor[];
};

export type NoteChoice = {
  number: number;
  noteId: string;
  x: number;
  pitch: string;
  measure: number;
  ordinal: number;
};

export type SyllableDecision = { text: string; noteId: string | null };

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
  noteChoices?: NoteChoice[];
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
  /** Notes the reviewer may attach this row's syllables to (exact notes the writer accepts). */
  noteChoices: NoteChoice[];
  defaultLine: number | null;
  defaultSyllables: SyllableDecision[];
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
  /** Placement for rows the scanner anchored: one entry per syllable (note null = leave it out). */
  printedLine?: number;
  syllables?: SyllableDecision[];
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
  if (inventory.ocrRows && inventory.ocrRows.length > 0) {
    // One syllable per note per printed line: where several proposals land on one note the nearest keeps it
    // and the others start as "leave out", so no default selection is one the copy writer would refuse.
    const best = new Map<string, number>();
    for (const r of inventory.ocrRows)
      for (const s of r.anchor?.syllables ?? []) {
        if (!s.noteId) continue;
        const key = `${s.noteId}|${r.anchor!.printedLine}`;
        const distance = s.distancePx ?? Number.POSITIVE_INFINITY;
        if (!best.has(key) || distance < best.get(key)!) best.set(key, distance);
      }
    const claimed = new Set<string>();
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
      noteChoices: r.noteChoices ?? [],
      defaultLine: r.anchor?.printedLine ?? null,
      defaultSyllables: (r.anchor?.syllables ?? []).map((s) => {
        const key = `${s.noteId}|${r.anchor!.printedLine}`;
        const wins =
          !!s.noteId &&
          !claimed.has(key) &&
          (s.distancePx ?? Number.POSITIVE_INFINITY) === best.get(key);
        if (wins) claimed.add(key);
        return { text: s.text, noteId: wins ? s.noteId! : null };
      }),
    }));
  }
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
    noteChoices: [],
    defaultLine: null,
    defaultSyllables: [],
  }));
}

export const blankCandidate = (c: {
  id: string;
  initialText?: string;
  defaultLine?: number | null;
  defaultSyllables?: SyllableDecision[];
}): CandidateDecision => ({
  id: c.id,
  text: c.initialText ?? "",
  state: "pending",
  ...(c.defaultSyllables && c.defaultSyllables.length > 0
    ? {
        printedLine: c.defaultLine ?? 1,
        syllables: c.defaultSyllables.map((x) => ({ ...x })),
      }
    : {}),
});

/** Any change to what the reviewer is accepting withdraws the acceptance. */
export function setSyllable(
  d: CandidateDecision,
  index: number,
  patch: Partial<SyllableDecision>,
): CandidateDecision {
  const syllables = (d.syllables ?? []).map((x, i) =>
    i === index ? { ...x, ...patch } : x,
  );
  return {
    ...d,
    syllables,
    state: d.state === "accept" ? "pending" : d.state,
  };
}

export function setLine(d: CandidateDecision, line: number): CandidateDecision {
  return { ...d, printedLine: line, state: d.state === "accept" ? "pending" : d.state };
}

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
      printedLine: (decisions[c.id] ?? blankCandidate(c)).printedLine ?? null,
      syllables: (decisions[c.id] ?? blankCandidate(c)).syllables ?? null,
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
 * points at. Edited rows are left out (corrected text needs fresh positioning by the reviewer). The copy
 * writer allows one syllable per note per printed line, so when several proposals land on the same note
 * and line only the one nearest its note is proposed; the rest are for the reviewer to place by hand.
 */
export function proposedSyllables(
  inventory: Inventory,
  decisions: Record<string, CandidateDecision>,
): ProposedSyllable[] {
  const best = new Map<string, { distance: number; item: ProposedSyllable }>();
  for (const row of inventory.ocrRows ?? []) {
    const decision = decisions[row.id];
    if (!decision || decision.state !== "accept" || decision.text !== row.text)
      continue;
    for (const syllable of row.anchor?.syllables ?? []) {
      if (!syllable.noteId) continue;
      const item = {
        candidateId: row.id,
        text: syllable.text,
        noteId: syllable.noteId,
        printedLine: row.anchor!.printedLine,
      };
      const key = `${item.noteId}|${item.printedLine}`;
      const distance = syllable.distancePx ?? Number.POSITIVE_INFINITY;
      const held = best.get(key);
      if (!held || distance < held.distance) best.set(key, { distance, item });
    }
  }
  return [...best.values()].map((entry) => entry.item);
}

/** Row indexes (0-based) that share a note and printed line with an earlier row; the writer refuses these. */
export function duplicateSlots(
  rows: { noteId: string; printedLine: number }[],
): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  rows.forEach((r, i) => {
    if (!r.noteId) return;
    const key = `${r.noteId}|${r.printedLine}`;
    if (seen.has(key)) out.push(i);
    seen.add(key);
  });
  return out;
}

export type Placement = {
  candidateId: string;
  text: string;
  noteId: string;
  printedLine: number;
};

/** What accepted rows put on the score: each syllable with a chosen note, plus any note/line collisions. */
export function placementsFrom(
  items: ReviewItem[],
  decisions: Record<string, CandidateDecision>,
): { placements: Placement[]; conflicts: string[]; leftOut: string[] } {
  const placements: Placement[] = [];
  const conflicts: string[] = [];
  const leftOut: string[] = [];
  const seen = new Map<string, string>();
  for (const item of items) {
    const d = decisions[item.id];
    if (!d || d.state !== "accept") continue;
    if (!d.syllables || d.syllables.length === 0) {
      if (d.text.trim()) leftOut.push(d.text);
      continue;
    }
    for (const syllable of d.syllables) {
      if (!syllable.text.trim()) continue;
      if (!syllable.noteId) {
        leftOut.push(syllable.text);
        continue;
      }
      const line = d.printedLine ?? 1;
      const key = `${syllable.noteId}|${line}`;
      if (seen.has(key)) {
        conflicts.push(`${seen.get(key)} / ${syllable.text}`);
        continue;
      }
      seen.set(key, syllable.text);
      placements.push({
        candidateId: item.id,
        text: syllable.text.trim(),
        noteId: syllable.noteId,
        printedLine: line,
      });
    }
  }
  return { placements, conflicts, leftOut };
}
