#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { Readable } = require('node:stream');
const mongoose = require('mongoose');

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

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function clean(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanPath(value) {
  const normalized = clean(value);
  if (!normalized) return undefined;
  return normalized.replace(/^\.\//, '');
}

function toBool(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function toNumber(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.toUpperCase() === 'NA') return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toInt(value) {
  const numeric = toNumber(value);
  return typeof numeric === 'number' ? Math.trunc(numeric) : undefined;
}

function derivePdmxId(dataPath) {
  const cleaned = cleanPath(dataPath);
  if (!cleaned) return undefined;
  return path.basename(cleaned).replace(/\.[^.]+$/, '');
}

async function getInputStream(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to fetch CSV source: ${response.status} ${response.statusText}`);
    }
    return Readable.fromWeb(response.body);
  }
  return fs.createReadStream(source);
}

async function acquireLock() {
  const locks = mongoose.connection.db.collection('pdmx_import_locks');
  const owner = `${os.hostname()}:${process.pid}:${Date.now()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (6 * 60 * 60 * 1000));

  const doc = await locks.findOneAndUpdate(
    {
      _id: 'pdmx_csv',
      $or: [{ locked: { $ne: true } }, { expiresAt: { $lte: now } }]
    },
    {
      $set: {
        locked: true,
        owner,
        acquiredAt: now,
        expiresAt
      }
    },
    {
      upsert: true,
      returnDocument: 'after'
    }
  );

  const value = doc && typeof doc === 'object' && 'value' in doc ? doc.value : doc;
  if (!value || value.owner !== owner) {
    throw new Error('Could not acquire import lock (another import may be running)');
  }

  return owner;
}

async function releaseLock(owner) {
  if (!owner) return;
  const locks = mongoose.connection.db.collection('pdmx_import_locks');
  await locks.updateOne(
    { _id: 'pdmx_csv', owner },
    {
      $set: {
        locked: false,
        releasedAt: new Date()
      }
    }
  );
}

function buildRowDoc(row, datasetRecordId) {
  const pdmxId = derivePdmxId(row.path);
  if (!pdmxId) return null;

  return {
    pdmxId,
    datasetRecordId,
    datasetVersion: clean(row.version),
    assets: {
      dataJsonPath: cleanPath(row.path),
      metadataJsonPath: cleanPath(row.metadata),
      mxlPath: cleanPath(row.mxl),
      pdfPath: cleanPath(row.pdf),
      midPath: cleanPath(row.mid)
    },
    title: clean(row.title),
    songName: clean(row.song_name),
    artistName: clean(row.artist_name),
    composerName: clean(row.composer_name),
    publisher: clean(row.publisher),
    subtitle: clean(row.subtitle),
    genres: clean(row.genres),
    groups: clean(row.groups),
    tags: clean(row.tags),
    license: clean(row.license),
    licenseUrl: clean(row.license_url),
    licenseConflict: toBool(row.license_conflict),
    rating: toNumber(row.rating),
    nRatings: toInt(row.n_ratings),
    nViews: toInt(row.n_views),
    nFavorites: toInt(row.n_favorites),
    nNotes: toInt(row.n_notes),
    nTracks: toInt(row.n_tracks),
    nLyrics: toInt(row.n_lyrics),
    nTokens: toInt(row.n_tokens),
    subsets: {
      all: toBool(row['subset:all']),
      rated: toBool(row['subset:rated']),
      deduplicated: toBool(row['subset:deduplicated']),
      ratedDeduplicated: toBool(row['subset:rated_deduplicated']),
      noLicenseConflict: toBool(row['subset:no_license_conflict']),
      allValid: toBool(row['subset:all_valid'])
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = args.source || `https://zenodo.org/api/records/${args['dataset-record-id'] || '15571083'}/files/PDMX.csv/content`;
  const mongoUri = process.env.MONGO_URI || '';
  if (!mongoUri) {
    throw new Error('MONGO_URI is required');
  }

  const batchSize = Math.max(1, asInt(args['batch-size'], 1000));
  const dryRun = asBool(args['dry-run'], false);
  const limit = Math.max(0, asInt(args.limit, 0));
  const resumeFrom = clean(args['resume-from']);
  const datasetRecordId = asInt(args['dataset-record-id'], 15571083);

  console.log(`[pdmx-import] source=${source}`);
  console.log(`[pdmx-import] batchSize=${batchSize} dryRun=${dryRun} limit=${limit || 'none'} resumeFrom=${resumeFrom || 'none'}`);

  await mongoose.connect(mongoUri);
  const owner = await acquireLock();

  let header = [];
  let processed = 0;
  let skipped = 0;
  let parseErrors = 0;
  let upserted = 0;
  let modified = 0;
  let matched = 0;
  let offsetCounter = 0;
  let resumeReached = !resumeFrom || /^\d+$/.test(resumeFrom);
  const resumeOffset = /^\d+$/.test(resumeFrom || '') ? Number.parseInt(resumeFrom, 10) : null;
  let batch = [];
  const startedAt = Date.now();

  try {
    const stream = await getInputStream(source);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line || !line.trim()) continue;

      if (header.length === 0) {
        header = parseCsvLine(line).map((value, idx) => {
          if (idx === 0) return String(value).replace(/^\uFEFF/, '');
          return value;
        });
        continue;
      }

      const values = parseCsvLine(line);
      if (values.length !== header.length) {
        parseErrors += 1;
        continue;
      }

      const row = {};
      for (let i = 0; i < header.length; i += 1) {
        row[header[i]] = values[i];
      }

      const doc = buildRowDoc(row, datasetRecordId);
      if (!doc) {
        parseErrors += 1;
        continue;
      }

      if (resumeOffset != null) {
        if (offsetCounter < resumeOffset) {
          offsetCounter += 1;
          skipped += 1;
          continue;
        }
      } else if (!resumeReached) {
        if (doc.pdmxId !== resumeFrom) {
          skipped += 1;
          continue;
        }
        resumeReached = true;
      }

      processed += 1;
      if (!dryRun) {
        batch.push({
          updateOne: {
            filter: { pdmxId: doc.pdmxId },
            update: {
              $set: doc,
              $setOnInsert: {
                review: {
                  qualityStatus: 'unknown',
                  excludedFromSearch: false
                },
                import: {
                  status: 'not_imported'
                }
              }
            },
            upsert: true
          }
        });
      }

      if (limit > 0 && processed >= limit) {
        break;
      }

      if (!dryRun && batch.length >= batchSize) {
        const result = await mongoose.connection.db.collection('pdmx_records').bulkWrite(batch, { ordered: false });
        upserted += result.upsertedCount || 0;
        modified += result.modifiedCount || 0;
        matched += result.matchedCount || 0;
        batch = [];
      }

      if (processed % 5000 === 0) {
        console.log(`[pdmx-import] processed=${processed} skipped=${skipped} parseErrors=${parseErrors}`);
      }
    }

    if (!dryRun && batch.length > 0) {
      const result = await mongoose.connection.db.collection('pdmx_records').bulkWrite(batch, { ordered: false });
      upserted += result.upsertedCount || 0;
      modified += result.modifiedCount || 0;
      matched += result.matchedCount || 0;
    }

    if (resumeFrom && !resumeReached && resumeOffset == null) {
      console.log(`[pdmx-import] warning: resume-from id not found: ${resumeFrom}`);
    }
  } finally {
    await releaseLock(owner);
    await mongoose.disconnect();
  }

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  console.log('[pdmx-import] complete');
  console.log(`[pdmx-import] processed=${processed} skipped=${skipped} parseErrors=${parseErrors} durationSec=${durationSec}`);
  if (!dryRun) {
    console.log(`[pdmx-import] upserted=${upserted} modified=${modified} matched=${matched}`);
  }
}

main().catch((error) => {
  console.error('[pdmx-import] failed', error);
  process.exit(1);
});
