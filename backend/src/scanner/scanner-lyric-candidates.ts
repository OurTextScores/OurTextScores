import { CropRect, padAndClamp } from './scanner-crop';

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

export interface LyricCandidateInventory {
  schemaVersion: typeof LYRIC_CANDIDATE_SCHEMA;
  automaticAttachment: false;
  pageNumber: number;
  raster: LyricRasterIdentity;
  textPolicy: unknown;
  candidates: LyricCandidate[];
}

function isBox(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) && value.length === 4 && value.every((n) => Number.isInteger(n) && n >= 0)
  );
}

export function buildLyricCandidateInventory(
  artifact: unknown,
  pageNumber: number,
  raster: LyricRasterIdentity
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
  return {
    schemaVersion: LYRIC_CANDIDATE_SCHEMA,
    automaticAttachment: false,
    pageNumber,
    raster,
    textPolicy: (artifact as { textPolicy?: unknown }).textPolicy ?? null,
    candidates
  };
}

/** The crop rectangle for one candidate, or null when it would be unreasonably large. */
export function lyricCandidateCrop(
  candidate: LyricCandidate,
  raster: LyricRasterIdentity
): CropRect | null {
  const rect = padAndClamp(candidate.box, CROP_PADDING_PX, raster);
  return rect.width * rect.height > MAX_CROP_PIXELS ? null : rect;
}
