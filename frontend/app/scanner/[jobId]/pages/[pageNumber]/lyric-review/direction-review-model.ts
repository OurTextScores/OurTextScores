/** Review of written directions ("cresc.", "dolce") and dynamic marks (p, mf) read from the scan by OCR. */
import type { Inventory, NoteChoice, OcrRow } from "./candidate-review-model";

export const DYNAMIC_MARKS = [
  "ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "sf", "sfz", "fp", "rf", "rfz", "fz", "sfp",
] as const;

export type DirectionDecision = {
  state: "pending" | "accept" | "exclude";
  text: string;
  /** A dynamic's mark; "" for words. */
  mark: string;
  noteId: string | null;
  placement: "above" | "below";
};

export type DirectionItem = {
  id: string;
  kind: "words" | "dynamic";
  initialText: string;
  noteChoices: NoteChoice[];
  defaultNoteId: string | null;
  defaultPlacement: "above" | "below";
  /** Where the scan puts it: the recognised note nearest its start, geometry only. */
  measureLabel: string | null;
  /** Who read it: the page OCR or the dynamics classifier. */
  source: "ocr" | "classifier";
};

export type DirectionPayload = {
  candidateId: string;
  kind: "words" | "dynamic";
  text: string;
  mark?: string;
  noteId: string;
  placement: "above" | "below";
};

/** Rows the scanner offered as directions or dynamics and did not withhold, in reading order. */
export function directionItems(inventory: Inventory): DirectionItem[] {
  return (inventory.ocrRows ?? [])
    .filter(
      (r: OcrRow) => (r.kind === "words" || r.kind === "dynamic") && r.proposedDirection === true,
    )
    .map((r) => {
      const syllable = r.anchor?.syllables[0];
      const choices = r.noteChoices ?? [];
      const noteId = syllable?.noteId ?? null;
      const chosen = choices.find((c) => c.noteId === noteId);
      return {
        id: r.id,
        kind: r.kind as "words" | "dynamic",
        initialText: r.kind === "dynamic" && r.mark ? r.mark : r.text,
        noteChoices: choices,
        defaultNoteId: noteId,
        defaultPlacement: r.anchor?.placement ?? "above",
        measureLabel: chosen ? `m${chosen.measure}` : null,
        source: r.source ?? "ocr",
      };
    });
}

export function blankDirection(item: DirectionItem): DirectionDecision {
  return {
    state: "pending",
    text: item.initialText,
    mark: item.kind === "dynamic" ? item.initialText : "",
    noteId: item.defaultNoteId,
    placement: item.defaultPlacement,
  };
}

export function withDirectionDefaults(
  d: DirectionDecision | undefined,
  item: DirectionItem,
): DirectionDecision {
  return d ?? blankDirection(item);
}

/** What the accepted directions would write, and the pairs that would collide on one note. */
export function directionPlan(
  items: DirectionItem[],
  decisions: Record<string, DirectionDecision>,
): { directions: DirectionPayload[]; conflicts: string[]; leftOut: string[] } {
  const directions: DirectionPayload[] = [];
  const leftOut: string[] = [];
  const seen = new Map<string, string>();
  const conflicts: string[] = [];
  for (const item of items) {
    const d = decisions[item.id];
    if (!d || d.state !== "accept") continue;
    const text = item.kind === "dynamic" ? d.mark : d.text.trim();
    if (!text) continue;
    if (!d.noteId) {
      leftOut.push(text);
      continue;
    }
    const key = `${d.noteId}|${item.kind}|${text}`;
    if (seen.has(key)) {
      conflicts.push(`“${text}” twice on one note`);
      continue;
    }
    seen.set(key, item.id);
    directions.push({
      candidateId: item.id,
      kind: item.kind,
      text,
      ...(item.kind === "dynamic" ? { mark: d.mark } : {}),
      noteId: d.noteId,
      placement: d.placement,
    });
  }
  return { directions, conflicts, leftOut };
}
