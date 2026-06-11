#!/usr/bin/env node
/**
 * p0-shard.mjs — Stage 6: Package crops into WebDataset tar shards + generic-export JSONL.
 *
 * Scans crops/<split>/ for complete (png + kern) pairs, skipping scores already
 * handled by p0_pipeline.py (listed in p0-done.txt) to avoid double-sharding.
 * Render and crop files are kept after sharding (we are not space-constrained).
 *
 * Outputs:
 *   shards/<split>/train-000000.tar  …   WebDataset triples (key.png, key.kern, key.json)
 *   generic-export/<split>.jsonl         Training JSONL for existing training scripts
 *   manifest.json                        Dataset statistics
 *
 * Usage:
 *   node scripts/p0-shard.mjs \
 *     --crops-dir  ./data/p0/crops \
 *     --output     ./data/p0 \
 *     --shard-size 1000 \
 *     [--splits train,val,test] [--resume] [--dry-run] [--limit 1000]
 */

import { promises as fs, createWriteStream } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createGzip } from 'node:zlib';
import process from 'node:process';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    cropsDir: '',
    output: './data/p0',
    shardSize: 1000,
    splits: ['train', 'val', 'test'],
    resume: false,
    dryRun: false,
    limit: 0,
    all: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--crops-dir':  args.cropsDir  = argv[++i]; break;
      case '--output':     args.output    = argv[++i]; break;
      case '--shard-size': args.shardSize = Number(argv[++i]); break;
      case '--splits':     args.splits    = argv[++i].split(',').map(s => s.trim()); break;
      case '--resume':     args.resume    = true; break;
      case '--dry-run':    args.dryRun    = true; break;
      case '--limit':      args.limit     = Number(argv[++i]); break;
      case '--all':        args.all       = true; break;
      case '--help': case '-h': printHelp(); process.exit(0);
    }
  }
  if (!args.cropsDir) args.cropsDir = join(args.output, 'crops');
  return args;
}

function printHelp() {
  console.log(`
p0-shard.mjs — Stage 6: crops → WebDataset shards + generic-export JSONL

  --crops-dir  <path>   crops/ directory (default: <output>/crops)
  --output     <path>   root output dir (default: ./data/p0)
  --shard-size <n>      examples per shard tar (default: 1000)
  --splits     <list>   comma-separated splits (default: train,val,test)
  --resume              skip shard files that already exist
  --dry-run             count examples without writing
  --limit      <n>      stop after N examples (0 = all)
  --help                this message
`.trim());
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(msg) { console.log(`${new Date().toTimeString().slice(0, 8)} INFO ${msg}`); }

// ---------------------------------------------------------------------------
// Minimal tar writer (ustar format, no external deps)
// ---------------------------------------------------------------------------
function ustarHeader(name, size) {
  const buf = Buffer.alloc(512, 0);
  const enc = (str, off, len) => buf.write(str.slice(0, len), off, 'utf8');
  const oct = (n, off, len) => buf.write(n.toString(8).padStart(len - 1, '0') + '\0', off, 'ascii');

  enc(name.slice(0, 100), 0, 100);
  oct(0o644, 100, 8);    // mode
  oct(0,     108, 8);    // uid
  oct(0,     116, 8);    // gid
  oct(size,  124, 12);   // size
  oct(Math.floor(Date.now() / 1000), 136, 12); // mtime
  buf[156] = 0x30;       // typeflag '0' = regular file (not space)
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');

  // Checksum: POSIX format is exactly 6 octal digits + null + space = "dddddd\0 "
  // During calculation, treat checksum field (148-155) as spaces per POSIX spec
  buf.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.fill(0, 148, 156);
  buf.write(sum.toString(8).padStart(6, '0'), 148, 'ascii'); // 6 digits at 148-153
  buf[154] = 0x00;  // null at 154
  buf[155] = 0x20;  // space at 155

  return buf;
}

function tarPad(size) {
  const rem = size % 512;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - rem, 0);
}

class TarWriter {
  constructor(path) {
    this._path = path;
    this._stream = createWriteStream(path);
    this._done = false;
  }

  async addBuffer(name, data) {
    const header = ustarHeader(name, data.length);
    await this._write(header);
    await this._write(data);
    await this._write(tarPad(data.length));
  }

  async addFile(name, filePath) {
    const data = await fs.readFile(filePath);
    await this.addBuffer(name, data);
  }

  _write(buf) {
    return new Promise((res, rej) => {
      if (buf.length === 0) return res();
      this._stream.write(buf, err => err ? rej(err) : res());
    });
  }

  async close() {
    // End-of-archive: two 512-byte zero blocks
    await this._write(Buffer.alloc(1024, 0));
    return new Promise((res, rej) => this._stream.end(err => err ? rej(err) : res()));
  }
}

// ---------------------------------------------------------------------------
// Generic-export JSONL writer
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT =
  'Transcribe the music notation in this image to canonical **kern. ' +
  'Output only the **kern text, nothing else.';

function makeGenericExportRow(exampleId, cropRelPath, kernText, measureStart, measureEnd) {
  return JSON.stringify({
    exampleId,
    taskType: 'transcribe_local_passage',
    system: SYSTEM_PROMPT,
    input: {
      region: { measureStart, measureEnd },
      imageRefs: { region: cropRelPath },
    },
    target: {
      candidate: { content: kernText },
      overall_confidence: 1.0,
      findings: [],
      evidence_spans: [{ measureStart, measureEnd }],
    },
  });
}

// ---------------------------------------------------------------------------
// Parse measureRange from layout JSON (may be null for non-aligned crops)
// ---------------------------------------------------------------------------
async function loadLayoutMap(cropsDir, split) {
  // Returns Map<scoreId, layoutJson>
  const dir = join(cropsDir, split);
  const map = new Map();
  let files;
  try { files = await fs.readdir(dir); } catch { return map; }
  for (const f of files) {
    if (!f.endsWith('-layout.json')) continue;
    const scoreId = f.replace('-layout.json', '');
    try {
      const layout = JSON.parse(await fs.readFile(join(dir, f), 'utf8'));
      map.set(scoreId, layout);
    } catch {}
  }
  return map;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const outputDir   = resolve(args.output);
const cropsDir    = resolve(args.cropsDir);
const shardsDir   = join(outputDir, 'shards');
const geDir       = join(outputDir, 'generic-export');

// Load pipeline-done set to avoid double-sharding
const donePath = join(outputDir, 'p0-done.txt');
let pipelineDone = new Set();
try {
  const text = await fs.readFile(donePath, 'utf8');
  pipelineDone = new Set(text.split('\n').map(l => l.trim()).filter(Boolean));
  log(`Pipeline-done: ${pipelineDone.size} scores (will skip)`);
} catch {}

// Load quality filter: scores with all-rest last measure
const filterPath = join(outputDir, 'filter-last-measure-rest.txt');
let filteredOut = new Set();
try {
  const text = await fs.readFile(filterPath, 'utf8');
  filteredOut = new Set(text.split('\n').map(l => l.trim()).filter(Boolean));
  log(`Quality filter: ${filteredOut.size} scores excluded (all-rest last measure)`);
} catch {}

// Load shard-done set for resume
const shardDonePath = join(outputDir, 'p0-shard-done.txt');
let shardDone = new Set();
if (args.resume) {
  try {
    const text = await fs.readFile(shardDonePath, 'utf8');
    shardDone = new Set(text.split('\n').map(l => l.trim()).filter(Boolean));
    log(`Resuming — ${shardDone.size} scores already sharded`);
  } catch {}
}

await fs.mkdir(shardsDir, { recursive: true });
await fs.mkdir(geDir,     { recursive: true });

const stats = {}; // split → { examples, shards, measureCounts, staffCounts, kernLens }

let totalExamples = 0;

for (const split of args.splits) {
  const splitCropsDir = join(cropsDir, split);
  let files;
  try { files = await fs.readdir(splitCropsDir); } catch { continue; }

  // Load layout map for this split (measureRange per system)
  const layoutMap = await loadLayoutMap(cropsDir, split);

  // Collect complete pairs: <key>.png + <key>.kern (no aug, no page-grain)
  const keys = [];
  const pngSet  = new Set(files.filter(f => f.endsWith('.png') && !f.includes('aug')).map(f => f.slice(0, -4)));
  const kernSet = new Set(files.filter(f => f.endsWith('.kern') && f.match(/-p\d+-s\d+\.kern$/)).map(f => f.slice(0, -5)));
  for (const k of pngSet) {
    if (kernSet.has(k)) keys.push(k);
  }
  keys.sort(); // deterministic order

  // Filter out pipeline-done and already-sharded scores
  const toShard = keys.filter(k => {
    const scoreId = k.split('-p')[0];
    return (args.all || !pipelineDone.has(scoreId))
      && !shardDone.has(scoreId)
      && !filteredOut.has(scoreId);
  });

  log(`${split}: ${keys.length} complete pairs, ${pipelineDone.size > 0 ? keys.length - toShard.length + ' already sharded by pipeline, ' : ''}${toShard.length} to shard`);
  if (toShard.length === 0) continue;

  // Setup shard + ge writers
  const splitShardsDir = join(shardsDir, split);
  await fs.mkdir(splitShardsDir, { recursive: true });

  // Find next shard index (resume-safe)
  let shardIdx = 0;
  if (args.resume) {
    const existing = (await fs.readdir(splitShardsDir)).filter(f => f.endsWith('.tar'));
    if (existing.length > 0) {
      const maxIdx = Math.max(...existing.map(f => parseInt(f.replace(/\D/g, ''), 10) || 0));
      shardIdx = maxIdx + 1;
    }
  }

  const gePath = join(geDir, `${split}.jsonl`);
  const geFh   = await fs.open(gePath, 'a');
  const doneFh = await fs.open(shardDonePath, 'a');

  let tar = null;
  let countInShard = 0;
  let splitExamples = 0;
  const measureCounts = [];
  const staffCounts   = [];
  const kernLens      = [];
  const seenScores    = new Set();

  for (const key of toShard) {
    if (args.limit > 0 && totalExamples >= args.limit) break;

    const scoreId = key.split('-p')[0];
    const pngPath  = join(splitCropsDir, `${key}.png`);
    const kernPath = join(splitCropsDir, `${key}.kern`);

    if (args.dryRun) { totalExamples++; splitExamples++; continue; }

    // Open new shard if needed
    if (!tar || countInShard >= args.shardSize) {
      if (tar) await tar.close();
      const shardName = `${split}-${String(shardIdx).padStart(6, '0')}.tar`;
      tar = new TarWriter(join(splitShardsDir, shardName));
      shardIdx++;
      countInShard = 0;
    }

    // Read files
    let kernText;
    try { kernText = await fs.readFile(kernPath, 'utf8'); }
    catch { continue; }

    // Look up measureRange from layout JSON
    let measureStart = 1, measureEnd = 1;
    const pageMatch = key.match(/-p(\d+)-s(\d+)$/);
    if (pageMatch) {
      const pageIdx = parseInt(pageMatch[1], 10);
      const sysIdx  = parseInt(pageMatch[2], 10);
      const layout  = layoutMap.get(scoreId);
      if (layout) {
        const page = layout.pages?.find(p => p.pageIndex === pageIdx);
        const sys  = page?.systems?.find(s => s.systemIndex === sysIdx);
        const mr   = sys?.measureRange;
        if (mr) { measureStart = mr[0]; measureEnd = mr[1]; }
      }
    }

    const metaObj = {
      scoreId,
      split,
      grain: 'system',
      pageIndex: pageMatch ? parseInt(pageMatch[1], 10) : null,
      systemIndex: pageMatch ? parseInt(pageMatch[2], 10) : null,
      measureRange: [measureStart, measureEnd],
      measureCount: measureEnd - measureStart + 1,
      augmented: false,
      dpi: 150,
      kernTokenCount: kernText.split(/\s+/).length,
    };

    // Write to tar
    try {
      await tar.addFile(`${key}.png`, pngPath);
      await tar.addBuffer(`${key}.kern`, Buffer.from(kernText, 'utf8'));
      await tar.addBuffer(`${key}.json`, Buffer.from(JSON.stringify(metaObj), 'utf8'));
    } catch { continue; }

    // Write generic-export row
    const cropRelPath = `crops/${split}/${key}.png`;
    await geFh.appendFile(makeGenericExportRow(key, cropRelPath, kernText, measureStart, measureEnd) + '\n');

    countInShard++;
    totalExamples++;
    splitExamples++;
    measureCounts.push(metaObj.measureCount);
    staffCounts.push(metaObj.systemIndex ?? 0);
    kernLens.push(metaObj.kernTokenCount);

    if (!seenScores.has(scoreId)) {
      seenScores.add(scoreId);
      await doneFh.appendFile(scoreId + '\n');
    }

    if (totalExamples % 5000 === 0) {
      log(`Progress: ${totalExamples} examples sharded`);
    }
  }

  if (tar) await tar.close();
  await geFh.close();
  await doneFh.close();

  const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 0;
  stats[split] = {
    examples: splitExamples,
    shards: shardIdx,
    avgMeasureCount: avg(measureCounts),
    avgKernTokens: avg(kernLens),
  };
  log(`${split}: wrote ${splitExamples} examples into ${shardIdx} shards`);
}

// Write / update manifest.json
const manifestPath = join(outputDir, 'manifest.json');
let manifest = {};
try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch {}
for (const [split, s] of Object.entries(stats)) {
  manifest[split] = { ...(manifest[split] || {}), ...s, updatedAt: new Date().toISOString() };
}
manifest.totalExamples = Object.values(manifest).reduce((n, v) => n + (v.examples || 0), 0);
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

log(`Done: ${totalExamples} examples total. Manifest updated at ${manifestPath}`);
