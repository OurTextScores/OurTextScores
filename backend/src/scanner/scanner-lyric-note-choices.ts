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
  /** Grand staff only: which hand's notes the token belongs to. */
  hand?: 'upper' | 'lower';
}

const MAX_CHOICES = 30;
/** Notes of one chord share an x to within this (page px). */
const CHORD_X_PX = 8;

/**
 * The recognised notes around a lyric row, left to right, each with the writer's note id. Only notes that
 * aligned exactly with the MusicXML (`ids`) are offered, so every choice is a note the copy writer accepts.
 */
export function noteChoicesForRow(
  staff: AnchorStaff,
  box: number[],
  ids: Map<string, string>,
  margin = 160,
  /**
   * Collapse chord tones at one x into one choice, keeping `prefer` when it is among them. Hands are not told
   * apart: a direction or dynamic between a grand staff's staves belongs to the whole part.
   */
  collapseChords?: { prefer?: string | null }
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
    const hand = token[token.length - 1];
    found.push({
      noteId,
      x: where.x,
      pitch: String(token[1] ?? ''),
      measure,
      ordinal,
      ...(hand === 'upper' || hand === 'lower' ? { hand } : {})
    });
  });
  found.sort((a, b) => a.x - b.x);
  const kept = collapseChords
    ? found.filter((choice, i) => {
        const cluster = found.filter((other) => Math.abs(other.x - choice.x) <= CHORD_X_PX);
        const winner = cluster.find((o) => o.noteId === collapseChords.prefer) ?? cluster[0];
        return winner === choice && found.indexOf(choice) === i;
      })
    : found;
  return kept.slice(0, MAX_CHOICES).map((choice, i) => ({ ...choice, number: i + 1 }));
}
