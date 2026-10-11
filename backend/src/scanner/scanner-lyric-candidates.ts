import { createHash } from 'node:crypto';
import { CropRect, padAndClamp } from './scanner-crop';
import { AnchorStaff, RowAnchor, anchorDirectionRows, anchorRows } from './scanner-lyric-anchors';
import { NoteChoice } from './scanner-lyric-note-choices';

/**
 * Lyric candidate inventory for one scanned page, derived only from the stored
 * `text-fusion-review` artifact. The detector boxes are the whole truth here: there is
 * no OCR, no semantic gate and no note anchor in the production provider yet, so
 * `text` is empty and every candidate is `textSource: 'none'` for a person to
 * transcribe. Nothing in this inventory attaches text to MusicXML.
 */

export const LYRIC_CANDIDATE_SCHEMA = 'ots.lyric-candidate-inventory.v1';
const MAX_CANDIDATES = 500;
const CROP_PADDING_PX = 24;
/**
 * Page furniture (imprint, plate number, folio) sits in the bottom margin. Across 483 OCR rows on 21 fresh pages every
 * row below 92% of the page height was such text and no lyric was; the cutoff is language-free.
 */
const FOOTER_FRACTION = 0.92;
const MAX_CROP_PIXELS = 4_000_000;

export interface LyricRasterIdentity {
  checksumSha256: string;
  width: number;
  height: number;
}

export interface LyricCandidate {
  id: string;
  regionStatus: 'accepted' | 'review';
  reason: string;
  box: [number, number, number, number];
  rawConfidence: number;
  calibratedConfidence: number | null;
  /** True when a direction/dynamic candidate overlaps the same region. */
  competingText: boolean;
  text: '';
  textSource: 'none';
}

/** One OCR row from the provider, with the frozen semantic gate's verdict. Text is unreviewed. */
export interface LyricOcrRow {
  id: string;
  box: [number, number, number, number];
  text: string;
  ocrConfidence: number;
  regionCoverage: number;
  semantic: 'Lyrics' | 'DirectionText' | 'Unknown';
  semanticScore: number | null;
  proposedLyric: boolean;
  /** 'lyric' (default), or a written direction ('words') / dynamic mark ('dynamic') offered for review. */
  kind?: 'lyric' | 'words' | 'dynamic';
  /** A dynamic row's canonical mark (p, mf, ...). */
  mark?: string;
  /** Who read a direction row: the page OCR, or the dynamics classifier (dynamic marks only). */
  source?: 'ocr' | 'classifier';
  /** The row is offered as a direction or dynamic (kind words/dynamic) and was not withheld. */
  proposedDirection?: boolean;
  /**
   * Offered, but the scanner could not tell which note it belongs to (no note near it): the reviewer chooses one or
   * excludes the row. Replaces withholding such rows as 'far-from-notes' (a real mark is often printed away from its note).
   */
  unplaced?: boolean;
  /** Where the row sits in the recognised score; null when no staff could be assigned. */
  anchor: RowAnchor | null;
  /** Recognised notes around the row, each a note the copy writer accepts; empty when the part did not align. */
  noteChoices?: NoteChoice[];
  /** Why a row the semantic gate liked was withheld anyway; null when it was not. */
  withheldReason: 'no-staff' | 'far-from-notes' | 'credit-like' | 'footer' | null;
}

/** Rows the provider offers as directions/dynamics, read from the same artifact. */
function readDirectionRows(artifact: unknown, raster: LyricRasterIdentity): LyricOcrRow[] {
  const direction = (artifact as { lyricText?: { directionRows?: { rows?: unknown[] } } })
    ?.lyricText?.directionRows;
  const out: LyricOcrRow[] = [];
  const seen = new Set<string>();
  for (const row of (Array.isArray(direction?.rows) ? direction!.rows : []) as Record<
    string,
    any
  >[]) {
    const box = row?.box;
    if (
      !isBox(box) ||
      box[2] <= box[0] ||
      box[3] <= box[1] ||
      box[2] > raster.width ||
      box[3] > raster.height ||
      (row.kind !== 'words' && row.kind !== 'dynamic')
    ) {
      throw new Error('Text fusion artifact has a direction row outside its page');
    }
    const id = createHash('sha256')
      .update(`${raster.checksumSha256}:direction:${box.join(',')}:${row.text}`)
      .digest('hex')
      .slice(0, 20);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id: `ocr-${id}`,
      box,
      text: String(row.text),
      ocrConfidence: Number(row.ocrConfidence),
      regionCoverage: 0,
      semantic: row.semantic,
      semanticScore: row.semanticScore === null ? null : Number(row.semanticScore),
      proposedLyric: false,
      kind: row.kind,
      ...(row.kind === 'dynamic' && typeof row.mark === 'string' ? { mark: row.mark } : {}),
      ...(row.source === 'ocr' || row.source === 'classifier' ? { source: row.source } : {}),
      proposedDirection: true,
      anchor: null,
      withheldReason: null
    });
  }
  return out;
}

export interface LyricCandidateInventory {
  schemaVersion: typeof LYRIC_CANDIDATE_SCHEMA;
  automaticAttachment: false;
  /** The engine whose reading this review anchors to and saves into (set by the scanner service, not the provider). */
  engineId?: string;
  pageNumber: number;
  raster: LyricRasterIdentity;
  textPolicy: unknown;
  candidates: LyricCandidate[];
  /** OCR rows selected by the lyric regions; empty when the provider ran no OCR. */
  ocrRows: LyricOcrRow[];
  ocrStatus: 'ok' | 'failed' | 'absent';
}

function isBox(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) && value.length === 4 && value.every((n) => Number.isInteger(n) && n >= 0)
  );
}

/**
 * Publisher, engraver and edition text that sits under a staff but is not sung: an imprint word, a copyright
 * mark, an address, or a run of three or more digits (plate and page numbers). Matches words in English,
 * German and French only; it is a guard for the common imprint, not a language model.
 */
export function looksLikeCredit(text: string): boolean {
  return (
    /©|copyright|\bverlag\b|\bedit(?:ions?|eur|or)\b|\béditeur\b|\bpubli(?:sh|é|e)|\bprinted\b|\bimprim|\bplate\b|\brue\b|\bstreet\b|\bstr\.|\bn[°º]\s*\d/i.test(
      text
    ) || /\d{3,}/.test(text)
  );
}

function readOcrRows(
  artifact: unknown,
  raster: LyricRasterIdentity
): { ocrRows: LyricOcrRow[]; ocrStatus: 'ok' | 'failed' | 'absent' } {
  const lyric = (artifact as { lyricText?: { status?: string; rows?: unknown[] } })?.lyricText;
  if (!lyric) return { ocrRows: [], ocrStatus: 'absent' };
  const ocrRows: LyricOcrRow[] = [];
  const seen = new Set<string>();
  for (const row of (Array.isArray(lyric.rows) ? lyric.rows : []) as Record<string, any>[]) {
    const box = row?.box;
    if (
      !isBox(box) ||
      box[2] <= box[0] ||
      box[3] <= box[1] ||
      box[2] > raster.width ||
      box[3] > raster.height
    ) {
      throw new Error('Text fusion artifact has an OCR row outside its page');
    }
    const id = createHash('sha256')
      .update(`${raster.checksumSha256}:${box.join(',')}:${row.text}`)
      .digest('hex')
      .slice(0, 20);
    if (seen.has(id)) continue; // identical text at an identical box is one row
    seen.add(id);
    ocrRows.push({
      id: `ocr-${id}`,
      box,
      text: String(row.text),
      ocrConfidence: Number(row.ocrConfidence),
      regionCoverage: Number(row.regionCoverage),
      semantic: row.semantic,
      semanticScore: row.semanticScore === null ? null : Number(row.semanticScore),
      proposedLyric: row.proposedLyric === true,
      anchor: null,
      withheldReason: null
    });
  }
  return { ocrRows, ocrStatus: lyric.status === 'failed' ? 'failed' : 'ok' };
}

export function buildLyricCandidateInventory(
  artifact: unknown,
  pageNumber: number,
  raster: LyricRasterIdentity,
  staves: AnchorStaff[] = []
): LyricCandidateInventory {
  const regions = (artifact as { fusedRegions?: unknown })?.fusedRegions;
  if (!Array.isArray(regions) || regions.length > MAX_CANDIDATES) {
    throw new Error('Text fusion artifact has no usable regions');
  }
  const seen = new Set<string>();
  const candidates: LyricCandidate[] = [];
  for (const region of regions) {
    if (region?.status !== 'accepted' && region?.status !== 'review') continue;
    const members = Array.isArray(region.candidates) ? region.candidates : [];
    for (const member of members) {
      if (member?.label !== 'Lyrics') continue;
      if (typeof member.id !== 'string' || seen.has(member.id)) {
        throw new Error('Text fusion artifact has a malformed or duplicate candidate');
      }
      if (
        !isBox(member.box) ||
        member.box[2] <= member.box[0] ||
        member.box[3] <= member.box[1] ||
        member.box[2] > raster.width ||
        member.box[3] > raster.height
      ) {
        throw new Error('Text fusion artifact has a box outside its page');
      }
      const raw = member.rawConfidence;
      if (typeof raw !== 'number' || !(raw >= 0 && raw <= 1)) {
        throw new Error('Text fusion artifact has an invalid confidence');
      }
      seen.add(member.id);
      candidates.push({
        id: member.id,
        regionStatus: region.status,
        reason: String(region.reason ?? ''),
        box: member.box,
        rawConfidence: raw,
        calibratedConfidence:
          typeof member.calibratedConfidence === 'number' ? member.calibratedConfidence : null,
        competingText: members.some((other: { label?: string }) => other.label !== 'Lyrics'),
        text: '',
        textSource: 'none'
      });
    }
  }
  // Reading order: top to bottom, then left to right, so a page reviews like it reads.
  candidates.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0] || a.id.localeCompare(b.id));
  const { ocrRows, ocrStatus } = readOcrRows(artifact, raster);
  const anchors = anchorRows(ocrRows, staves);
  for (const row of ocrRows) {
    row.anchor = anchors.get(row.id) ?? null;
    // Lyrics hang under a staff. With the score's staves in hand, a row no staff reaches is a title,
    // credit, page number or similar, whatever the text classifier thought of it.
    if (row.proposedLyric && (row.box[1] + row.box[3]) / 2 > FOOTER_FRACTION * raster.height) {
      row.proposedLyric = false;
      row.withheldReason = 'footer';
    } else if (staves.length > 0 && !row.anchor && row.proposedLyric) {
      row.proposedLyric = false;
      row.withheldReason = 'no-staff';
    } else if (row.proposedLyric && looksLikeCredit(row.text)) {
      row.proposedLyric = false;
      row.withheldReason = 'credit-like';
    } else if (
      row.anchor &&
      row.proposedLyric &&
      row.anchor.syllables.every((syllable) => syllable.noteTokenIndex === null)
    ) {
      // Under a staff but nowhere near one of its notes: a publisher or engraver credit, not a lyric.
      row.proposedLyric = false;
      row.withheldReason = 'far-from-notes';
    }
  }
  const directionRows = readDirectionRows(artifact, raster);
  const directionAnchors = anchorDirectionRows(
    directionRows.map((row) => ({
      id: row.id,
      box: row.box,
      text: row.text,
      kind: row.kind as 'words' | 'dynamic'
    })),
    staves
  );
  for (const row of directionRows) {
    row.anchor = directionAnchors.get(row.id) ?? null;
    const reject = (reason: NonNullable<LyricOcrRow['withheldReason']>) => {
      row.proposedDirection = false;
      row.withheldReason = reason;
    };
    // No footer rule: a direction is only offered when a staff reaches it, and a last system's "una corda"
    // or "poco rit." legitimately sits in the bottom margin. Plate numbers and imprints are caught as credits.
    if (row.kind === 'words' && looksLikeCredit(row.text)) reject('credit-like');
    else if (!row.anchor) reject('no-staff');
    else if (row.anchor.syllables.every((syllable) => syllable.noteTokenIndex === null))
      // A staff reaches it, the text passed the provider's checks, only the note is unknown: let a person choose.
      row.unplaced = true;
  }
  return {
    schemaVersion: LYRIC_CANDIDATE_SCHEMA,
    automaticAttachment: false,
    pageNumber,
    raster,
    textPolicy: (artifact as { textPolicy?: unknown }).textPolicy ?? null,
    candidates,
    ocrRows: [...ocrRows, ...directionRows],
    ocrStatus
  };
}

/** The crop rectangle for one candidate, or null when it would be unreasonably large. */
export function lyricCandidateCrop(
  candidate: { box: [number, number, number, number] },
  raster: LyricRasterIdentity
): CropRect | null {
  const rect = padAndClamp(candidate.box, CROP_PADDING_PX, raster);
  return rect.width * rect.height > MAX_CROP_PIXELS ? null : rect;
}

/**
 * An unplaced row is only useful when the reviewer has notes to choose from. When the part did not align (or no note
 * lies near enough), there are none, so the row goes back to being withheld as far from notes.
 */
export function settleUnplaced(row: LyricOcrRow): void {
  if (row.unplaced && (row.noteChoices?.length ?? 0) === 0) {
    row.unplaced = false;
    row.proposedDirection = false;
    row.withheldReason = 'far-from-notes';
  }
}
