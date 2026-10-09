import { AnchorStaff, noteXPositions } from './scanner-lyric-anchors';

/** A note a syllable may be attached to, with where it sits on the page raster. */
export interface NoteChoice {
  /** 1-based, left to right: the number drawn on the placement crop. */
  number: number;
  noteId: string;
  x: number;
  pitch: string;
  measure: number;
  ordinal: number;
}

const MAX_CHOICES = 30;

/**
 * The recognised notes around a lyric row, left to right, each with the writer's note id. Only notes that
 * aligned exactly with the MusicXML (`ids`) are offered, so every choice is a note the copy writer accepts.
 */
export function noteChoicesForRow(
  staff: AnchorStaff,
  box: number[],
  ids: Map<string, string>,
  margin = 160
): NoteChoice[] {
  const positions = noteXPositions(staff);
  const found: Omit<NoteChoice, 'number'>[] = [];
  staff.tokens.forEach((token, index) => {
    if (!/^note/.test(String(token?.[0] ?? ''))) return;
    const noteId = ids.get(`${staff.index}:${index}`);
    const where = positions.get(index);
    if (!noteId || !where) return;
    if (where.x < box[0] - margin || where.x > box[2] + margin) return;
    const [, measure, ordinal] = JSON.parse(noteId);
    found.push({ noteId, x: where.x, pitch: String(token[1] ?? ''), measure, ordinal });
  });
  return found
    .sort((a, b) => a.x - b.x)
    .slice(0, MAX_CHOICES)
    .map((choice, i) => ({ ...choice, number: i + 1 }));
}
