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
              pitch: pitch ? `${text(pitch, 'step')}${text(pitch, 'octave')}` : null
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
              node: element.note
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
    notes: inventory.notes.map(({ node, ...note }) => note)
  };
}

/** Only explicit fully confirmed syllables; never modifies the stored score. */
export function applyReviewedLyricCopy(body: Buffer, request: any, allowedIds: Set<string>) {
  const inventory = reviewedLyricNotes(body);
  if (
    request?.musicXmlSha256 !== inventory.musicXmlSha256 ||
    request?.automaticAttachment !== false
  )
    throw new Error('Score identity changed or review is not explicit');
  if (
    !Array.isArray(request.placements) ||
    !request.placements.length ||
    request.placements.length > 1000
  )
    throw new Error('Require between 1 and 1000 confirmed syllables');
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
  const output = Buffer.from(
    new XMLBuilder({ preserveOrder: true, ignoreAttributes: false, processEntities: true }).build(
      inventory.document
    )
  );
  parseValidMusicXml(output);
  // Parse both documents and remove lyrics: serialization must preserve all other content.
  const strip = (nodes: Node[]): Node[] =>
    nodes
      .filter((n) => !('lyric' in n))
      .map((n) =>
        Object.fromEntries(Object.entries(n).map(([k, v]) => [k, Array.isArray(v) ? strip(v) : v]))
      );
  const before = orderedParser().parse(body.toString('utf8'));
  const after = orderedParser().parse(output.toString('utf8'));
  if (JSON.stringify(strip(before)) !== JSON.stringify(strip(after)))
    throw new Error('Non-lyric score content changed');
  return output;
}
