/** Pure state model for the printed-line lyric placement review. */

export const DECISION_SCHEMA = "ots.lyric-placement-decisions.v2";

export type GeneratedNote = {
  physical_measure: number;
  onset_quarters: string;
  pitch: string;
  [key: string]: unknown;
};

export type InventoryRow = {
  id: string;
  score: string;
  text: string;
  physicalRowOrder: number;
  generatedNote: GeneratedNote;
  image: string;
  pageSha256: string;
  musicXmlSha256: string;
  predictions_sha256: string;
};

export type Decision = {
  id: string;
  text: string;
  printedLine: number | null;
  textConfirmed: boolean;
  verseConfirmed: boolean;
  noteConfirmed: boolean;
  excluded: boolean;
};

export const blankDecision = (row: InventoryRow): Decision => ({
  id: row.id,
  text: row.text,
  printedLine: null,
  textConfirmed: false,
  verseConfirmed: false,
  noteConfirmed: false,
  excluded: false,
});

export const printedLines = (inventory: InventoryRow[], score: string) =>
  [
    ...new Set(
      inventory.filter((r) => r.score === score).map((r) => r.physicalRowOrder),
    ),
  ].sort((a, b) => a - b);

export const isReady = (row: InventoryRow, d: Decision) =>
  !d.excluded &&
  d.text === row.text &&
  d.text.trim() !== "" &&
  d.printedLine !== null &&
  d.textConfirmed &&
  d.verseConfirmed &&
  d.noteConfirmed;

/** Each edit invalidates exactly the confirmations it could have made stale. */
export function applyChange(
  row: InventoryRow,
  d: Decision,
  change:
    | { text: string }
    | { printedLine: number | null }
    | { textConfirmed: boolean }
    | { verseConfirmed: boolean }
    | { noteConfirmed: boolean }
    | { excluded: boolean },
): Decision {
  if ("text" in change)
    return {
      ...d,
      text: change.text,
      textConfirmed: false,
      noteConfirmed: false,
    };
  if ("printedLine" in change)
    return { ...d, printedLine: change.printedLine, verseConfirmed: false };
  if ("textConfirmed" in change)
    return { ...d, textConfirmed: change.textConfirmed && d.text.trim() !== "" };
  if ("verseConfirmed" in change)
    return {
      ...d,
      verseConfirmed: change.verseConfirmed && d.printedLine !== null,
    };
  if ("noteConfirmed" in change)
    return {
      ...d,
      noteConfirmed: change.noteConfirmed && d.text === row.text,
    };
  return { ...d, excluded: change.excluded };
}

export function buildExport(
  inventory: InventoryRow[],
  decisions: Record<string, Decision>,
) {
  return {
    schemaVersion: DECISION_SCHEMA,
    automaticAttachment: false,
    decisions: inventory.map((r) => ({
      ...(decisions[r.id] ?? blankDecision(r)),
      score: r.score,
      pageSha256: r.pageSha256,
      musicXmlSha256: r.musicXmlSha256,
      generatedNote: r.generatedNote,
      predictions_sha256: r.predictions_sha256,
    })),
  };
}
