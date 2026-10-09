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
  /** A `<chord/>` member of the previous note; absent counts as false. */
  chord?: boolean;
}

/**
 * noteId (the writer's JSON `[partId, measure, ordinal]`) for each `${staffIndex}:${tokenIndex}`.
 *
 * Tokens list simultaneous notes as a chord run (`note`, `chord`, `note`, ...), and for a grand staff a run
 * can hold both hands' notes, while the XML writes each hand's notes as separate chord groups. So the two
 * sequences are compared as runs: a token run matches the XML groups that together hold the same number of
 * notes, and notes inside a run are paired by pitch (so the order within a chord does not matter).
 */
export function alignTokensToNotes(
  staves: AnchorStaff[],
  sequence: XmlNote[],
  partIndex: number
): Map<string, string> {
  type Token = { staff: number; index: number; rest: boolean; pitch: string | null };
  const runs: Token[][] = [];
  for (const staff of staves
    .filter((s) => s.partIndex === partIndex)
    .sort((a, b) => (a.systemIndex ?? 0) - (b.systemIndex ?? 0))) {
    let joined = false;
    staff.tokens.forEach((token, index) => {
      const name = String(token?.[0] ?? '');
      if (name === 'chord') {
        joined = true;
        return;
      }
      if (!NOTE_LIKE.test(name)) return;
      const rest = name.startsWith('rest');
      const entry = {
        staff: staff.index,
        index,
        rest,
        pitch: rest ? null : String(token[1] ?? '')
      };
      if (joined && runs.length > 0) runs[runs.length - 1].push(entry);
      else runs.push([entry]);
      joined = false;
    });
  }
  const notes = sequence.filter((n) => n.partId === `P${partIndex + 1}`);
  const groups: XmlNote[][] = [];
  for (const note of notes) {
    if (note.chord && groups.length > 0) groups[groups.length - 1].push(note);
    else groups.push([note]);
  }
  const tokenCount = runs.reduce((sum, run) => sum + run.length, 0);
  if (tokenCount !== notes.length) throw new Error('Token and XML note counts differ');
  const out = new Map<string, string>();
  let mismatched = 0;
  let next = 0;
  for (const run of runs) {
    const pool: XmlNote[] = [];
    while (pool.length < run.length && next < groups.length) pool.push(...groups[next++]);
    if (pool.length !== run.length) throw new Error('Token and XML chord groups differ');
    const unused = [...pool];
    const unmatched: Token[] = [];
    for (const token of run) {
      const at = unused.findIndex(
        (n) => n.rest === token.rest && (token.rest || n.pitch === token.pitch)
      );
      if (at >= 0) assign(token, unused.splice(at, 1)[0]);
      else unmatched.push(token);
    }
    for (const token of unmatched) {
      const at = unused.findIndex((n) => n.rest === token.rest);
      if (at < 0) throw new Error('Token and XML note/rest kinds differ');
      if (!token.rest) mismatched += 1;
      assign(token, unused.splice(at, 1)[0]);
    }
  }
  function assign(token: Token, note: XmlNote) {
    out.set(
      `${token.staff}:${token.index}`,
      JSON.stringify([note.partId, note.measure, note.ordinal])
    );
  }
  if (tokenCount > 0 && mismatched / tokenCount > MAX_PITCH_MISMATCH)
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
