import { attentionIsOrdered } from './scanner-locate';

/**
 * Where OCR'd lyric rows sit in the recognised score: staff, printed line, measure and the nearest
 * note. Geometry only; no text is attached to MusicXML.
 *
 * Note x positions come from the decoder's attention points (note-level, ordered-checked by
 * `attentionIsOrdered`), interpolated across the symbols the provider pruned. They are approximate,
 * so every syllable carries its distance to the chosen note and how the position was obtained.
 * Verse identity is never inferred: `printedLine` is only the row's rank under its staff.
 */

const STAFF_IMAGE_WIDTH = 1280;
const MAX_STAFF_GAP_FACTOR = 1.5;
/**
 * A syllable further than this (raster px; the scanner normalises pages to one width) from every note of
 * its measure is not sung there: it gets no note. Publisher and engraver credits under the last staff sit
 * 77-563 px from the nearest note; all 124 correct fresh-page placements were within 83 page px.
 */
export const MAX_NOTE_DISTANCE_PX = 100;

export interface AnchorSymbol {
  index: number;
  attention?: number[] | null;
}

export interface AnchorStaff {
  index: number;
  partIndex?: number;
  systemIndex?: number;
  region: number[];
  tokens: string[][];
  barLines?: number[];
  symbols?: AnchorSymbol[];
}

export interface OcrRowInput {
  id: string;
  box: [number, number, number, number];
  text: string;
}

export interface SyllableAnchor {
  text: string;
  x: number;
  measureInStaff: number;
  noteTokenIndex: number | null;
  notePitch: string | null;
  noteOrdinalInMeasure: number | null;
  distancePx: number | null;
  /** Page x of the chosen note, so a reviewer can be shown which note is meant. */
  noteX: number | null;
  position: 'attention' | 'interpolated' | 'none';
  /** The recognised score's note for this syllable (`[part, measure, ordinal]` as JSON), when the part aligns exactly. */
  noteId?: string | null;
  /** A single consonant at a row edge is the clipped tail of a neighbouring word: it gets no note. */
  fragment?: boolean;
}

export interface RowAnchor {
  staffIndex: number;
  partIndex: number | null;
  systemIndex: number | null;
  printedLine: number;
  syllables: SyllableAnchor[];
}

const isNoteLike = (token: string[] | undefined) =>
  !!token && /^(note|rest|gracenote)/.test(String(token[0] || ''));
const isBar = (token: string[] | undefined) => String(token?.[0] || '').startsWith('barline');

/** Whitespace-, hyphen- and underscore-separated pieces, each placed proportionally by characters. */
/**
 * Widths for placing pieces along an OCR row: one unit per character, except that a run of three or more
 * dots ("ziehn,......wir") counts as a single unit. Lyric lines space words widely to sit under their notes,
 * so letter and gap widths are not proportional to the text: weighting letters and punctuation was measured
 * and moved owner-confirmed placements to a neighbouring note. Only the ellipsis run is a known, large
 * distortion (it adds many characters that take almost no room).
 */
export function charWidths(text: string): number[] {
  const characters = [...text];
  const widths = characters.map(() => 1);
  for (let i = 0; i < characters.length; ) {
    if (characters[i] !== '.') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < characters.length && characters[j] === '.') j += 1;
    if (j - i >= 3) for (let k = i + 1; k < j; k += 1) widths[k] = 0;
    i = j;
  }
  return widths;
}

export function splitSyllables(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const cumulative = [0];
  for (const width of charWidths(text)) cumulative.push(cumulative[cumulative.length - 1] + width);
  const total = Math.max(1e-9, cumulative[cumulative.length - 1]);
  // A run of three or more dots separates words ("ziehn,......wir"); mask it so it splits the pieces.
  const masked = text.replace(/\.{3,}/g, (run) => ' '.repeat(run.length));
  const pattern = /[^\s\-–—_]+/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    // Punctuation-only OCR fragments cannot supply a sung syllable. Keep the original
    // widths so withholding a fragment never moves its neighbouring words.
    if (!/[\p{L}\p{N}]/u.test(match[0])) continue;
    // `cumulative` is per code point; the regex index is per UTF-16 unit, equal for BMP text.
    out.push({
      text: text.slice(match.index, match.index + match[0].length),
      start: cumulative[match.index] / total,
      end: cumulative[match.index + match[0].length] / total
    });
  }
  return out;
}

/** x (page px) for each note-like token of a staff, with how it was obtained. */
export function noteXPositions(
  staff: AnchorStaff
): Map<number, { x: number; how: 'attention' | 'interpolated' }> {
  const [left, , right] = staff.region;
  const width = right - left;
  const known = new Map<number, number>();
  for (const symbol of staff.symbols ?? []) {
    const a = symbol.attention?.[0];
    if (
      Number.isFinite(a) &&
      isNoteLike(staff.tokens[symbol.index]) &&
      attentionIsOrdered(staff.symbols, symbol.index)
    ) {
      known.set(
        symbol.index,
        left + Math.min(1, Math.max(0, (a as number) / STAFF_IMAGE_WIDTH)) * width
      );
    }
  }
  // Anchors for interpolation: known notes plus bar lines (page px), keyed by token index.
  const fixed = new Map(known);
  let barOrdinal = 0;
  staff.tokens.forEach((token, index) => {
    if (isBar(token) && staff.barLines && barOrdinal < staff.barLines.length) {
      fixed.set(index, staff.barLines[barOrdinal]);
      barOrdinal += 1;
    }
  });
  const marks = [...fixed.entries()].sort((a, b) => a[0] - b[0]);
  const result = new Map<number, { x: number; how: 'attention' | 'interpolated' }>();
  staff.tokens.forEach((token, index) => {
    if (!isNoteLike(token)) return;
    if (known.has(index)) {
      result.set(index, { x: known.get(index)!, how: 'attention' });
      return;
    }
    const before = [...marks].reverse().find(([i]) => i < index);
    const after = marks.find(([i]) => i > index);
    const lo = before ? before : ([-1, left] as [number, number]);
    const hi = after ? after : ([staff.tokens.length, right] as [number, number]);
    const fraction = (index - lo[0]) / Math.max(1, hi[0] - lo[0]);
    result.set(index, { x: lo[1] + fraction * (hi[1] - lo[1]), how: 'interpolated' });
  });
  return result;
}

/**
 * The staff a lyric row belongs to. Lyrics hang under their staff and a staff's detected region can
 * already include the lines beneath it, so a row may sit inside its own staff's region or just
 * below it. Among staves with notes whose region reaches the row (top above the row, bottom within
 * one staff height under it), the one whose bottom edge is nearest the row wins.
 */
function staffForRow(staves: AnchorStaff[], box: number[]): AnchorStaff | null {
  const centreY = (box[1] + box[3]) / 2;
  let best: AnchorStaff | null = null;
  let bestDistance = Infinity;
  for (const staff of staves) {
    if (!staff.tokens.some(isNoteLike)) continue;
    const [, top, , bottom] = staff.region;
    const height = bottom - top;
    if (centreY < top || centreY > bottom + MAX_STAFF_GAP_FACTOR * height) continue;
    const distance = Math.abs(bottom - centreY);
    if (distance < bestDistance) {
      best = staff;
      bestDistance = distance;
    }
  }
  return best;
}

export function anchorRows(rows: OcrRowInput[], staves: AnchorStaff[]): Map<string, RowAnchor> {
  const result = new Map<string, RowAnchor>();
  const byStaff = new Map<number, { row: OcrRowInput; staff: AnchorStaff }[]>();
  for (const row of rows) {
    const staff = staffForRow(staves, row.box);
    if (!staff) continue;
    byStaff.set(staff.index, [...(byStaff.get(staff.index) ?? []), { row, staff }]);
  }
  for (const entries of byStaff.values()) {
    const staff = entries[0].staff;
    const heights = entries.map(({ row }) => row.box[3] - row.box[1]).sort((a, b) => a - b);
    const tolerance = 0.6 * heights[Math.floor(heights.length / 2)];
    const ys = entries.map(({ row }) => (row.box[1] + row.box[3]) / 2).sort((a, b) => a - b);
    const lines: number[] = [];
    for (const y of ys)
      if (lines.length === 0 || y - lines[lines.length - 1] > tolerance) lines.push(y);
    const positions = noteXPositions(staff);
    const bars = staff.barLines ?? [];
    const barTokenIndices: number[] = [];
    staff.tokens.forEach((token, index) => isBar(token) && barTokenIndices.push(index));
    for (const { row } of entries) {
      const centreY = (row.box[1] + row.box[3]) / 2;
      const printedLine = lines.findIndex((y) => Math.abs(y - centreY) <= tolerance) + 1 || 1;
      const width = row.box[2] - row.box[0];
      const pieces = splitSyllables(row.text);
      const syllables: SyllableAnchor[] = pieces.map((piece, pieceIndex) => {
        const x = row.box[0] + ((piece.start + piece.end) / 2) * width;
        const measureInStaff = bars.filter((b) => b < x).length;
        const lowToken = measureInStaff === 0 ? -1 : (barTokenIndices[measureInStaff - 1] ?? -1);
        const highToken =
          barTokenIndices[measureInStaff] !== undefined
            ? barTokenIndices[measureInStaff]
            : staff.tokens.length;
        const inMeasure = [...positions.entries()]
          .filter(([i]) => i > lowToken && i < highToken)
          .sort((a, b) => a[0] - b[0]);
        const notes = inMeasure.filter(([i]) =>
          /^note|^gracenote/.test(String(staff.tokens[i][0]))
        );
        const noNote = {
          text: piece.text,
          x,
          measureInStaff,
          noteTokenIndex: null,
          notePitch: null,
          noteOrdinalInMeasure: null,
          distancePx: null,
          noteX: null,
          position: 'none' as const
        };
        const edge = pieceIndex === 0 || pieceIndex === pieces.length - 1;
        if (pieces.length >= 2 && edge && /^[b-df-hj-np-tv-xz]$/.test(piece.text)) {
          return { ...noNote, fragment: true };
        }
        if (notes.length === 0) return noNote;
        const [tokenIndex, where] = notes.reduce((a, b) =>
          Math.abs(a[1].x - x) <= Math.abs(b[1].x - x) ? a : b
        );
        if (Math.abs(where.x - x) > MAX_NOTE_DISTANCE_PX) return noNote;
        return {
          text: piece.text,
          x,
          measureInStaff,
          noteTokenIndex: tokenIndex,
          notePitch: String(staff.tokens[tokenIndex][1] ?? '') || null,
          noteOrdinalInMeasure: inMeasure.findIndex(([i]) => i === tokenIndex) + 1,
          distancePx: Math.abs(where.x - x),
          noteX: where.x,
          position: where.how
        };
      });
      result.set(row.id, {
        staffIndex: staff.index,
        partIndex: staff.partIndex ?? null,
        systemIndex: staff.systemIndex ?? null,
        printedLine,
        syllables
      });
    }
  }
  return result;
}
