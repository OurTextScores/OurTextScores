#!/usr/bin/env node
/**
 * p0-render.mjs — Stage 2: Render PDMX MXL files to per-page PNGs + SVGs.
 *
 * Reads p0-manifest.jsonl (from stage 0) and renders each MXL with MuseScore,
 * producing output-01.png … output-N.png and output-01.svg … output-N.svg per score.
 * Writes p0-render-manifest.jsonl alongside the PNGs.
 *
 * Can also render a directory of MXL/MSCZ files directly (--mxl-dir) for use
 * with the ripped dataset or other sources without a stage-0 manifest.
 *
 * Usage:
 *   # Primary mode: read PDMX.csv directly (applies same filters as p0_pipeline.py)
 *   node scripts/p0-render.mjs \
 *     --csv     /mnt/bakery/jhlusko/pdmx_dataset/PDMX.csv \
 *     --mxl-root /mnt/bakery/jhlusko/pdmx_dataset \
 *     --output  ./data/p0 \
 *     --workers 8 \
 *     [--dpi 150] [--limit 100] [--resume] [--dry-run]
 *
 *   # Ingest-manifest mode: {scoreId, mxlPath, split, ...} JSONL
 *   node scripts/p0-render.mjs \
 *     --manifest ./data/p0/p0-ingest-manifest.jsonl \
 *     --output  ./data/p0 \
 *     --workers 8
 *
 *   # Direct directory mode (ripped dataset, no manifest needed):
 *   node scripts/p0-render.mjs \
 *     --mxl-dir /mnt/bakery/jhlusko/ripped/scores/output/sample \
 *     --output  ./data/ripped-render \
 *     --workers 4
 *
 * Environment overrides:
 *   MUSIC_MUSESCORE_BIN          Force a specific binary
 *   MUSIC_MUSESCORE_BIN_CANDIDATES  Comma-separated candidates list
 *   MUSIC_MUSESCORE_TIMEOUT_MS   Per-score render timeout (default 120000)
 *   MUSIC_MUSESCORE_USE_XVFB     Force xvfb-run usage (default: auto-detect)
 */

import { createReadStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import process from 'node:process';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    csv: '',
    manifest: '',
    mxlRoot: '',
    mxlDir: '',
    output: './data/p0',
    workers: 4,
    dpi: 150,
    limit: 0,
    resume: false,
    dryRun: false,
    keepSvg: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--csv':           args.csv       = argv[++i]; break;
      case '--manifest':      args.manifest  = argv[++i]; break;
      case '--mxl-root':      args.mxlRoot   = argv[++i]; break;
      case '--mxl-dir':       args.mxlDir    = argv[++i]; break;
      case '--output':        args.output    = argv[++i]; break;
      case '--workers':       args.workers   = Number(argv[++i]); break;
      case '--dpi':           args.dpi       = Number(argv[++i]); break;
      case '--limit':         args.limit     = Number(argv[++i]); break;
      case '--resume':        args.resume    = true; break;
      case '--dry-run':       args.dryRun    = true; break;
      case '--keep-svg':      args.keepSvg   = true; break;
      case '--help': case '-h':
        printHelp(); process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
p0-render.mjs — Batch MuseScore renderer for P0 data pipeline

Input (one required):
  --csv      <path>      PDMX.csv — apply standard P0 quality filters (primary mode)
  --manifest <path>      JSONL with {scoreId, mxlPath, split, ...} rows
  --mxl-dir  <path>      Render all MXL/MSCZ files in a directory directly

Options:
  --mxl-root <path>      Prepend to relative mxlPath values from CSV/manifest
  --output   <path>      Output directory (default: ./data/p0)
  --workers  <n>         Parallel MuseScore workers (default: 4)
  --dpi      <n>         PNG render DPI (default: 150 → 1240×1754 A4)
  --limit    <n>         Max scores to render (0 = all)
  --resume               Skip scores where PNGs already exist
  --dry-run              List scores without rendering
  --keep-svg             Keep SVG files after rendering (default: transient)
  --help                 Show this help
`.trim());
}

// ---------------------------------------------------------------------------
// MuseScore binary detection
// ---------------------------------------------------------------------------
const MUSESCORE_CANDIDATES = [
  process.env.MUSIC_MUSESCORE_BIN,
  'musescore3', 'musescore', 'MuseScore3',
  'musescore4', 'mscore4portable', 'MuseScore4',
].filter(Boolean);

async function findMusescore() {
  const envCandidates = process.env.MUSIC_MUSESCORE_BIN_CANDIDATES;
  const candidates = envCandidates
    ? envCandidates.split(',').map(s => s.trim()).filter(Boolean)
    : MUSESCORE_CANDIDATES;

  for (const bin of candidates) {
    try {
      await fs.access(bin); // absolute path check
      return bin;
    } catch {}
    // PATH lookup via `which`
    const found = await new Promise(res => {
      const which = spawn('which', [bin], { stdio: 'pipe' });
      let out = '';
      which.stdout.on('data', d => { out += d; });
      which.on('close', code => res(code === 0 ? out.trim() : null));
    });
    if (found) return found;
  }
  return null;
}

async function findXvfbRun() {
  const envForce = process.env.MUSIC_MUSESCORE_USE_XVFB;
  if (envForce === '0' || envForce?.toLowerCase() === 'false') return null;

  return new Promise(res => {
    const which = spawn('which', ['xvfb-run'], { stdio: 'pipe' });
    let out = '';
    which.stdout.on('data', d => { out += d; });
    which.on('close', code => res(code === 0 ? out.trim() : null));
  });
}

// ---------------------------------------------------------------------------
// MuseScore render (single score, one format)
// ---------------------------------------------------------------------------
async function runMusescore({ bin, xvfb, argv, timeoutMs }) {
  const cmd = xvfb ? [xvfb, '-a', bin, ...argv] : [bin, ...argv];
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' },
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.stdout.on('data', () => {}); // drain

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: code, stderr, timedOut });
    });
  });
}

/**
 * Render one MXL/MSCZ file to all-page PNGs and SVGs.
 * Returns { pngPaths, svgPaths } — absolute paths to output files.
 */
async function renderScore({ bin, xvfb, mxlPath, outDir, dpi, timeoutMs }) {
  await fs.mkdir(outDir, { recursive: true });

  // Collect numbered output files matching a pattern
  async function collectOutputFiles(ext) {
    const files = await fs.readdir(outDir);
    const pattern = new RegExp(`^output[-.]?\\d*\\.${ext}$`, 'i');
    const numbered = files
      .filter(f => pattern.test(f))
      .sort((a, b) => {
        const na = parseInt(a.replace(/\D/g, '') || '0', 10);
        const nb = parseInt(b.replace(/\D/g, '') || '0', 10);
        return na - nb;
      });
    // Single-page fallback: output.ext with no number
    if (numbered.length === 0) {
      try {
        await fs.access(join(outDir, `output.${ext}`));
        return [`output.${ext}`];
      } catch {}
    }
    return numbered;
  }

  // PNG render
  const pngOut = join(outDir, 'output.png');
  const pngResult = await runMusescore({
    bin, xvfb, timeoutMs,
    argv: ['-platform', 'offscreen', '-r', String(dpi), '-o', pngOut, mxlPath],
  });
  const pngFiles = await collectOutputFiles('png');

  // SVG render
  const svgOut = join(outDir, 'output.svg');
  const svgResult = await runMusescore({
    bin, xvfb, timeoutMs,
    argv: ['-platform', 'offscreen', '-o', svgOut, mxlPath],
  });
  const svgFiles = await collectOutputFiles('svg');

  return {
    pngPaths: pngFiles.map(f => join(outDir, f)),
    svgPaths: svgFiles.map(f => join(outDir, f)),
    pngExitCode: pngResult.exitCode,
    svgExitCode: svgResult.exitCode,
    pngTimedOut: pngResult.timedOut,
  };
}

// ---------------------------------------------------------------------------
// Save rendered pages to permanent output directory
// ---------------------------------------------------------------------------
async function savePages({ scoreId, split, pngPaths, svgPaths, renderDir, keepSvg }) {
  const splitDir = join(renderDir, split);
  await fs.mkdir(splitDir, { recursive: true });

  const savedPngs = [];
  const savedSvgs = [];

  for (let i = 0; i < pngPaths.length; i++) {
    const pageNum = String(i + 1).padStart(2, '0');
    const dest = join(splitDir, `${scoreId}-p${pageNum}.png`);
    await fs.copyFile(pngPaths[i], dest);
    savedPngs.push(dest);
  }

  for (let i = 0; i < svgPaths.length; i++) {
    const pageNum = String(i + 1).padStart(2, '0');
    if (keepSvg) {
      const dest = join(splitDir, `${scoreId}-p${pageNum}.svg`);
      await fs.copyFile(svgPaths[i], dest);
      savedSvgs.push(dest);
    } else {
      // Keep SVG in temp dir — caller manages cleanup
      savedSvgs.push(svgPaths[i]);
    }
  }

  return { savedPngs, savedSvgs };
}

// ---------------------------------------------------------------------------
// Semaphore for worker concurrency
// ---------------------------------------------------------------------------
class Semaphore {
  constructor(max) {
    this._max = max;
    this._count = 0;
    this._queue = [];
  }
  acquire() {
    if (this._count < this._max) {
      this._count++;
      return Promise.resolve();
    }
    return new Promise(res => this._queue.push(res));
  }
  release() {
    this._count--;
    if (this._queue.length > 0) {
      this._count++;
      this._queue.shift()();
    }
  }
}

// ---------------------------------------------------------------------------
// Input sources
// ---------------------------------------------------------------------------

/** Deterministic train/val/test split by scoreId hash (matches p0_pipeline.py). */
function splitForId(scoreId) {
  let h = 0;
  for (let i = 0; i < scoreId.length; i++) h = (Math.imul(31, h) + scoreId.charCodeAt(i)) >>> 0;
  const pct = h % 100;
  if (pct < 1) return 'test';
  if (pct < 3) return 'val';
  return 'train';
}

/** Primary mode: stream PDMX.csv and apply P0 quality filters. */
async function* readPdmxCsv(csvPath, mxlRoot) {
  const rl = createInterface({ input: createReadStream(csvPath, 'utf8'), crlfDelay: Infinity });
  let headers = null;
  let emitted = 0;
  let skipped = { license: 0, not_deduplicated: 0, track_count: 0, bar_count: 0, mxl_missing: 0 };

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!headers) {
      headers = line.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      continue;
    }
    // Simple CSV parse (fields may be quoted)
    const values = parseCsvLine(line);
    if (values.length !== headers.length) continue;
    const row = Object.fromEntries(headers.map((h, i) => [h, values[i]]));

    if (row['subset:no_license_conflict']?.toLowerCase() !== 'true') { skipped.license++; continue; }
    if (row['subset:deduplicated']?.toLowerCase() !== 'true') { skipped.not_deduplicated++; continue; }

    const nTracks = parseInt(row['n_tracks'] || '0', 10);
    const bars = parseFloat(row['song_length.bars'] || '0');
    if (!(nTracks >= 1 && nTracks <= 4)) { skipped.track_count++; continue; }
    if (!(bars >= 4 && bars <= 600)) { skipped.bar_count++; continue; }

    const mxlRel = (row['mxl'] || '').replace(/^\.\//, '');
    if (!mxlRel) continue;
    const mxlPath = mxlRoot ? join(mxlRoot, mxlRel) : mxlRel;

    // Existence check (sampled: check 1 in 10 to avoid 65k stat() calls over SMB)
    if (emitted % 10 === 0) {
      try { await fs.access(mxlPath); } catch { skipped.mxl_missing++; continue; }
    }

    const metaPath = row['metadata'] || '';
    const scoreId = metaPath ? basename(metaPath, '.json') : basename(mxlRel, extname(mxlRel));

    emitted++;
    yield {
      scoreId,
      mxlPath,
      split: splitForId(scoreId),
      composer: row['composer_name'] || '',
      title: row['song_name'] || row['title'] || '',
      nTracks,
      bars: Math.floor(bars),
    };
  }
  log(`CSV filter done — emitted ${emitted}, skipped ${JSON.stringify(skipped)}`);
}

/** Parses one CSV line respecting double-quoted fields. */
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/** Manifest mode: JSONL rows with {scoreId, mxlPath, split, ...}. */
async function* readManifest(manifestPath, mxlRoot) {
  const rl = createInterface({ input: createReadStream(manifestPath, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row.mxlPath) continue; // skip summary-only rows (p0-manifest.jsonl has no mxlPath)
    const mxlPath = mxlRoot ? join(mxlRoot, row.mxlPath) : row.mxlPath;
    yield {
      scoreId: row.scoreId,
      mxlPath,
      split: row.split || splitForId(row.scoreId),
      composer: row.composer || '',
      title: row.title || '',
    };
  }
}

/** Direct-directory mode: render every MXL/MSCZ in a folder (ripped dataset etc). */
async function* readMxlDir(mxlDir) {
  const files = await fs.readdir(mxlDir);
  for (const f of files.sort()) {
    const ext = extname(f).toLowerCase();
    if (!['.mxl', '.musicxml', '.xml', '.mscz', '.mscx'].includes(ext)) continue;
    const scoreId = basename(f, ext);
    yield {
      scoreId,
      mxlPath: join(mxlDir, f),
      split: 'train',
      composer: '',
      title: '',
    };
  }
}

// ---------------------------------------------------------------------------
// Already-rendered check
// ---------------------------------------------------------------------------
async function isAlreadyRendered(scoreId, split, renderDir) {
  const splitDir = join(renderDir, split);
  try {
    const files = await fs.readdir(splitDir);
    return files.some(f => f.startsWith(`${scoreId}-p`) && f.endsWith('.png'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.csv && !args.manifest && !args.mxlDir) {
    console.error('Error: one of --csv, --manifest, or --mxl-dir is required');
    process.exit(1);
  }

  const outputDir   = resolve(args.output);
  const renderDir   = join(outputDir, 'render');
  const manifestOut = join(outputDir, 'p0-render-manifest.jsonl');
  const errorsOut   = join(outputDir, 'p0-render-errors.jsonl');
  const doneFile    = join(outputDir, 'p0-render-done.txt');

  await fs.mkdir(renderDir, { recursive: true });

  // Load already-done IDs for resume
  const doneIds = new Set();
  if (args.resume) {
    try {
      const txt = await fs.readFile(doneFile, 'utf8');
      txt.split('\n').filter(Boolean).forEach(id => doneIds.add(id));
      log(`Resuming — ${doneIds.size} scores already rendered`);
    } catch {}
  }

  if (args.dryRun) {
    log('Dry-run mode — listing scores only');
  }

  // Find MuseScore
  const bin = await findMusescore();
  if (!bin && !args.dryRun) {
    console.error('Error: MuseScore not found on PATH. Install musescore3 or musescore4.');
    process.exit(1);
  }
  const xvfb = bin ? await findXvfbRun() : null;
  const timeoutMs = Number(process.env.MUSIC_MUSESCORE_TIMEOUT_MS || 120_000);

  if (bin) log(`MuseScore: ${bin}${xvfb ? ' (xvfb-run)' : ''} | DPI: ${args.dpi} | workers: ${args.workers}`);

  const sem = new Semaphore(args.workers);

  let okCount = 0;
  let errCount = 0;
  let skipCount = 0;
  let dispatched = 0;
  const startTime = Date.now();

  const manifestFh  = await fs.open(manifestOut, 'a');
  const errorsFh    = await fs.open(errorsOut,   'a');
  const doneFh      = await fs.open(doneFile,    'a');

  const mxlRoot = args.mxlRoot ? resolve(args.mxlRoot) : '';
  const source = args.mxlDir
    ? readMxlDir(resolve(args.mxlDir))
    : args.csv
      ? readPdmxCsv(resolve(args.csv), mxlRoot)
      : readManifest(resolve(args.manifest), mxlRoot);

  const pending = [];

  for await (const row of source) {
    if (args.limit && dispatched >= args.limit) break;

    if (doneIds.has(row.scoreId)) {
      skipCount++;
      continue;
    }

    // Check if already rendered (resume without done-file)
    if (args.resume && await isAlreadyRendered(row.scoreId, row.split, renderDir)) {
      skipCount++;
      doneIds.add(row.scoreId);
      continue;
    }

    dispatched++;

    if (args.dryRun) {
      console.log(`[dry-run] ${row.scoreId}  ${row.mxlPath}`);
      okCount++;
      continue;
    }

    // Launch render as concurrent task
    const task = (async () => {
      await sem.acquire();
      const tmpDir = join(tmpdir(), `p0-render-${row.scoreId}-${randomUUID().slice(0, 8)}`);
      try {
        await fs.mkdir(tmpDir, { recursive: true });

        const { pngPaths, svgPaths, pngExitCode, pngTimedOut } =
          await renderScore({ bin, xvfb, mxlPath: row.mxlPath, outDir: tmpDir, dpi: args.dpi, timeoutMs });

        if (pngPaths.length === 0) {
          throw new Error(pngTimedOut ? 'MuseScore timed out' : `MuseScore exited ${pngExitCode} with no PNG output`);
        }

        const { savedPngs, savedSvgs } = await savePages({
          scoreId: row.scoreId,
          split: row.split,
          pngPaths,
          svgPaths,
          renderDir,
          keepSvg: args.keepSvg,
        });

        const entry = {
          scoreId:   row.scoreId,
          split:     row.split,
          mxlPath:   row.mxlPath,
          composer:  row.composer,
          title:     row.title,
          pageCount: savedPngs.length,
          pngPaths:  savedPngs,
          svgPaths:  args.keepSvg ? savedSvgs : svgPaths, // transient paths if not kept
          dpi:       args.dpi,
        };
        await manifestFh.appendFile(JSON.stringify(entry) + '\n', 'utf8');
        await doneFh.appendFile(row.scoreId + '\n', 'utf8');
        okCount++;

        if (okCount % 50 === 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          log(`Progress: ${okCount} ok / ${errCount} err / ${skipCount} skip | ${(okCount / elapsed).toFixed(1)} scores/s`);
        }

        return entry;
      } catch (err) {
        errCount++;
        const errEntry = { scoreId: row.scoreId, mxlPath: row.mxlPath, error: err.message };
        await errorsFh.appendFile(JSON.stringify(errEntry) + '\n', 'utf8');
        return null;
      } finally {
        sem.release();
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    })();

    pending.push(task);
  }

  await Promise.all(pending);

  await manifestFh.close();
  await errorsFh.close();
  await doneFh.close();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const total = okCount + errCount + skipCount;
  log(`Done in ${elapsed}s — ${okCount} rendered, ${errCount} errors, ${skipCount} skipped | ${total} total`);

  // Write summary
  const summary = { ok: okCount, errors: errCount, skipped: skipCount, elapsed_s: Number(elapsed), dpi: args.dpi };
  await fs.writeFile(join(outputDir, 'p0-render-summary.json'), JSON.stringify(summary, null, 2));
}

function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`${ts} INFO ${msg}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
