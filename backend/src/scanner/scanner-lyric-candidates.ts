import { createHash } from 'node:crypto';
import { CropRect, padAndClamp } from './scanner-crop';
import { AnchorStaff, RowAnchor, anchorRows } from './scanner-lyric-anchors';

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
  /** Where the row sits in the recognised score; null when no staff could be assigned. */
  anchor: RowAnchor | null;
}

export interface LyricCandidateInventory {
  schemaVersion: typeof LYRIC_CANDIDATE_SCHEMA;
  automaticAttachment: false;
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
      anchor: null
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
  for (const row of ocrRows) row.anchor = anchors.get(row.id) ?? null;
  return {
    schemaVersion: LYRIC_CANDIDATE_SCHEMA,
    automaticAttachment: false,
    pageNumber,
    raster,
    textPolicy: (artifact as { textPolicy?: unknown }).textPolicy ?? null,
    candidates,
    ocrRows,
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
