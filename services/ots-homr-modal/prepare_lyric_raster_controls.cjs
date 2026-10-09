/** Produce actual scanner-style PNGs for bounded diagnostic controls, without invoking a provider. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('../../backend/node_modules/sharp');
const [base, out, mode] = process.argv.slice(2);
if (mode && mode !== "--all-frozen-pages") throw new Error("Unknown selection mode");
if (!out) throw new Error('Usage: node prepare_lyric_raster_controls.cjs BASE OUT');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonl = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
async function main() {
  if (fs.existsSync(out)) throw new Error('Preserve existing prepared controls; choose a new output');
  const pool = new Map(jsonl(path.join(base, 'fusion-lyrics-test-20261008/pages.jsonl')).map(p => [p.id, p]));
  const frozen = jsonl(path.join(base, 'frozen-fusion-cpu-20261008/pages.jsonl'));
  const selected = mode === '--all-frozen-pages' ? frozen : frozen.filter(p =>
    ['IMSLP621593', 'IMSLP154241', 'IMSLP508574'].includes(p.score) ||
    ['sq7224846:3cd870d81dd505003dffd415', 'sq7224846:41a5ab2b2f0618f376fe1b99'].includes(p.id));
  if (selected.length !== (mode ? 25 : 5) || new Set(selected.map(p => p.id)).size !== selected.length) throw new Error('Unexpected frozen page selection');
  fs.mkdirSync(path.join(out, 'images'), { recursive: true });
  const pages = [], transforms = [];
  for (const page of selected) {
    const input = fs.readFileSync(pool.get(page.id).image);
    if (sha(input) !== page.image_sha256) throw new Error('Original source changed');
    const { data, info } = await sharp(input).rotate().resize({ width: 1920, withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    const hash = sha(data);
    const image = path.resolve(out, 'images', `${page.score}_${hash.slice(0, 12)}.png`);
    fs.writeFileSync(image, data);
    const prepared = { id: `${page.id}-prepared-${hash.slice(0, 12)}`, score: page.score, corpus: page.corpus, image, image_sha256: hash };
    pages.push(prepared);
    transforms.push({ originalId: page.id, preparedId: prepared.id, originalSha256: page.image_sha256, preparedSha256: hash, originalSize: [page.raster.width, page.raster.height], preparedSize: [info.width, info.height] });
  }
  const write = (relative, value) => {
    const file = path.join(out, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  };
  write('pages.json', pages);
  write('lyric-native-reference-readiness-20261008-v3/candidate-pages.json', pages.filter(p => p.corpus === 'lieder'));
  fs.mkdirSync(path.join(out, 'fusion-lyrics-test-20261008'), { recursive: true });
  fs.writeFileSync(path.join(out, 'fusion-lyrics-test-20261008/pages.jsonl'), pages.map(p => JSON.stringify(p)).join('\n') + '\n');
  fs.symlinkSync(path.resolve(base, 'c2-latency-20260925'), path.join(out, 'c2-latency-20260925'));
  write('preparation.json', { scope: 'Actual rotate/resize/png scanner preparation. Fresh recognition/detection is required; original geometry is not reused.', preparation: { width: 1920, withoutEnlargement: true, rotate: true }, selection: mode ? 'all-frozen-25' : 'five-diagnostic-controls', sharpVersion: sharp.versions.sharp, runnerSha256: sha(fs.readFileSync(__filename)), workerSourceSha256: sha(fs.readFileSync(path.resolve(__dirname, '../../backend/src/scanner/scanner-worker.service.ts'))), transforms });
  console.log(JSON.stringify({ pages: pages.length, out }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
