import { AnchorStaff } from './scanner-lyric-anchors';

/**
 * Exact alignment of a part's decoded note tokens with the MusicXML note elements written from them.
 * The writer turns the token sequence into the score, so the two sequences must agree in length and in
 * rest/note kind; pitches may differ rarely (accidental handling) but not often. Anything less is refused
 * for that part, so a proposed note is either exactly the XML note or absent.
 */

const NOTE_LIKE = /^(note|rest|gracenote)/;
const MAX_PITCH_MISMATCH = 0.02;

export interface XmlNote {
  partId: string;
  measure: number;
  ordinal: number;
  rest: boolean;
  pitch: string | null;
}

/** noteId (the writer's JSON `[partId, measure, ordinal]`) for each `${staffIndex}:${tokenIndex}`. */
export function alignTokensToNotes(
  staves: AnchorStaff[],
  sequence: XmlNote[],
  partIndex: number
): Map<string, string> {
  const tokens: { staff: number; index: number; rest: boolean; pitch: string | null }[] = [];
  for (const staff of staves
    .filter((s) => s.partIndex === partIndex)
    .sort((a, b) => (a.systemIndex ?? 0) - (b.systemIndex ?? 0))) {
    staff.tokens.forEach((token, index) => {
      const name = String(token?.[0] ?? '');
      if (!NOTE_LIKE.test(name)) return;
      const rest = name.startsWith('rest');
      tokens.push({ staff: staff.index, index, rest, pitch: rest ? null : String(token[1] ?? '') });
    });
  }
  const notes = sequence.filter((n) => n.partId === `P${partIndex + 1}`);
  if (tokens.length !== notes.length) throw new Error('Token and XML note counts differ');
  const out = new Map<string, string>();
  let mismatched = 0;
  tokens.forEach((token, i) => {
    const note = notes[i];
    if (token.rest !== note.rest) throw new Error('Token and XML note/rest kinds differ');
    if (!token.rest && token.pitch !== note.pitch) mismatched += 1;
    out.set(
      `${token.staff}:${token.index}`,
      JSON.stringify([note.partId, note.measure, note.ordinal])
    );
  });
  if (tokens.length > 0 && mismatched / tokens.length > MAX_PITCH_MISMATCH)
    throw new Error('Token and XML pitches differ too often');
  return out;
}

/** Alignments for every part that aligns exactly; parts that do not are simply absent. */
export function alignAllParts(staves: AnchorStaff[], sequence: XmlNote[]): Map<string, string> {
  const merged = new Map<string, string>();
  for (const partIndex of new Set(staves.map((s) => s.partIndex ?? 0))) {
    try {
      for (const [key, id] of alignTokensToNotes(staves, sequence, partIndex)) merged.set(key, id);
    } catch {
      /* this part cannot be mapped exactly: the reviewer picks its notes by hand */
    }
  }
  return merged;
}
