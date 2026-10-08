// Anchoring accuracy THROUGH real OCR rows: each owner-confirmed syllable is looked up in the
// scanner's own OCR rows (by page position and text); its proportional-split anchor is compared
// with the confirmation. usage: node evaluate_ocr_row_anchors.cjs <truth.json> <dir> <sizes.json>
const fs = require('fs');
const path = require('path');
const truth = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const dir = process.argv[3];
const sizes = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const fold = (t) => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}']/gu, '');
const total = { n: 0, located: 0, textMatched: 0, lineOk: 0, measureOk: 0, noteOk: 0, noteWithinOne: 0 };
const pages = {};
for (const score of [...new Set(truth.map((t) => t.score))]) {
  const inv = JSON.parse(fs.readFileSync(path.join(dir, `inv-anch-${score}.json`), 'utf8'));
  const review = JSON.parse(fs.readFileSync(path.join(dir, `review-${score}.json`), 'utf8'));
  const scale = review.raster.w / sizes[score][0];
  const staves = review.staves;
  const before = (staff) =>
    staves.filter((s) => s.partIndex === staff.partIndex && s.systemIndex < staff.systemIndex)
      .reduce((n, s) => n + s.tokens.filter((t) => String(t[0]).startsWith('barline')).length, 0);
  const rows = truth.filter((t) => t.score === score);
  const found = [];
  for (const t of rows) {
    const x = t.cx * scale, y = t.cy * scale;
    const row = inv.ocrRows.find((r) => r.anchor && x >= r.box[0] - 6 && x <= r.box[2] + 6 && y >= r.box[1] - 10 && y <= r.box[3] + 10);
    const rec = { t, located: !!row };
    if (row) {
      const cand = row.anchor.syllables.filter((s) => fold(s.text) && fold(s.text) === fold(t.text));
      if (cand.length) {
        const s = cand.reduce((a, b) => (Math.abs(a.x - x) <= Math.abs(b.x - x) ? a : b));
        const staff = staves.find((st) => st.index === row.anchor.staffIndex);
        Object.assign(rec, { textMatched: true, line: row.anchor.printedLine, global: before(staff) + s.measureInStaff, ordinal: s.noteOrdinalInMeasure });
      }
    }
    found.push(rec);
  }
  const offsets = {};
  for (const r of found) if (r.textMatched) offsets[r.t.measure - r.global] = (offsets[r.t.measure - r.global] || 0) + 1;
  const offset = Number(Object.entries(offsets).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0);
  const page = { n: rows.length, located: 0, textMatched: 0, lineOk: 0, measureOk: 0, noteOk: 0, noteWithinOne: 0, measureOffset: offset };
  for (const r of found) {
    if (r.located) page.located++;
    if (!r.textMatched) continue;
    page.textMatched++;
    if (r.line === r.t.line) page.lineOk++;
    if (r.t.measure === r.global + offset) {
      page.measureOk++;
      if (r.ordinal === r.t.ordinal) page.noteOk++;
      if (r.ordinal !== null && Math.abs(r.ordinal - r.t.ordinal) <= 1) page.noteWithinOne++;
    }
  }
  pages[score] = page;
  for (const k of Object.keys(total)) total[k] += page[k];
}
console.log(JSON.stringify({ pages, total }, null, 1));
