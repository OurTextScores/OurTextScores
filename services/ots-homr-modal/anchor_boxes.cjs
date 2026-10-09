// node anchor_boxes.cjs <jobDataDir> <e4Dir> <out.json>: for every Dynamic box, the XML part/measure/note it anchors to.
const fs = require('fs');
const dist = '/home/jhlusko/workspace/OurTextScores/backend/dist/scanner/';
const { anchorDirectionRows } = require(dist + 'scanner-lyric-anchors.js');
const { alignAllParts } = require(dist + 'scanner-lyric-note-alignment.js');
const { reviewedLyricNotes } = require(dist + 'scanner-reviewed-lyric-copy.js');
const [data, e4, out] = process.argv.slice(2);
const result = {};
for (const file of fs.readdirSync(e4).filter((f) => f.endsWith('.json'))) {
  const id = file.replace('.json', '');
  const staves = JSON.parse(fs.readFileSync(`${data}/${id}.staves.json`, 'utf8'));
  const ids = alignAllParts(staves, reviewedLyricNotes(fs.readFileSync(`${data}/${id}.musicxml`)).sequence);
  const boxes = JSON.parse(fs.readFileSync(`${e4}/${file}`, 'utf8')).dynamicBoxes;
  const rows = boxes.map((b, i) => ({ id: String(i), box: [b.left, b.top, b.right, b.bottom], text: 'd', kind: 'dynamic' }));
  const anchors = anchorDirectionRows(rows, staves);
  result[id] = boxes.map((b, i) => {
    const a = anchors.get(String(i));
    const s = a && a.syllables[0];
    const noteId = s && s.noteTokenIndex !== null ? ids.get(`${a.staffIndex}:${s.noteTokenIndex}`) : null;
    const parsed = noteId ? JSON.parse(noteId) : null;
    return { ...b, part: parsed ? Number(parsed[0].slice(1)) - 1 : null, measure: parsed ? parsed[1] : null, ordinal: parsed ? parsed[2] : null };
  });
}
fs.writeFileSync(out, JSON.stringify(result));
console.log(Object.fromEntries(Object.entries(result).map(([k, v]) => [k.slice(0, 8), [v.length, v.filter((x) => x.measure !== null).length]])));
