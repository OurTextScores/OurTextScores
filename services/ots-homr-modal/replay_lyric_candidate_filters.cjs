/** Replay the actual compiled backend filters; labels never enter this stage. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [backend, fusionPath, ocrPath, contexts, out] = process.argv.slice(2);
if (!out) throw new Error('Usage: node replay_lyric_candidate_filters.cjs BACKEND FUSION_JSONL OCR_JSONL CONTEXTS OUT');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const jsonl = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const unique = rows => { const result = new Map(); for (const row of rows) { if (result.has(row.id)) throw new Error(`Duplicate page ${row.id}`); result.set(row.id, row); } return result; };
const fusion = unique(jsonl(fusionPath));
const ocr = unique(jsonl(ocrPath));
const helper = path.join(path.resolve(backend), 'dist/scanner/scanner-lyric-candidates.js');
const { buildLyricCandidateInventory } = require(helper);
fs.mkdirSync(out, { recursive: true });
const records = [];
for (const [id, fused] of fusion) {
  const text = ocr.get(id);
  const roots = contexts.split(',');
  const dir = roots.flatMap(root => [path.join(root, fused.score), path.join(root, fused.score + '_' + id.split(':').pop())]).find(folder => fs.existsSync(path.join(folder, 'result.json')));
  if (!dir) { records.push({ id, status: 'missing-recognition-context' }); continue; }
  const resultPath = path.join(dir, 'result.json');
  if (!text || !fs.existsSync(resultPath)) { records.push({ id, status: 'missing-context-or-ocr' }); continue; }
  const result = JSON.parse(fs.readFileSync(resultPath));
  if (result.status !== 'success') { records.push({ id, status: 'recognition-failed', error: result.error }); continue; }
  if (result.id !== id || result.imageSha256 !== fused.image_sha256 || text.image_sha256 !== fused.image_sha256) throw new Error(`Page binding mismatch ${id}`);
  const reviewPath = path.join(dir, 'review.json');
  if (sha(reviewPath) !== result.outputSha256['review.json']) throw new Error(`Review hash mismatch ${id}`);
  const review = JSON.parse(fs.readFileSync(reviewPath));
  const artifact = { fusedRegions: fused.fusion.regions, lyricText: { status: text.status, rows: text.rows } };
  const inventory = buildLyricCandidateInventory(artifact, 1, { checksumSha256: fused.image_sha256, ...fused.raster }, review.staves);
  const output = path.join(out, `${fused.score}_${id.split(':').pop()}.json`);
  fs.writeFileSync(output, JSON.stringify(inventory, null, 2) + '\n');
  const withheld = {};
  for (const row of inventory.ocrRows) if (row.withheldReason) withheld[row.withheldReason] = (withheld[row.withheldReason] || 0) + 1;
  records.push({ id, score: fused.score, status: 'replayed', inputProposals: text.rows.filter(row => row.proposedLyric).length, retainedProposals: inventory.ocrRows.filter(row => row.proposedLyric).length, withheld, inventorySha256: sha(output), reviewSha256: sha(reviewPath) });
}
const compiledFiles = ['scanner-lyric-candidates.js', 'scanner-lyric-anchors.js', 'scanner-locate.js', 'scanner-crop.js'];
if (fs.existsSync(path.join(path.resolve(backend), 'dist/scanner/scanner-barline.js'))) compiledFiles.push('scanner-barline.js');
const freshSelection = [...ocr.values()].every(row => row.ocrSelection === 'fresh-pinned-e2-lyrics-at-0.5');
const report = { ocrSelection: freshSelection ? 'fresh-pinned-e2-lyrics-at-0.5' : 'cached-e2-selection', schemaVersion: 'ots.lyric-backend-filter-replay.v1', runnerSha256: sha(__filename), backendCompiledSha256: Object.fromEntries(compiledFiles.map(name => [name, sha(path.join(path.resolve(backend), 'dist/scanner', name))])), fusionSha256: sha(fusionPath), ocrSha256: sha(ocrPath), scope: freshSelection ? 'Actual backend filtering replay with fresh pinned e2 raw selection >=0.5, matching production OCR stage independent of fused-region status. Not source-linked attachment accuracy.' : 'Exact backend filtering replay. OCR rows come from cached E2 selection; selection equivalence remains unqualified.', automaticAttachment: false, pages: records };
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ replayed: records.filter(row => row.status === 'replayed').length, pending: records.filter(row => row.status !== 'replayed').length }));
