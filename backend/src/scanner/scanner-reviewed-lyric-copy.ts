import { createHash } from 'node:crypto';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { parseValidMusicXml } from './scanner-musicxml';

type Node = Record<string, any>;
const orderedParser = () =>
  new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: true
  });
const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const text = (nodes: Node[], tag: string): string =>
  String(nodes.find((n) => tag in n)?.[tag]?.find((n: Node) => '#text' in n)?.['#text'] ?? '');

/** Physical note identities include rests/chords in the ordinal, matching MusicXML. */
export function reviewedLyricNotes(body: Buffer) {
  const parsed = parseValidMusicXml(body);
  if (parsed.rootName !== 'score-partwise') throw new Error('Require a partwise score');
  const document = orderedParser().parse(body.toString('utf8'));
  const root = document.find((n: Node) => 'score-partwise' in n)['score-partwise'];
  const partList = root.find((n: Node) => 'part-list' in n)?.['part-list'] ?? [];
  const notes: any[] = [];
  /** Every note element (rests and chords included) in score order, for aligning with decoded tokens. */
  const sequence: {
    partId: string;
    measure: number;
    ordinal: number;
    rest: boolean;
    pitch: string | null;
    /** The MusicXML note is a `<chord/>` member (sounds with the previous note). */
    chord: boolean;
  }[] = [];
  root
    .filter((n: Node) => 'part' in n)
    .forEach((part: Node) => {
      const partId = part[':@']?.['@_id'];
      const partDefinition = partList.find(
        (n: Node) => 'score-part' in n && n[':@']?.['@_id'] === partId
      );
      const partName = partDefinition ? text(partDefinition['score-part'], 'part-name') : partId;
      let divisions = 1;
      part.part
        .filter((n: Node) => 'measure' in n)
        .forEach((measure: Node, mi: number) => {
          let ordinal = 0;
          let cursor = 0;
          let previousOnset = 0;
          for (const element of measure.measure) {
            if ('attributes' in element) {
              const raw = text(element.attributes, 'divisions');
              if (raw) divisions = Number(raw);
            }
            if ('backup' in element) cursor -= Number(text(element.backup, 'duration')) / divisions;
            if ('forward' in element)
              cursor += Number(text(element.forward, 'duration')) / divisions;
            if (!('note' in element)) continue;
            if (!Number.isFinite(divisions) || divisions <= 0)
              throw new Error('Invalid note timing');
            const chord = element.note.some((n: Node) => 'chord' in n);
            const onset = chord ? previousOnset : cursor;
            const duration = Number(text(element.note, 'duration') || '0') / divisions;
            if (!Number.isFinite(onset) || !Number.isFinite(duration) || duration < 0)
              throw new Error('Invalid note timing');
            if (!chord) {
              previousOnset = onset;
              cursor += duration;
            }
            ordinal += 1;
            const pitch = element.note.find((n: Node) => 'pitch' in n)?.pitch;
            sequence.push({
              partId,
              measure: mi + 1,
              ordinal,
              rest: !pitch,
              pitch: pitch ? `${text(pitch, 'step')}${text(pitch, 'octave')}` : null,
              chord
            });
            if (!pitch) continue;
            const alter = text(pitch, 'alter');
            notes.push({
              id: JSON.stringify([partId, mi + 1, ordinal]),
              partId,
              partName,
              measure: mi + 1,
              measureLabel: measure[':@']?.['@_number'] ?? String(mi + 1),
              noteOrdinal: ordinal,
              onsetQuarterNotes: onset,
              durationQuarterNotes: duration,
              pitch: `${text(pitch, 'step')}${alter === '1' ? '♯' : alter === '-1' ? '♭' : alter && alter !== '0' ? `(${alter})` : ''}${text(pitch, 'octave')}`,
              voice: text(element.note, 'voice'),
              staff: text(element.note, 'staff') || '1',
              occupiedLines: element.note
                .filter((n: Node) => 'lyric' in n)
                .map((n: Node) => String(n[':@']?.['@_number'] ?? '1')),
              node: element.note,
              measureNodes: measure.measure,
              element
            });
          }
        });
    });
  return { document, musicXmlSha256: hash(body), notes, sequence };
}

export function lyricNoteInventory(body: Buffer) {
  const inventory = reviewedLyricNotes(body);
  return {
    musicXmlSha256: inventory.musicXmlSha256,
    notes: inventory.notes.map(({ node, measureNodes, element, ...note }) => note)
  };
}

const REVIEW_DIRECTION_ID = 'ots-review-';
const DYNAMIC_ELEMENTS = new Set([
  'p',
  'pp',
  'ppp',
  'mp',
  'mf',
  'f',
  'ff',
  'fff',
  'sf',
  'sfz',
  'fp',
  'rf',
  'rfz',
  'fz',
  'sfp'
]);

const isReviewDirection = (n: Node) =>
  'direction' in n && String(n[':@']?.['@_id'] ?? '').startsWith(REVIEW_DIRECTION_ID);

/** Remove what a review adds: lyrics, and (when asked) the directions it wrote, which carry an ots-review id. */
function stripReviewAdditions(nodes: Node[], directions: boolean): Node[] {
  return nodes
    .filter((n) => !('lyric' in n) && !(directions && isReviewDirection(n)))
    .map((n) =>
      Object.fromEntries(
        Object.entries(n).map(([k, v]) => [
          k,
          Array.isArray(v) ? stripReviewAdditions(v, directions) : v
        ])
      )
    );
}

/** One confirmed written direction or dynamic mark, as a `<direction>` placed before its note. */
function directionElement(row: any, hasStaff: string): Node {
  const dynamic = row.kind === 'dynamic';
  const type = dynamic
    ? [{ dynamics: [{ [row.mark]: [] }] }]
    : [{ words: [{ '#text': row.text.trim() }] }];
  return {
    direction: [
      { 'direction-type': type },
      ...(hasStaff ? [{ staff: [{ '#text': hasStaff }] }] : [])
    ],
    ':@': {
      '@_placement': row.placement,
      '@_id': `${REVIEW_DIRECTION_ID}${createHash('sha256')
        .update(`${row.candidateId}:${row.noteId}:${row.kind}:${row.text}`)
        .digest('hex')
        .slice(0, 12)}`
    }
  };
}

function checkedDirections(request: any, allowedIds: Set<string>, notes: any[]): any[] {
  const rows = request.directions ?? [];
  if (!Array.isArray(rows) || rows.length > 200) throw new Error('Too many directions');
  const ids = new Set<string>();
  const slots = new Set<string>();
  for (const row of rows) {
    const note = notes.find((n) => n.id === row?.noteId);
    const mark = row?.kind === 'dynamic' ? row.mark : undefined;
    if (
      !allowedIds.has(row?.candidateId) ||
      typeof row.id !== 'string' ||
      ids.has(row.id) ||
      row.textConfirmed !== true ||
      row.noteConfirmed !== true ||
      (row.kind !== 'words' && row.kind !== 'dynamic') ||
      (row.kind === 'dynamic' && !DYNAMIC_ELEMENTS.has(String(mark))) ||
      typeof row.text !== 'string' ||
      !row.text.trim() ||
      row.text.length > 200 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(row.text) ||
      (row.placement !== 'above' && row.placement !== 'below') ||
      !note
    )
      throw new Error('Require unique, fully confirmed direction text, kind, placement and note');
    // One identical direction per note; the same text twice on a note is a duplicate, not a second mark.
    const slot = `${row.noteId}:${row.kind}:${row.kind === 'dynamic' ? mark : row.text.trim()}`;
    if (slots.has(slot)) throw new Error('Duplicate direction on a note');
    slots.add(slot);
    ids.add(row.id);
  }
  return rows;
}

/** Only explicit fully confirmed syllables and directions; never modifies the stored score. */
export function applyReviewedLyricCopy(body: Buffer, request: any, allowedIds: Set<string>) {
  const inventory = reviewedLyricNotes(body);
  if (
    request?.musicXmlSha256 !== inventory.musicXmlSha256 ||
    request?.automaticAttachment !== false
  )
    throw new Error('Score identity changed or review is not explicit');
  const directions = checkedDirections(request, allowedIds, inventory.notes);
  if (
    !Array.isArray(request.placements) ||
    (!request.placements.length && !directions.length) ||
    request.placements.length > 1000
  )
    throw new Error('Require between 1 and 1000 confirmed syllables, or confirmed directions');
  const occupied = new Set<string>();
  const ids = new Set<string>();
  for (const row of request.placements) {
    if (
      !allowedIds.has(row?.candidateId) ||
      typeof row.id !== 'string' ||
      ids.has(row.id) ||
      row.textConfirmed !== true ||
      row.lineConfirmed !== true ||
      row.noteConfirmed !== true ||
      typeof row.text !== 'string' ||
      !row.text.trim() ||
      row.text.length > 200 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(row.text) ||
      !Number.isInteger(row.printedLine) ||
      row.printedLine < 1 ||
      row.printedLine > 20
    )
      throw new Error('Require unique, fully confirmed syllable, printed line and note');
    const note = inventory.notes.find((n) => n.id === row.noteId);
    const slot = `${row.noteId}:${row.printedLine}`;
    if (!note || occupied.has(slot) || note.occupiedLines.includes(String(row.printedLine)))
      throw new Error('Unknown note or occupied lyric line');
    occupied.add(slot);
    ids.add(row.id);
    note.node.push({
      lyric: [{ text: [{ '#text': row.text.trim() }] }],
      ':@': { '@_number': String(row.printedLine) }
    });
  }
  for (const row of directions) {
    const note = inventory.notes.find((n) => n.id === row.noteId)!;
    const at = note.measureNodes.indexOf(note.element);
    const hasStaff = String(
      note.element.note.find((n: Node) => 'staff' in n)?.staff?.[0]?.['#text'] ?? ''
    );
    note.measureNodes.splice(at, 0, directionElement(row, hasStaff));
  }
  const output = Buffer.from(
    new XMLBuilder({ preserveOrder: true, ignoreAttributes: false, processEntities: true }).build(
      inventory.document
    )
  );
  parseValidMusicXml(output);
  // Parse both documents and remove what a review adds: serialization must preserve all other content.
  const before = orderedParser().parse(body.toString('utf8'));
  const after = orderedParser().parse(output.toString('utf8'));
  if (
    JSON.stringify(stripReviewAdditions(before, true)) !==
    JSON.stringify(stripReviewAdditions(after, true))
  )
    throw new Error('Non-lyric score content changed');
  return output;
}

/**
 * The score without any lyric elements: the base for adding reviewed lyrics. The scanner's recognition
 * writes none, so what this removes is only lyrics a previous review saved; saving again replaces them
 * instead of colliding with them. A score with no lyrics is returned byte for byte.
 */
export function withoutLyrics(body: Buffer): Buffer {
  if (!/<lyric[\s>]/.test(body.toString('utf8'))) return body;
  const strip = (nodes: Node[]): Node[] =>
    nodes
      .filter((n) => !('lyric' in n))
      .map((n) =>
        Object.fromEntries(Object.entries(n).map(([k, v]) => [k, Array.isArray(v) ? strip(v) : v]))
      );
  const document = orderedParser().parse(body.toString('utf8'));
  const output = Buffer.from(
    new XMLBuilder({ preserveOrder: true, ignoreAttributes: false, processEntities: true }).build(
      strip(document)
    )
  );
  parseValidMusicXml(output);
  return output;
}

/**
 * The score without anything a previous review added (lyrics and review-written directions): the base for a
 * fresh save, so saving again replaces rather than collides. Untouched scores are returned byte for byte.
 */
export function withoutReviewAdditions(body: Buffer): Buffer {
  const text = body.toString('utf8');
  if (!/<lyric[\s>]/.test(text) && !text.includes(REVIEW_DIRECTION_ID)) return body;
  const output = Buffer.from(
    new XMLBuilder({ preserveOrder: true, ignoreAttributes: false, processEntities: true }).build(
      stripReviewAdditions(orderedParser().parse(text), true)
    )
  );
  parseValidMusicXml(output);
  return output;
}
