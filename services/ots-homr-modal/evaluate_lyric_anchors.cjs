// Evaluate geometric lyric anchoring against the owner-confirmed placements.
// usage: node evaluate_lyric_anchors.cjs <dist/scanner/scanner-lyric-anchors.js> <truth.json> <review-dir> <original-sizes.json>
// For each confirmed syllable (page-px centre) a one-word row is anchored with the shipped anchorRows and
// compared with the confirmed printed line, page-global measure (up to a constant per page) and
// note ordinal within the measure. Measures and notes come from the scanner's own recognition run,
// which may differ from the run the confirmations were made against.
const fs = require('fs');
const path = require('path');
const { anchorRows } = require(path.resolve(process.argv[2]));
const truth = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const dir = process.argv[4];
const sizes = JSON.parse(fs.readFileSync(process.argv[5], 'utf8'));

const byScore = {};
for (const t of truth) (byScore[t.score] ||= []).push(t);
const out = { pages: {}, total: { n: 0, anchored: 0, lineOk: 0, measureOk: 0, noteOk: 0, noteWithinOne: 0 } };
for (const [score, rows] of Object.entries(byScore)) {
  const review = JSON.parse(fs.readFileSync(path.join(dir, `review-${score}.json`), 'utf8'));
  const scale = review.raster.w / sizes[score][0];
  const staves = review.staves;
  const measuresBefore = (staff) => {
    // measures of the same part in earlier systems: bar-line tokens + 1 per staff
    return staves
      .filter((s) => s.partIndex === staff.partIndex && s.systemIndex < staff.systemIndex)
      .reduce((n, s) => n + s.tokens.filter((t) => String(t[0]).startsWith('barline')).length + 1 - 1, 0);
  };
  const cases = rows.map((t) => {
    const w = 4;
    const cx = t.cx * scale;
    const cy = t.cy * scale;
    const row = { id: t.id, box: [cx - w, cy - 20, cx + w, cy + 20], text: 'x' };
    const a = anchorRows([row], staves).get(t.id);
    if (!a) return { t, anchored: false };
    const s = a.syllables[0];
    const staff = staves.find((st) => st.index === a.staffIndex);
    return { t, anchored: true, a, s, global: measuresBefore(staff) + s.measureInStaff, ordinal: s.noteOrdinalInMeasure, staff };
  });
  // printed line is ranked among rows of the same staff; recompute with all truth rows of the score together.
  const allRows = rows.map((t) => ({ id: t.id, box: [t.cx * scale - 4, t.cy * scale - 20, t.cx * scale + 4, t.cy * scale + 20], text: 'x' }));
  const together = anchorRows(allRows, staves);
  const offsets = {};
  for (const c of cases) if (c.anchored) offsets[c.t.measure - c.global] = (offsets[c.t.measure - c.global] || 0) + 1;
  const offset = Number(Object.entries(offsets).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0);
  const page = { n: rows.length, anchored: 0, lineOk: 0, measureOk: 0, noteOk: 0, noteWithinOne: 0, measureOffset: offset };
  for (const c of cases) {
    if (!c.anchored) continue;
    page.anchored++;
    // The confirmed physical row order is per page; compare rank within each staff's rows to rank within the page's rows only
    // when the page has one lyric block per system (the common Lieder layout).
    if (together.get(c.t.id).printedLine === c.t.line) page.lineOk++;
    if (c.t.measure === c.global + offset) {
      page.measureOk++;
      if (c.ordinal === c.t.ordinal) page.noteOk++;
      if (c.ordinal !== null && Math.abs(c.ordinal - c.t.ordinal) <= 1) page.noteWithinOne++;
    }
  }
  out.pages[score] = page;
  for (const k of Object.keys(out.total)) out.total[k] += page[k];
}
console.log(JSON.stringify(out, null, 1));
