#!/usr/bin/env node
/**
 * p0-segment.mjs — Stage 3: SVG StaffLines → system bounding boxes → PNG crops.
 *
 * Reads p0-render-manifest.jsonl (written by p0-render.mjs). For each rendered
 * score, re-renders SVG-only via MuseScore, parses StaffLines polylines to detect
 * system bounding boxes, crops the per-page PNGs with sharp, and writes:
 *
 *   crops/<split>/<scoreId>-p<N>-s<M>.png   — system-grain PNG crop
 *   crops/<split>/<scoreId>-layout.json      — page→system bbox manifest
 *                                              (measureRange: null; filled by p0-align.py)
 *
 * Usage:
 *   node scripts/p0-segment.mjs \
 *     --render-manifest ./data/p0/p0-render-manifest.jsonl \
 *     --mxl-root /mnt/bakery/jhlusko/pdmx_dataset \
 *     --output   ./data/p0 \
 *     --workers  4 \
 *     [--resume] [--limit 100] [--dry-run]
 */

import { promises as fs, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    renderManifest: '',
    mxlRoot: '',
    output: './data/p0',
    workers: 4,
    limit: 0,
    resume: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--render-manifest': args.renderManifest = argv[++i]; break;
      case '--mxl-root':        args.mxlRoot        = argv[++i]; break;
      case '--output':          args.output         = argv[++i]; break;
      case '--workers':         args.workers        = Number(argv[++i]); break;
      case '--limit':           args.limit          = Number(argv[++i]); break;
      case '--resume':          args.resume         = true; break;
      case '--dry-run':         args.dryRun         = true; break;
      case '--help': case '-h': printHelp(); process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
p0-segment.mjs — Stage 3: SVG StaffLines → PNG crops

  --render-manifest <path>   p0-render-manifest.jsonl from p0-render.mjs
  --mxl-root <path>          Root of MXL tree (prepended to relative mxlPath values)
  --output <path>            Output directory (default: ./data/p0)
  --workers <n>              Parallel workers (default: 4)
  --limit <n>                Stop after N scores (0 = all)
  --resume                   Skip scores whose layout.json already exists
  --dry-run                  Parse manifest; no disk writes
  --help                     This message
`.trim());
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(msg) { console.log(`${new Date().toTimeString().slice(0, 8)} INFO ${msg}`); }
function warn(msg) { console.warn(`${new Date().toTimeString().slice(0, 8)} WARN ${msg}`); }

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------
class Semaphore {
  constructor(n) { this._n = n; this._queue = []; }
  acquire() {
    if (this._n > 0) { this._n--; return Promise.resolve(); }
    return new Promise(res => this._queue.push(res));
  }
  release() {
    if (this._queue.length > 0) this._queue.shift()();
    else this._n++;
  }
}

// ---------------------------------------------------------------------------
// MuseScore
// ---------------------------------------------------------------------------
const MUSESCORE_CANDIDATES = [
  process.env.MUSIC_MUSESCORE_BIN,
  'musescore3', 'musescore', 'MuseScore3',
  'musescore4', 'mscore4portable', 'MuseScore4',
].filter(Boolean);

async function findMusescore() {
  const candidates = process.env.MUSIC_MUSESCORE_BIN_CANDIDATES
    ? process.env.MUSIC_MUSESCORE_BIN_CANDIDATES.split(',').map(s => s.trim()).filter(Boolean)
    : MUSESCORE_CANDIDATES;
  for (const bin of candidates) {
    try { await fs.access(bin); return bin; } catch {}
    const found = await new Promise(res => {
      const w = spawn('which', [bin], { stdio: 'pipe' });
      let out = '';
      w.stdout.on('data', d => { out += d; });
      w.on('close', code => res(code === 0 ? out.trim() : null));
    });
    if (found) return found;
  }
  return null;
}

/**
 * Render SVG-only for an MXL file. Returns array of svg Path strings, one per page.
 * Writes to a caller-supplied tmpDir and returns paths inside it.
 */
async function renderSvg({ bin, mxlPath, tmpDir, timeoutMs = 120_000 }) {
  const outBase = join(tmpDir, 'output.svg');
  const cmd = [bin, '-platform', 'offscreen', '-o', outBase, mxlPath];

  await new Promise(res => {
    const child = spawn(cmd[0], cmd.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' },
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', () => { clearTimeout(timer); res(timedOut); });
  });

  // Collect output.svg, output-1.svg, output-01.svg, …
  let files;
  try { files = await fs.readdir(tmpDir); } catch { return []; }
  const svgRe = /^output[-.]?\d*\.svg$/i;
  const svgs = files
    .filter(f => svgRe.test(f))
    .sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, '') || '0');
      const nb = parseInt(b.replace(/\D/g, '') || '0');
      return na - nb;
    })
    .map(f => join(tmpDir, f));

  // Single-page fallback: output.svg with no number
  if (svgs.length === 0) {
    const single = join(tmpDir, 'output.svg');
    try { await fs.access(single); return [single]; } catch {}
  }
  return svgs;
}

// ---------------------------------------------------------------------------
// SVG StaffLines parsing → system bounding boxes
// Algorithm from GEMMA_E4B_P0_DATA_FACTORY_DESIGN_2026-05-29.md §Stage 3
// ---------------------------------------------------------------------------

/**
 * Extract all unique y-values from class="StaffLines" polylines in raw SVG text.
 * Using regex rather than a full XML parse — MuseScore SVG is well-structured and
 * fast-xml-parser's attribute model makes point extraction awkward.
 */
function parseStafflineYs(svgText) {
  const ys = new Set();
  const polyRe = /class="StaffLines"[^>]*points="([^"]+)"/g;
  let m;
  while ((m = polyRe.exec(svgText)) !== null) {
    for (const pt of m[1].trim().split(/\s+/)) {
      const comma = pt.indexOf(',');
      if (comma >= 0) {
        const y = parseFloat(pt.slice(comma + 1));
        if (!isNaN(y)) ys.add(Math.round(y * 10) / 10);
      }
    }
  }
  return [...ys].sort((a, b) => a - b);
}

function parseSvgViewbox(svgText) {
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svgText);
  return m ? { w: parseFloat(m[1]), h: parseFloat(m[2]) } : null;
}

/**
 * Segment one SVG page into system bounding boxes (PNG pixel coords).
 * Returns [] for title/front-matter pages (no StaffLines).
 *
 * @param {string} svgText
 * @param {number} pngWidth
 * @param {number} pngHeight
 * @returns {Array<{y1:number, y2:number, staveCount:number}>}
 */
function segmentSystems(svgText, pngWidth, pngHeight) {
  const ys = parseStafflineYs(svgText);
  if (ys.length === 0) return [];

  const vb = parseSvgViewbox(svgText);
  if (!vb) return [];

  // Group into 5-line staves
  const staves = [];
  for (let i = 0; i < ys.length; i += 5) staves.push(ys.slice(i, i + 5));
  if (staves.length === 0) return [];

  const scaleY = pngHeight / vb.h;
  const firstStaff = staves[0];
  const lineSpacing = firstStaff.length >= 5
    ? (firstStaff[4] - firstStaff[0]) / 4
    : 25.0;
  const padding = lineSpacing * 2;

  if (staves.length === 1) {
    const y1 = Math.max(0, Math.floor((firstStaff[0] - padding) * scaleY));
    const y2 = Math.min(pngHeight, Math.ceil((firstStaff[firstStaff.length - 1] + padding) * scaleY));
    if (y2 - y1 < 50) return [];
    return [{ y1, y2, staveCount: 1 }];
  }

  // Inter-staff gaps
  const gaps = staves.slice(0, -1).map((s, i) => staves[i + 1][0] - s[s.length - 1]);
  const sortedGaps = [...gaps].sort((a, b) => a - b);

  // Auto-threshold: midpoint of the largest jump in sorted gaps
  let systemsStaves;
  if (sortedGaps.length === 1) {
    systemsStaves = [staves]; // all one system
  } else {
    let maxJump = -Infinity, maxJumpIdx = 0;
    for (let i = 0; i < sortedGaps.length - 1; i++) {
      const jump = sortedGaps[i + 1] - sortedGaps[i];
      if (jump > maxJump) { maxJump = jump; maxJumpIdx = i; }
    }
    const threshold = (sortedGaps[maxJumpIdx] + sortedGaps[maxJumpIdx + 1]) / 2;

    systemsStaves = [];
    let current = [staves[0]];
    for (let i = 0; i < gaps.length; i++) {
      if (gaps[i] > threshold) { systemsStaves.push(current); current = [staves[i + 1]]; }
      else current.push(staves[i + 1]);
    }
    systemsStaves.push(current);
  }

  const result = [];
  for (const sysStaves of systemsStaves) {
    const allYs = sysStaves.flat();
    const y1 = Math.max(0, Math.floor((Math.min(...allYs) - padding) * scaleY));
    const y2 = Math.min(pngHeight, Math.ceil((Math.max(...allYs) + padding) * scaleY));
    if (y2 - y1 < 50) continue;
    result.push({ y1, y2, staveCount: sysStaves.length });
  }
  return result;
}

// ---------------------------------------------------------------------------
// PNG metadata (width/height without decoding via sharp)
// ---------------------------------------------------------------------------
async function getPngDimensions(sharp, pngPath) {
  const meta = await sharp(pngPath).metadata();
  return { width: meta.width, height: meta.height };
}

// ---------------------------------------------------------------------------
// Manifest reading
// ---------------------------------------------------------------------------
async function readRenderManifest(manifestPath) {
  const rows = [];
  const rl = createInterface({
    input: createReadStream(manifestPath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch {}
  }
  return rows;
}

async function readDoneSet(donePath) {
  try {
    const text = await fs.readFile(donePath, 'utf8');
    return new Set(text.split('\n').map(l => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));

if (!args.renderManifest) {
  console.error('Error: --render-manifest is required');
  process.exit(1);
}

const outputDir   = resolve(args.output);
const cropsDir    = join(outputDir, 'crops');
const doneFile    = join(outputDir, 'p0-segment-done.txt');
const errorsFile  = join(outputDir, 'p0-segment-errors.jsonl');
const manifestOut = join(outputDir, 'p0-segment-manifest.jsonl');
const timeoutMs   = Number(process.env.MUSIC_MUSESCORE_TIMEOUT_MS || 120_000);

// Load sharp from /tmp/node_modules (installed at container prep time)
let sharp;
try {
  sharp = require('/tmp/node_modules/sharp');
} catch {
  try {
    sharp = require('sharp');
  } catch {
    console.error('Error: sharp not found. Run: npm install sharp (in /tmp or globally)');
    process.exit(1);
  }
}

const bin = await findMusescore();
if (!bin && !args.dryRun) {
  console.error('Error: MuseScore not found on PATH');
  process.exit(1);
}

log(`Reading render manifest: ${args.renderManifest}`);
const rows = await readRenderManifest(args.renderManifest);
log(`Loaded ${rows.length} entries from render manifest`);

const done = args.resume ? await readDoneSet(doneFile) : new Set();
if (args.resume && done.size > 0) log(`Resuming — ${done.size} scores already segmented`);

await fs.mkdir(cropsDir, { recursive: true });
const doneFh   = await fs.open(doneFile,    'a');
const errorsFh = await fs.open(errorsFile,  'a');
const maniFh   = await fs.open(manifestOut, 'a');

const sem = new Semaphore(args.workers);
let okCount = 0, errCount = 0, skipCount = 0, dispatched = 0;
const startTime = Date.now();

for (const row of rows) {
  if (args.limit > 0 && dispatched >= args.limit) break;

  const { scoreId, split, mxlPath, pngPaths } = row;
  if (!scoreId || !pngPaths?.length) continue;

  // Resolve mxlPath: absolute or relative to mxl-root
  let resolvedMxl = mxlPath;
  if (args.mxlRoot && !mxlPath.startsWith('/')) {
    resolvedMxl = join(args.mxlRoot, mxlPath);
  }

  // Layout JSON path: crops/<split>/<scoreId>-layout.json
  const scoreCropsDir = join(cropsDir, split || 'train');
  const layoutPath    = join(scoreCropsDir, `${scoreId}-layout.json`);

  if (args.resume && done.has(scoreId)) { skipCount++; continue; }

  dispatched++;

  (async () => {
    await sem.acquire();
    try {
      if (args.dryRun) {
        okCount++;
        return;
      }

      // Check mxl exists
      try { await fs.access(resolvedMxl); } catch {
        errCount++;
        await errorsFh.appendFile(JSON.stringify({ scoreId, error: 'mxl_missing' }) + '\n');
        return;
      }

      await fs.mkdir(scoreCropsDir, { recursive: true });

      // Re-render SVG only
      const tmpDir = join(tmpdir(), `p0-seg-${scoreId}-${randomUUID().slice(0, 8)}`);
      await fs.mkdir(tmpDir, { recursive: true });

      let svgPaths;
      try {
        svgPaths = await renderSvg({ bin, mxlPath: resolvedMxl, tmpDir, timeoutMs });
      } catch (e) {
        errCount++;
        await errorsFh.appendFile(JSON.stringify({ scoreId, error: `svg_render_error: ${e.message}` }) + '\n');
        await fs.rm(tmpDir, { recursive: true, force: true });
        return;
      }

      if (svgPaths.length === 0) {
        errCount++;
        await errorsFh.appendFile(JSON.stringify({ scoreId, error: 'svg_no_output' }) + '\n');
        await fs.rm(tmpDir, { recursive: true, force: true });
        return;
      }

      const layoutPages = [];
      let anyCrop = false;

      for (let pageIdx = 0; pageIdx < pngPaths.length; pageIdx++) {
        const pngPath = pngPaths[pageIdx];
        const svgPath = svgPaths[pageIdx];

        // Absolute paths in manifest; no mxl-root adjustment needed
        const resolvedPng = pngPath.startsWith('/') ? pngPath : join(outputDir, pngPath);
        const pageNum = pageIdx + 1;

        // Get PNG dimensions
        let pngW, pngH;
        try {
          const dims = await getPngDimensions(sharp, resolvedPng);
          pngW = dims.width;
          pngH = dims.height;
        } catch {
          layoutPages.push({ pageIndex: pageNum, pngPath, hasMusicContent: false, systems: [], error: 'png_read_failed' });
          continue;
        }

        // Read SVG (may be absent if MuseScore produced fewer pages than PNGs)
        let svgText = '';
        if (svgPath) {
          try { svgText = await fs.readFile(svgPath, 'utf8'); } catch {}
        }

        const systems = svgText ? segmentSystems(svgText, pngW, pngH) : [];
        const pageEntry = {
          pageIndex: pageNum,
          pngPath,
          hasMusicContent: systems.length > 0,
          systems: [],
        };

        for (let sysIdx = 0; sysIdx < systems.length; sysIdx++) {
          const { y1, y2, staveCount } = systems[sysIdx];
          const cropName = `${scoreId}-p${String(pageNum).padStart(2, '0')}-s${String(sysIdx).padStart(2, '0')}`;
          const cropFile = join(scoreCropsDir, `${cropName}.png`);

          // Crop with sharp (full width, y-strip)
          try {
            await sharp(resolvedPng)
              .extract({ left: 0, top: y1, width: pngW, height: y2 - y1 })
              .flatten({ background: { r: 255, g: 255, b: 255 } })
              .toFile(cropFile);
            anyCrop = true;
          } catch (e) {
            warn(`Crop failed ${cropName}: ${e.message}`);
            continue;
          }

          pageEntry.systems.push({
            systemIndex: sysIdx,
            cropPath: `crops/${split}/${cropName}.png`,
            bbox: { x: 0, y: y1, w: pngW, h: y2 - y1 },
            staveCount,
            measureRange: null,   // filled by p0-align.py
          });
        }

        layoutPages.push(pageEntry);
      }

      // Write layout JSON
      const layout = { scoreId, split, mxlPath: resolvedMxl, pages: layoutPages };
      await fs.writeFile(layoutPath, JSON.stringify(layout, null, 2));

      // Write manifest line
      const totalSystems = layoutPages.reduce((n, p) => n + p.systems.length, 0);
      await maniFh.appendFile(JSON.stringify({ scoreId, split, layoutPath, pageCount: pngPaths.length, systemCount: totalSystems }) + '\n');

      if (anyCrop) {
        okCount++;
        await doneFh.appendFile(scoreId + '\n');
      } else {
        // Rendered but no crops (all pages were title/front-matter)
        errCount++;
        await errorsFh.appendFile(JSON.stringify({ scoreId, error: 'no_systems_found' }) + '\n');
      }

      await fs.rm(tmpDir, { recursive: true, force: true });

    } finally {
      sem.release();
      const elapsed = (Date.now() - startTime) / 1000;
      const total = okCount + errCount;
      if (total > 0 && total % 50 === 0) {
        const rate = (total / elapsed).toFixed(1);
        log(`Progress: ${okCount} ok / ${errCount} err / ${skipCount} skip | ${rate} scores/s`);
      }
    }
  })();
}

// Wait for all tasks to drain
for (let i = 0; i < args.workers; i++) await sem.acquire();

await doneFh.close();
await errorsFh.close();
await maniFh.close();

const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
log(`Done: ${okCount} ok / ${errCount} err / ${skipCount} skip in ${elapsed}s`);
