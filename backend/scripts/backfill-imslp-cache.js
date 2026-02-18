#!/usr/bin/env node
/**
 * Backfill missing IMSLP cache docs for work IDs.
 *
 * Default behavior:
 * - Targets works linked to one or more projectIds
 * - Only refreshes workIds that are missing in the `imslp` collection
 *
 * Examples:
 *   node scripts/backfill-imslp-cache.js --projectId prj_abc123
 *   node scripts/backfill-imslp-cache.js --projectId prj_a,prj_b --refreshExisting
 *   node scripts/backfill-imslp-cache.js --allWorks
 *   node scripts/backfill-imslp-cache.js --projectId prj_abc123 --dryRun
 */

const mongoose = require('mongoose');

function parseArgs(argv) {
  const out = {
    projectIds: [],
    allWorks: false,
    refreshExisting: false,
    dryRun: false,
    apiBase: process.env.API_BASE || 'http://localhost:4000/api',
    delayMs: Number.parseInt(process.env.REQUEST_DELAY_MS || '150', 10),
    limit: Number.parseInt(process.env.LIMIT || '0', 10)
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--projectId' || token === '--projectIds') {
      const value = String(argv[i + 1] || '').trim();
      i += 1;
      if (value) {
        out.projectIds.push(
          ...value
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        );
      }
      continue;
    }
    if (token === '--allWorks') {
      out.allWorks = true;
      continue;
    }
    if (token === '--refreshExisting') {
      out.refreshExisting = true;
      continue;
    }
    if (token === '--dryRun') {
      out.dryRun = true;
      continue;
    }
    if (token === '--apiBase') {
      out.apiBase = String(argv[i + 1] || '').trim() || out.apiBase;
      i += 1;
      continue;
    }
    if (token === '--delayMs') {
      out.delayMs = Number.parseInt(String(argv[i + 1] || '150'), 10);
      i += 1;
      continue;
    }
    if (token === '--limit') {
      out.limit = Number.parseInt(String(argv[i + 1] || '0'), 10);
      i += 1;
      continue;
    }
  }

  out.projectIds = Array.from(new Set(out.projectIds));
  return out;
}

function resolveMongoUri() {
  return (
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    process.env.DATABASE_URL ||
    'mongodb://mongo:27017/ourtextscores'
  );
}

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeApiBase(value) {
  const base = String(value || '').trim().replace(/\/+$/, '');
  if (!base) return 'http://localhost:4000/api';
  return base.endsWith('/api') ? base : `${base}/api`;
}

function isValidWorkId(workId) {
  return /^\d+$/.test(String(workId || '').trim());
}

async function requestJson(url, init = {}, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const detail = typeof body?.message === 'string' ? body.message : text;
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function collectWorkIdsForProjects(db, projectIds) {
  const sourceRowsPromise = db
    .collection('sources')
    .find({ projectIds: { $in: projectIds } }, { projection: { _id: 0, workId: 1 } })
    .toArray();

  const projectRowsPromise = db
    .collection('project_source_rows')
    .find(
      {
        projectId: { $in: projectIds },
        linkedWorkId: { $exists: true, $nin: [null, ''] }
      },
      { projection: { _id: 0, linkedWorkId: 1 } }
    )
    .toArray();

  const [sourceRows, projectRows] = await Promise.all([sourceRowsPromise, projectRowsPromise]);
  const ids = new Set();
  for (const row of sourceRows) {
    if (isValidWorkId(row?.workId)) ids.add(String(row.workId).trim());
  }
  for (const row of projectRows) {
    if (isValidWorkId(row?.linkedWorkId)) ids.add(String(row.linkedWorkId).trim());
  }
  return Array.from(ids).sort((a, b) => Number(a) - Number(b));
}

async function collectAllWorkIds(db) {
  const rows = await db
    .collection('works')
    .find({}, { projection: { _id: 0, workId: 1 } })
    .toArray();
  const ids = rows.map((row) => String(row.workId || '').trim()).filter(isValidWorkId);
  return Array.from(new Set(ids)).sort((a, b) => Number(a) - Number(b));
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.allWorks && args.projectIds.length === 0) {
    throw new Error('Provide --projectId <id[,id2]> or use --allWorks');
  }

  const mongoUri = resolveMongoUri();
  const apiBase = normalizeApiBase(args.apiBase);
  const delayMs = Number.isFinite(args.delayMs) ? Math.max(0, args.delayMs) : 150;
  const limit = Number.isFinite(args.limit) ? Math.max(0, args.limit) : 0;

  console.log('IMSLP backfill start');
  console.log(`- mongo: ${mongoUri}`);
  console.log(`- apiBase: ${apiBase}`);
  console.log(`- mode: ${args.allWorks ? 'allWorks' : `projects(${args.projectIds.join(',')})`}`);
  console.log(`- refreshExisting: ${args.refreshExisting}`);
  console.log(`- dryRun: ${args.dryRun}`);

  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;

  let workIds = args.allWorks
    ? await collectAllWorkIds(db)
    : await collectWorkIdsForProjects(db, args.projectIds);

  if (limit > 0) {
    workIds = workIds.slice(0, limit);
  }

  const existingRows = await db
    .collection('imslp')
    .find({ workId: { $in: workIds } }, { projection: { _id: 0, workId: 1 } })
    .toArray();
  const existingSet = new Set(existingRows.map((row) => String(row.workId)));

  const targets = args.refreshExisting
    ? workIds
    : workIds.filter((workId) => !existingSet.has(workId));

  console.log(`- candidate workIds: ${workIds.length}`);
  console.log(`- already cached: ${existingSet.size}`);
  console.log(`- to refresh: ${targets.length}`);

  const stats = {
    attempted: 0,
    success: 0,
    failed: 0,
    skippedExisting: workIds.length - targets.length
  };
  const failures = [];

  for (let i = 0; i < targets.length; i += 1) {
    const workId = targets[i];
    const url = `${apiBase}/imslp/works/${encodeURIComponent(workId)}/refresh`;
    stats.attempted += 1;

    if (args.dryRun) {
      stats.success += 1;
      if ((i + 1) % 25 === 0 || i + 1 === targets.length) {
        console.log(`dry-run progress: ${i + 1}/${targets.length}`);
      }
      continue;
    }

    try {
      await requestJson(url, { method: 'POST' }, 120_000);
      stats.success += 1;
    } catch (error) {
      stats.failed += 1;
      failures.push({
        workId,
        error: error?.message || String(error)
      });
      console.error(`refresh failed for work ${workId}: ${error?.message || error}`);
    }

    if ((i + 1) % 25 === 0 || i + 1 === targets.length) {
      console.log(`progress: ${i + 1}/${targets.length}`);
    }
    await sleep(delayMs);
  }

  console.log('IMSLP backfill complete');
  console.log(`- attempted: ${stats.attempted}`);
  console.log(`- success: ${stats.success}`);
  console.log(`- failed: ${stats.failed}`);
  console.log(`- skippedExisting: ${stats.skippedExisting}`);

  if (failures.length > 0) {
    console.log('Failures:');
    for (const failure of failures.slice(0, 50)) {
      console.log(`  - ${failure.workId}: ${failure.error}`);
    }
    if (failures.length > 50) {
      console.log(`  ... and ${failures.length - 50} more`);
    }
    throw new Error(`Backfill finished with ${failures.length} failures`);
  }
}

run()
  .then(async () => {
    try {
      await mongoose.connection.close();
    } catch {
      // ignore
    }
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(`backfill-imslp-cache failed: ${error?.message || error}`);
    try {
      await mongoose.connection.close();
    } catch {
      // ignore
    }
    process.exit(1);
  });

