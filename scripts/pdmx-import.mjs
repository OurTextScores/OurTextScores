#!/usr/bin/env node
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { parse } from 'csv-parse';

const __dirname = path.resolve();

const env = (name, fallback) => {
  const val = process.env[name];
  return val === undefined ? fallback : val;
};

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const CONFIG = {
  mongoUri: args.mongoUri || env('MONGO_URI', 'mongodb://192.168.2.20:27017/'),
  mongoDb: args.mongoDb || env('MONGO_DB', 'scores'),
  confidence: args.confidence || env('CONFIDENCE', 'high'),
  limit: Number(args.limit ?? env('LIMIT', '10')),
  resumeAfter: args.resumeAfter || env('RESUME_AFTER', ''),
  dryRun: args.dryRun || env('DRY_RUN', '') === '1' || env('DRY_RUN', '')?.toLowerCase() === 'true',
  apiBase: args.apiBase || env('API_BASE', 'http://localhost:4000/api'),
  dataDir: path.resolve(__dirname, 'data')
};

const state = {
  successes: [],
  skipped: [],
  errors: []
};

async function main() {
  console.log('PDMX→IMSLP import starting', {
    mongoUri: CONFIG.mongoUri,
    mongoDb: CONFIG.mongoDb,
    apiBase: CONFIG.apiBase,
    confidence: CONFIG.confidence,
    limit: CONFIG.limit,
    resumeAfter: CONFIG.resumeAfter || null,
    dryRun: CONFIG.dryRun
  });

  const client = new MongoClient(CONFIG.mongoUri);
  await client.connect();

  try {
    const db = client.db(CONFIG.mongoDb);
    const candidates = await fetchCandidates(db);
    if (!candidates.length) {
      console.log('No candidates found for the given filters.');
      return;
    }

    const scoreIdSet = new Set(
      candidates.map((item) => item.scoreId).filter(Boolean).map((id) => String(id))
    );
    const csvLookup = await loadCsvLookup(scoreIdSet);

    for (const candidate of candidates) {
      await processCandidate(candidate, csvLookup);
    }
  } finally {
    await client.close();
  }

  printSummary();
}

async function fetchCandidates(db) {
  const matchesCol = db.collection('PDMX_to_IMSLP_exact_matches');
  const imslpCol = db.collection('imslp');
  const pdmxCol = db.collection('PDMX');

  const query = { confidence: CONFIG.confidence };
  if (CONFIG.resumeAfter) {
    if (!ObjectId.isValid(CONFIG.resumeAfter)) {
      throw new Error(`Invalid resumeAfter ObjectId: ${CONFIG.resumeAfter}`);
    }
    query._id = { $gt: new ObjectId(CONFIG.resumeAfter) };
  }

  const docs = await matchesCol.find(query).sort({ _id: 1 }).limit(CONFIG.limit).toArray();
  console.log(`Fetched ${docs.length} match documents`);

  const results = [];
  for (const doc of docs) {
    const imslpObjectId = toObjectId(doc.imslp_page_id || doc.imslp_id);
    const pdmxObjectId = toObjectId(doc.pdmx_id);

    const [imslpDoc, pdmxDoc] = await Promise.all([
      imslpObjectId ? imslpCol.findOne({ _id: imslpObjectId }) : null,
      pdmxObjectId ? pdmxCol.findOne({ _id: pdmxObjectId }) : null
    ]);

    const pageId = imslpDoc?.basic_info?.page_id ?? imslpDoc?.page_id ?? null;
    const imslpUrl = imslpDoc?.url || imslpDoc?.basic_info?.url;
    const scoreId = pdmxDoc?.data?.score?.id ?? pdmxDoc?.score?.id;

    results.push({
      match: doc,
      pdmxDoc,
      imslpDoc,
      pageId,
      imslpUrl,
      scoreId,
      pdmxId: pdmxObjectId ? pdmxObjectId.toString() : null,
      imslpMongoId: imslpObjectId ? imslpObjectId.toString() : null
    });
  }

  return results;
}

async function loadCsvLookup(scoreIds) {
  if (!scoreIds.size) return {};

  const csvPath = path.join(CONFIG.dataDir, 'PDMX.csv');
  const found = {};
  const targetCount = scoreIds.size;
  let seen = 0;

  const parser = parse({ columns: true, skip_empty_lines: true });
  const stream = createReadStream(csvPath);
  stream.pipe(parser);

  for await (const row of parser) {
    const metadataPath = row.metadata || '';
    const idMatch = metadataPath.match(/\/(\d+)\.json$/);
    if (!idMatch) continue;
    const scoreId = idMatch[1];
    if (scoreIds.has(scoreId)) {
      found[scoreId] = row;
      seen += 1;
      if (seen === targetCount) {
        break;
      }
    }
  }

  parser.destroy();
  stream.destroy();
  return found;
}

async function processCandidate(candidate, csvLookup) {
  const { match, pdmxDoc, imslpDoc, pageId, imslpUrl, scoreId } = candidate;
  const idLabel = match?._id?.toString?.() || 'unknown';

  if (!pdmxDoc || !imslpDoc) {
    state.skipped.push({ id: idLabel, reason: 'Missing pdmx/imslp doc', pdmxId: candidate.pdmxId, imslpId: candidate.imslpMongoId });
    console.warn(`SKIP ${idLabel}: missing pdmx or imslp document`);
    return;
  }
  if (!scoreId) {
    state.skipped.push({ id: idLabel, reason: 'Missing scoreId in PDMX doc' });
    console.warn(`SKIP ${idLabel}: missing scoreId in PDMX doc`);
    return;
  }
  const csvRow = csvLookup[String(scoreId)];
  if (!csvRow) {
    state.skipped.push({ id: idLabel, reason: 'CSV row not found for scoreId', scoreId });
    console.warn(`SKIP ${idLabel}: no CSV row for scoreId ${scoreId}`);
    return;
  }

  const mxlPath = path.resolve(CONFIG.dataDir, csvRow.mxl.replace(/^\.\//, ''));
  const licenseFlag = (csvRow['subset:no_license_conflict'] || '').toLowerCase() === 'true';
  const license = licenseFlag ? 'Public Domain' : undefined;
  const licenseUrl = license ? normalizeValue(csvRow.license_url) : undefined;

  try {
    await fs.access(mxlPath);
  } catch {
    state.skipped.push({ id: idLabel, reason: 'MXL file missing', mxlPath });
    console.warn(`SKIP ${idLabel}: MXL missing at ${mxlPath}`);
    return;
  }

  const workTitle = imslpDoc?.basic_info?.page_title || match?.title_imslp || 'Unknown IMSLP title';
  const composer = imslpDoc?.musical_metadata?.composer || match?.composer_imslp || 'Unknown composer';
  const label = `PDMX import ${scoreId}`;
  const description = `Imported from PDMX (${candidate.pdmxId || 'unknown'}) — confidence ${match?.confidence || 'n/a'} — composer ${composer}`;

  const workInfo = {
    workId: pageId ? String(pageId) : null,
    imslpUrl
  };

  if (CONFIG.dryRun) {
    console.log(`DRY-RUN ${idLabel}: would ensure work ${workInfo.workId || 'via url'} and upload ${mxlPath} (${license})`);
    state.skipped.push({ id: idLabel, reason: 'dry-run', workId: workInfo.workId, mxlPath, license });
    return;
  }

  try {
    const ensuredWork = await ensureWork(workInfo);
    const targetWorkId = ensuredWork?.workId || ensuredWork?.work?.workId;
    if (!targetWorkId) {
      state.errors.push({ id: idLabel, reason: 'Work ensure failed (no workId returned)', detail: ensuredWork });
      console.error(`ERROR ${idLabel}: failed to ensure work for pageId=${workInfo.workId} (no workId returned)`);
      return;
    }

    // Check if source already exists to avoid duplicates
    const workDetail = await fetchJson(`${CONFIG.apiBase}/works/${encodeURIComponent(targetWorkId)}`);
    const existingSources = workDetail.data?.sources || [];
    const alreadyExists = existingSources.some(s => s.label === label);

    if (alreadyExists) {
      console.log(`SKIP upload ${idLabel}: source with label "${label}" already exists.`);
      state.skipped.push({ id: idLabel, reason: 'Source already exists', workId: targetWorkId });
    } else {
      const uploadResult = await uploadSource({
        workId: targetWorkId,
        mxlPath,
        label,
        description,
        license,
        licenseUrl
      });

      state.successes.push({
        id: idLabel,
        workId: targetWorkId,
        sourceId: uploadResult?.sourceId,
        revisionId: uploadResult?.revisionId,
        message: uploadResult?.message,
        scoreId
      });

      console.log(`OK ${idLabel}: work ${targetWorkId}, source ${uploadResult?.sourceId}, ${mxlPath}`);
    }

    // 3. Update metadata if we parsed it successfully
    const parsed = parseTitle(workTitle);
    if (parsed && !CONFIG.dryRun) {
      try {
        await updateMetadata(targetWorkId, parsed);
        console.log(`   -> Metadata updated: ${JSON.stringify(parsed)}`);
      } catch (err) {
        console.error(`   -> Metadata update failed: ${err.message}`);
        state.errors.push({ id: idLabel, reason: 'Metadata update failed', detail: err.message });
      }
    } else if (parsed && CONFIG.dryRun) {
      console.log(`   -> Would update metadata: ${JSON.stringify(parsed)}`);
    }

  } catch (error) {
    state.errors.push({ id: idLabel, reason: error.message || 'Unknown error' });
    console.error(`ERROR ${idLabel}: ${error.message || error}`);
  }
}

async function updateMetadata(workId, updates) {
  const res = await fetchJson(`${CONFIG.apiBase}/works/${encodeURIComponent(workId)}/metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  });
  if (!res.ok) {
    throw new Error(`Metadata update failed: ${res.error || res.statusText}`);
  }
  return res.data;
}

function parseTitle(rawTitle) {
  // Expected format: "Title, Catalog (Composer)"
  // Examples:
  // "Hungarian Rhapsody No.4, S.244/4 (Liszt, Franz)"
  // "Symphony No.8, D.759 (Schubert, Franz)"

  if (!rawTitle) return null;

  // Regex breakdown:
  // ^(.*)       -> Capture title (greedy, so it takes everything up to the last comma-space-catalog sequence)
  // ,           -> Separator
  // \s+         -> Space
  // (.*?)       -> Capture catalog (non-greedy, any character)
  // \s+         -> Space
  // \((.*)\)$   -> Capture composer in parens
  const regex = /^(.*),\s+(.*?)\s+\((.*)\)$/;
  const match = rawTitle.match(regex);

  if (match) {
    return {
      title: match[1].trim(),
      catalogNumber: match[2].trim(),
      composer: match[3].trim()
    };
  }

  // Fallback: try to just extract composer if present at the end
  // "Some Title (Composer)"
  const composerMatch = rawTitle.match(/^(.*)\s+\((.*)\)$/);
  if (composerMatch) {
    return {
      title: composerMatch[1].trim(),
      composer: composerMatch[2].trim()
    };
  }

  return { title: rawTitle };
}

async function ensureWork({ workId, imslpUrl }) {
  if (!workId && !imslpUrl) {
    throw new Error('Cannot ensure work without workId or imslpUrl');
  }

  const attempts = [];

  // Prefer explicit workId when available; if it fails, try URL-based enrichment
  if (workId) {
    const res = await fetchJson(`${CONFIG.apiBase}/works`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workId })
    });
    attempts.push({ via: 'workId', status: res.status, error: res.error });
    if (res.ok) return res.data;
  }

  if (imslpUrl) {
    const res = await fetchJson(`${CONFIG.apiBase}/works/save-by-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: imslpUrl })
    });
    attempts.push({ via: 'url', status: res.status, error: res.error });
    if (res.ok) return res.data;
  }

  const details = attempts.map((a) => `${a.via}:${a.status}${a.error ? `:${a.error}` : ''}`).join(', ');
  throw new Error(`Failed to ensure work (workId=${workId || 'n/a'}, url=${imslpUrl || 'n/a'}) [${details || 'no attempts'}]`);
}

async function uploadSource({ workId, mxlPath, label, description, license, licenseUrl }) {
  const buffer = await fs.readFile(mxlPath);
  const fileName = path.basename(mxlPath);
  const form = new FormData();
  form.append('file', new File([buffer], fileName, { type: 'application/vnd.recordare.musicxml' }));
  form.append('label', label);
  form.append('description', description);
  form.append('isPrimary', 'true');
  form.append('formatHint', 'mxl');
  if (license) {
    form.append('license', license);
  }
  if (licenseUrl) {
    form.append('licenseUrl', licenseUrl);
  }

  const res = await fetchJson(`${CONFIG.apiBase}/works/${workId}/sources`, {
    method: 'POST',
    headers: { 'x-progress-id': randomUUID() },
    body: form
  });

  if (!res.ok) {
    throw new Error(`Upload failed (status ${res.status}): ${res.error || res.statusText}`);
  }
  return res.data;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    data,
    error: !response.ok ? data?.message || data?.error : null
  };
}

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof ObjectId) return value;
  try {
    return new ObjectId(String(value));
  } catch {
    return null;
  }
}

function normalizeValue(val) {
  if (!val || val === 'NA') return undefined;
  return String(val).trim();
}

function parseArgs(argv) {
  const flags = new Set(['--dry-run', '-d', '--help', '-h']);
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--mongo-uri':
        out.mongoUri = argv[++i];
        break;
      case '--mongo-db':
        out.mongoDb = argv[++i];
        break;
      case '--api-base':
        out.apiBase = argv[++i];
        break;
      case '--confidence':
        out.confidence = argv[++i];
        break;
      case '--limit':
        out.limit = argv[++i];
        break;
      case '--resume-after':
        out.resumeAfter = argv[++i];
        break;
      case '--dry-run':
      case '-d':
        out.dryRun = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        if (arg.startsWith('--')) {
          console.warn(`Unknown argument: ${arg}`);
        }
        break;
    }
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/pdmx-import.mjs [options]

Options:
  --mongo-uri <uri>        Mongo URI (default: env MONGO_URI or mongodb://192.168.2.20:27017/)
  --mongo-db <db>          Mongo database name (default: env MONGO_DB or scores)
  --api-base <url>         API base URL (default: env API_BASE or http://localhost:4000/api)
  --confidence <value>     Confidence filter (default: high)
  --limit <n>              Max records to process (default: 10)
  --resume-after <oid>     Resume after this ObjectId from matches collection
  --dry-run, -d            Do not call APIs; just log planned actions
  --help, -h               Show this help

Env overrides: MONGO_URI, MONGO_DB, API_BASE, CONFIDENCE, LIMIT, RESUME_AFTER, DRY_RUN.`);
}

function printSummary() {
  console.log('\nSummary:');
  console.log(`  Successes: ${state.successes.length}`);
  state.successes.forEach((s) => {
    console.log(`    - match ${s.id}: work ${s.workId}, source ${s.sourceId}, revision ${s.revisionId}`);
  });

  console.log(`  Skipped: ${state.skipped.length}`);
  state.skipped.forEach((s) => {
    console.log(`    - match ${s.id || 'unknown'}: ${s.reason}`);
  });

  console.log(`  Errors: ${state.errors.length}`);
  state.errors.forEach((e) => {
    console.log(`    - match ${e.id || 'unknown'}: ${e.reason}`);
  });
}

main().catch((err) => {
  console.error('Fatal error during import', err);
  process.exit(1);
});
