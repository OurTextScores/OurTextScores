#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const mongoose = require('mongoose');

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = {};
  for (const entry of argv) {
    if (!entry.startsWith('--')) continue;
    const idx = entry.indexOf('=');
    if (idx === -1) {
      args[entry.slice(2)] = 'true';
    } else {
      args[entry.slice(2, idx)] = entry.slice(idx + 1);
    }
  }
  return args;
}

function asBool(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return fallback;
}

function asInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clean(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed.length ? trimmed : undefined;
}

function isUrl(value) {
  return /^https?:\/\//i.test(value || '');
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed download ${url}: ${response.status} ${response.statusText}`);
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
}

async function extractArchive(archivePath, destinationRoot) {
  await fsp.mkdir(destinationRoot, { recursive: true });
  await execFileAsync('tar', ['-xzf', archivePath, '-C', destinationRoot]);
}

function resolveAssetPath(root, relativePath) {
  const rel = String(relativePath || '').replace(/^\.\//, '').replace(/^\/+/, '');
  const full = path.resolve(path.join(root, rel));
  const normalizedRoot = path.resolve(root);
  const rootPrefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  if (full !== normalizedRoot && !full.startsWith(rootPrefix)) {
    throw new Error(`Unsafe asset path: ${relativePath}`);
  }
  return full;
}

async function verifySample(storageRoot, sampleSize, mongoUri) {
  if (!mongoUri) {
    console.log('[pdmx-sync-assets] MONGO_URI not set; skipping verification sample');
    return;
  }

  await mongoose.connect(mongoUri);
  try {
    const collection = mongoose.connection.db.collection('pdmx_records');
    const docs = await collection
      .aggregate([
        {
          $match: {
            'assets.pdfPath': { $exists: true, $ne: '' },
            'assets.mxlPath': { $exists: true, $ne: '' }
          }
        },
        { $sample: { size: sampleSize } },
        { $project: { pdmxId: 1, assets: 1 } }
      ])
      .toArray();

    let missingPdf = 0;
    let missingMxl = 0;
    for (const doc of docs) {
      const pdfPath = resolveAssetPath(storageRoot, doc?.assets?.pdfPath);
      const mxlPath = resolveAssetPath(storageRoot, doc?.assets?.mxlPath);
      const [pdfStat, mxlStat] = await Promise.all([
        fsp.stat(pdfPath).catch(() => null),
        fsp.stat(mxlPath).catch(() => null)
      ]);
      if (!pdfStat || !pdfStat.isFile()) missingPdf += 1;
      if (!mxlStat || !mxlStat.isFile()) missingMxl += 1;
    }

    console.log(`[pdmx-sync-assets] verification sample=${docs.length} missingPdf=${missingPdf} missingMxl=${missingMxl}`);
  } finally {
    await mongoose.disconnect();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const recordId = clean(args['record-id']) || clean(process.env.PDMX_ZENODO_RECORD_ID) || '15571083';
  const storageRoot = clean(args['storage-root']) || clean(process.env.PDMX_STORAGE_ROOT);
  if (!storageRoot) {
    throw new Error('storage root required (--storage-root or PDMX_STORAGE_ROOT)');
  }

  const skipDownload = asBool(args['skip-download'], false);
  const verifyOnly = asBool(args['verify-only'], false);
  const sampleSize = Math.max(1, asInt(args['sample-size'], 500));
  const mongoUri = clean(args['mongo-uri']) || clean(process.env.MONGO_URI);

  const defaultPdfUrl = `https://zenodo.org/api/records/${recordId}/files/pdf.tar.gz/content`;
  const defaultMxlUrl = `https://zenodo.org/api/records/${recordId}/files/mxl.tar.gz/content`;
  const pdfSource = clean(args['pdf-archive']) || defaultPdfUrl;
  const mxlSource = clean(args['mxl-archive']) || defaultMxlUrl;

  const downloadDir = path.join(storageRoot, '.downloads');
  const pdfArchivePath = isUrl(pdfSource) ? path.join(downloadDir, 'pdf.tar.gz') : pdfSource;
  const mxlArchivePath = isUrl(mxlSource) ? path.join(downloadDir, 'mxl.tar.gz') : mxlSource;

  console.log(`[pdmx-sync-assets] storageRoot=${storageRoot}`);
  console.log(`[pdmx-sync-assets] recordId=${recordId}`);
  console.log(`[pdmx-sync-assets] verifyOnly=${verifyOnly} skipDownload=${skipDownload}`);

  await fsp.mkdir(storageRoot, { recursive: true });

  if (!verifyOnly) {
    if (!skipDownload) {
      if (isUrl(pdfSource)) {
        console.log(`[pdmx-sync-assets] downloading PDF archive from ${pdfSource}`);
        await download(pdfSource, pdfArchivePath);
      }
      if (isUrl(mxlSource)) {
        console.log(`[pdmx-sync-assets] downloading MXL archive from ${mxlSource}`);
        await download(mxlSource, mxlArchivePath);
      }
    }

    const [pdfExists, mxlExists] = await Promise.all([
      fsp.stat(pdfArchivePath).catch(() => null),
      fsp.stat(mxlArchivePath).catch(() => null)
    ]);
    if (!pdfExists || !pdfExists.isFile()) {
      throw new Error(`PDF archive not found: ${pdfArchivePath}`);
    }
    if (!mxlExists || !mxlExists.isFile()) {
      throw new Error(`MXL archive not found: ${mxlArchivePath}`);
    }

    console.log('[pdmx-sync-assets] extracting PDF archive');
    await extractArchive(pdfArchivePath, storageRoot);
    console.log('[pdmx-sync-assets] extracting MXL archive');
    await extractArchive(mxlArchivePath, storageRoot);
  }

  await verifySample(storageRoot, sampleSize, mongoUri);
  console.log('[pdmx-sync-assets] complete');
}

main().catch((error) => {
  console.error('[pdmx-sync-assets] failed', error);
  process.exit(1);
});
