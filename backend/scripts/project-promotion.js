#!/usr/bin/env node
/**
 * Project promotion utility:
 * - export: package one project + linked sources/revisions/works/branches and required assets
 * - import: restore a package into another environment (e.g. prod) with collision checks
 * - verify: validate package integrity against the current environment
 *
 * Examples:
 *   node scripts/project-promotion.js export --projectId prj_123 --dir /tmp/prj_123_bundle
 *   node scripts/project-promotion.js import --dir /tmp/prj_123_bundle
 *   node scripts/project-promotion.js verify --dir /tmp/prj_123_bundle
 *
 * Notes:
 * - Requires environment variables for Mongo + MinIO + Fossil root path in both source and target environments.
 * - Default behavior is conservative: import fails on collisions.
 */

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const mongoose = require('mongoose');
const { Client } = require('minio');

function parseArgs(argv) {
  const out = {
    mode: '',
    projectId: '',
    dir: '',
    allowExistingProject: false,
    overwriteFossil: false,
    overwriteObjects: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === 'export' || token === 'import' || token === 'verify') {
      out.mode = token;
      continue;
    }
    if (token === '--projectId') {
      out.projectId = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (token === '--dir') {
      out.dir = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (token === '--allowExistingProject') {
      out.allowExistingProject = true;
      continue;
    }
    if (token === '--overwriteFossil') {
      out.overwriteFossil = true;
      continue;
    }
    if (token === '--overwriteObjects') {
      out.overwriteObjects = true;
      continue;
    }
  }

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

function resolveFossilRoot() {
  return process.env.FOSSIL_PATH || '/data/fossil_data';
}

function parseBoolean(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return fallback;
}

function createMinioClientFromEnv() {
  const url = process.env.MINIO_URL;
  let endPoint = process.env.MINIO_ENDPOINT || 'localhost';
  let port = Number.parseInt(process.env.MINIO_PORT || '9000', 10);
  let useSSL = parseBoolean(process.env.MINIO_USE_SSL, false);

  if (url) {
    try {
      const parsed = new URL(url);
      endPoint = parsed.hostname;
      port = parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;
      useSSL = parsed.protocol === 'https:';
    } catch (_err) {
      // fallback to explicit vars
    }
  }

  const accessKey = process.env.MINIO_ACCESS_KEY || '';
  const secretKey = process.env.MINIO_SECRET_KEY || '';
  if (!accessKey || !secretKey) {
    throw new Error('MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required');
  }

  return new Client({ endPoint, port, useSSL, accessKey, secretKey });
}

function ensureRelativeSafePath(fragment) {
  const normalized = fragment.replace(/\\/g, '/');
  if (normalized.includes('..')) {
    throw new Error(`Unsafe path segment: ${fragment}`);
  }
  return normalized;
}

function isStorageLocator(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    typeof value.bucket === 'string' &&
    typeof value.objectKey === 'string'
  );
}

function collectLocators(value, out) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectLocators(item, out);
    return;
  }
  if (isStorageLocator(value)) {
    out.push({ bucket: value.bucket, objectKey: value.objectKey });
  }
  for (const child of Object.values(value)) {
    collectLocators(child, out);
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readBundle(bundleDir) {
  const bundlePath = path.join(bundleDir, 'bundle.json');
  const raw = await fs.readFile(bundlePath, 'utf8');
  return JSON.parse(raw);
}

function uniqueByKey(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    map.set(keyFn(item), item);
  }
  return Array.from(map.values());
}

async function copyMinioObjectToFile(client, bucket, objectKey, destPath) {
  await ensureDir(path.dirname(destPath));
  const stream = await client.getObject(bucket, objectKey);
  const writeStream = fsSync.createWriteStream(destPath);
  await pipeline(stream, writeStream);
}

async function putFileToMinio(client, bucket, objectKey, sourcePath) {
  const stat = await fs.stat(sourcePath);
  const readStream = fsSync.createReadStream(sourcePath);
  await client.putObject(bucket, objectKey, readStream, stat.size);
}

async function minioObjectExists(client, bucket, objectKey) {
  try {
    await client.statObject(bucket, objectKey);
    return true;
  } catch {
    return false;
  }
}

async function copyFileIfExists(srcPath, destPath) {
  try {
    await fs.access(srcPath);
  } catch {
    return false;
  }
  await ensureDir(path.dirname(destPath));
  await fs.copyFile(srcPath, destPath);
  return true;
}

async function recomputeWorkStatsForWork(db, workId) {
  const sources = await db.collection('sources').find({ workId }).toArray();

  const sourceCount = sources.length;
  const availableFormats = Array.from(
    new Set(
      sources
        .map((s) => (typeof s.format === 'string' ? s.format : ''))
        .filter(Boolean)
    )
  );
  const hasReferencePdf = sources.some((s) => !!s.hasReferencePdf);
  const hasVerifiedSources = sources.some((s) => !!s.adminVerified);
  const hasFlaggedSources = sources.some((s) => !!s.adminFlagged);
  const latestRevisionAt = sources
    .map((s) => (s.latestRevisionAt ? new Date(s.latestRevisionAt) : null))
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0] || null;

  await db.collection('works').updateOne(
    { workId },
    {
      $set: {
        sourceCount,
        availableFormats,
        hasReferencePdf,
        hasVerifiedSources,
        hasFlaggedSources,
        latestRevisionAt
      }
    }
  );
}

async function runExport(args) {
  if (!args.projectId) throw new Error('--projectId is required for export');
  if (!args.dir) throw new Error('--dir is required for export');

  const bundleDir = path.resolve(args.dir);
  const minioDir = path.join(bundleDir, 'minio');
  const fossilDir = path.join(bundleDir, 'fossil');
  await ensureDir(minioDir);
  await ensureDir(fossilDir);

  const mongoUri = resolveMongoUri();
  const fossilRoot = resolveFossilRoot();
  const minio = createMinioClientFromEnv();

  console.log(`Export start: project=${args.projectId}`);
  console.log(`Mongo: ${mongoUri}`);
  console.log(`Bundle dir: ${bundleDir}`);
  console.log(`Fossil root: ${fossilRoot}`);

  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;

  const project = await db.collection('projects').findOne({ projectId: args.projectId });
  if (!project) {
    throw new Error(`Project not found: ${args.projectId}`);
  }

  const rows = await db.collection('project_source_rows').find({ projectId: args.projectId }).toArray();
  const linkedSources = await db.collection('sources').find({ projectIds: args.projectId }).toArray();

  const sourceIdSet = new Set(linkedSources.map((s) => s.sourceId));
  const revisions = sourceIdSet.size > 0
    ? await db.collection('source_revisions').find({ sourceId: { $in: Array.from(sourceIdSet) } }).toArray()
    : [];
  const branches = sourceIdSet.size > 0
    ? await db.collection('source_branches').find({ sourceId: { $in: Array.from(sourceIdSet) } }).toArray()
    : [];

  const workIdSet = new Set();
  for (const source of linkedSources) {
    if (source.workId) workIdSet.add(String(source.workId));
  }
  for (const row of rows) {
    if (row.linkedWorkId) workIdSet.add(String(row.linkedWorkId));
  }

  const works = workIdSet.size > 0
    ? await db.collection('works').find({ workId: { $in: Array.from(workIdSet) } }).toArray()
    : [];

  const locatorsRaw = [];
  collectLocators(linkedSources, locatorsRaw);
  collectLocators(revisions, locatorsRaw);
  const locators = uniqueByKey(
    locatorsRaw
      .filter((x) => x.bucket && x.objectKey)
      .map((x) => ({
        bucket: ensureRelativeSafePath(String(x.bucket)),
        objectKey: ensureRelativeSafePath(String(x.objectKey))
      })),
    (x) => `${x.bucket}:${x.objectKey}`
  );

  const fossilEntries = linkedSources.map((s) => ({
    workId: String(s.workId),
    sourceId: String(s.sourceId),
    relativePath: ensureRelativeSafePath(`${s.workId}/${s.sourceId}.fossil`)
  }));

  const missingObjects = [];
  for (const locator of locators) {
    const target = path.join(minioDir, locator.bucket, locator.objectKey);
    try {
      await copyMinioObjectToFile(minio, locator.bucket, locator.objectKey, target);
    } catch (error) {
      missingObjects.push({
        bucket: locator.bucket,
        objectKey: locator.objectKey,
        error: error?.message || String(error)
      });
    }
  }

  const missingFossil = [];
  for (const entry of fossilEntries) {
    const src = path.join(fossilRoot, entry.relativePath);
    const dst = path.join(fossilDir, entry.relativePath);
    const ok = await copyFileIfExists(src, dst);
    if (!ok) {
      missingFossil.push({
        workId: entry.workId,
        sourceId: entry.sourceId,
        relativePath: entry.relativePath
      });
    }
  }

  const bundle = {
    bundleVersion: 1,
    exportedAt: new Date().toISOString(),
    projectId: args.projectId,
    environment: {
      mongoUri,
      fossilRoot
    },
    docs: {
      project,
      projectSourceRows: rows,
      works,
      sources: linkedSources,
      sourceRevisions: revisions,
      sourceBranches: branches
    },
    assets: {
      minioObjects: locators,
      fossilRepositories: fossilEntries,
      missingObjects,
      missingFossil
    }
  };

  await fs.writeFile(path.join(bundleDir, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

  console.log('Export complete');
  console.log(`- project_source_rows: ${rows.length}`);
  console.log(`- sources: ${linkedSources.length}`);
  console.log(`- source_revisions: ${revisions.length}`);
  console.log(`- source_branches: ${branches.length}`);
  console.log(`- works: ${works.length}`);
  console.log(`- minio objects requested: ${locators.length}`);
  console.log(`- minio objects missing: ${missingObjects.length}`);
  console.log(`- fossil repos requested: ${fossilEntries.length}`);
  console.log(`- fossil repos missing: ${missingFossil.length}`);
}

async function checkImportCollisions(db, bundle, allowExistingProject) {
  const collisions = [];
  const projectId = bundle.docs?.project?.projectId;
  if (!projectId) throw new Error('Bundle is missing docs.project.projectId');

  const projectExists = await db.collection('projects').findOne({ projectId }, { projection: { _id: 1 } });
  if (projectExists && !allowExistingProject) {
    collisions.push(`Project already exists: ${projectId}`);
  }

  const sourceIds = (bundle.docs?.sources || []).map((s) => s.sourceId).filter(Boolean);
  if (sourceIds.length > 0) {
    const existingSources = await db
      .collection('sources')
      .find({ sourceId: { $in: sourceIds } }, { projection: { sourceId: 1, _id: 0 } })
      .toArray();
    for (const s of existingSources) {
      collisions.push(`Source already exists: ${s.sourceId}`);
    }
  }

  const revisionIds = (bundle.docs?.sourceRevisions || []).map((r) => r.revisionId).filter(Boolean);
  if (revisionIds.length > 0) {
    const existingRevisions = await db
      .collection('source_revisions')
      .find({ revisionId: { $in: revisionIds } }, { projection: { revisionId: 1, _id: 0 } })
      .toArray();
    for (const r of existingRevisions) {
      collisions.push(`Revision already exists: ${r.revisionId}`);
    }
  }

  const rows = bundle.docs?.projectSourceRows || [];
  if (rows.length > 0) {
    const or = rows.map((r) => ({ projectId: r.projectId, rowId: r.rowId }));
    const existingRows = await db
      .collection('project_source_rows')
      .find({ $or: or }, { projection: { projectId: 1, rowId: 1, _id: 0 } })
      .toArray();
    for (const r of existingRows) {
      collisions.push(`Project row already exists: ${r.projectId}/${r.rowId}`);
    }
  }

  const branches = bundle.docs?.sourceBranches || [];
  if (branches.length > 0) {
    const or = branches.map((b) => ({ workId: b.workId, sourceId: b.sourceId, name: b.name }));
    const existingBranches = await db
      .collection('source_branches')
      .find({ $or: or }, { projection: { workId: 1, sourceId: 1, name: 1, _id: 0 } })
      .toArray();
    for (const b of existingBranches) {
      collisions.push(`Branch already exists: ${b.workId}/${b.sourceId}/${b.name}`);
    }
  }

  return collisions;
}

async function importMinioAssets(client, bundleDir, bundle, overwriteObjects) {
  const objectList = bundle.assets?.minioObjects || [];
  const uploaded = [];
  const skipped = [];
  const missingLocal = [];

  for (const item of objectList) {
    const rel = path.join('minio', item.bucket, item.objectKey);
    const localPath = path.join(bundleDir, rel);
    try {
      await fs.access(localPath);
    } catch {
      missingLocal.push({ bucket: item.bucket, objectKey: item.objectKey });
      continue;
    }

    const exists = await minioObjectExists(client, item.bucket, item.objectKey);
    if (exists && !overwriteObjects) {
      skipped.push({ bucket: item.bucket, objectKey: item.objectKey, reason: 'already_exists' });
      continue;
    }
    await putFileToMinio(client, item.bucket, item.objectKey, localPath);
    uploaded.push({ bucket: item.bucket, objectKey: item.objectKey });
  }

  return { uploaded, skipped, missingLocal };
}

async function importFossilAssets(bundleDir, bundle, fossilRoot, overwriteFossil) {
  const fossilList = bundle.assets?.fossilRepositories || [];
  const copied = [];
  const skipped = [];
  const missingLocal = [];

  for (const item of fossilList) {
    const rel = ensureRelativeSafePath(item.relativePath);
    const src = path.join(bundleDir, 'fossil', rel);
    const dst = path.join(fossilRoot, rel);

    try {
      await fs.access(src);
    } catch {
      missingLocal.push({ relativePath: rel });
      continue;
    }

    const exists = await fs.access(dst).then(() => true).catch(() => false);
    if (exists && !overwriteFossil) {
      skipped.push({ relativePath: rel, reason: 'already_exists' });
      continue;
    }

    await ensureDir(path.dirname(dst));
    await fs.copyFile(src, dst);
    copied.push({ relativePath: rel });
  }

  return { copied, skipped, missingLocal };
}

async function runImport(args) {
  if (!args.dir) throw new Error('--dir is required for import');
  const bundleDir = path.resolve(args.dir);
  const bundle = await readBundle(bundleDir);

  const mongoUri = resolveMongoUri();
  const fossilRoot = resolveFossilRoot();
  const minio = createMinioClientFromEnv();

  console.log(`Import start: bundle=${bundleDir}`);
  console.log(`Mongo: ${mongoUri}`);
  console.log(`Fossil root: ${fossilRoot}`);

  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;

  const collisions = await checkImportCollisions(db, bundle, args.allowExistingProject);
  if (collisions.length > 0) {
    console.error('Collision check failed:');
    for (const c of collisions) console.error(`- ${c}`);
    throw new Error(`Import aborted: ${collisions.length} collisions`);
  }

  const minioResult = await importMinioAssets(minio, bundleDir, bundle, args.overwriteObjects);
  const fossilResult = await importFossilAssets(bundleDir, bundle, fossilRoot, args.overwriteFossil);
  if (minioResult.missingLocal.length > 0) {
    throw new Error(
      `Import aborted: ${minioResult.missingLocal.length} MinIO files are missing from bundle directory`
    );
  }

  const docs = bundle.docs || {};
  const project = docs.project;
  const rows = docs.projectSourceRows || [];
  const works = docs.works || [];
  const sources = docs.sources || [];
  const revisions = docs.sourceRevisions || [];
  const branches = docs.sourceBranches || [];

  if (!project?.projectId) {
    throw new Error('Bundle missing project doc');
  }

  if (!args.allowExistingProject) {
    await db.collection('projects').insertOne(project);
  } else {
    await db.collection('projects').updateOne(
      { projectId: project.projectId },
      { $setOnInsert: project },
      { upsert: true }
    );
  }

  if (rows.length > 0) await db.collection('project_source_rows').insertMany(rows, { ordered: true });
  if (sources.length > 0) await db.collection('sources').insertMany(sources, { ordered: true });
  if (revisions.length > 0) await db.collection('source_revisions').insertMany(revisions, { ordered: true });
  if (branches.length > 0) await db.collection('source_branches').insertMany(branches, { ordered: true });

  for (const work of works) {
    await db.collection('works').updateOne(
      { workId: work.workId },
      { $setOnInsert: work },
      { upsert: true }
    );
  }

  const sourceIds = sources.map((s) => s.sourceId).filter(Boolean);
  if (sourceIds.length > 0) {
    await db.collection('sources').updateMany(
      { sourceId: { $in: sourceIds } },
      [
        {
          $set: {
            projectLinkCount: { $size: { $ifNull: ['$projectIds', []] } }
          }
        }
      ]
    );
  }

  const projectId = project.projectId;
  const [rowCount, linkedSourceCount] = await Promise.all([
    db.collection('project_source_rows').countDocuments({ projectId }),
    db.collection('sources').countDocuments({ projectIds: projectId })
  ]);
  await db.collection('projects').updateOne(
    { projectId },
    { $set: { rowCount, linkedSourceCount, updatedAt: new Date() } }
  );

  const workIds = Array.from(new Set(sources.map((s) => s.workId).filter(Boolean)));
  for (const workId of workIds) {
    await recomputeWorkStatsForWork(db, workId);
  }

  console.log('Import complete');
  console.log(`- project: ${projectId}`);
  console.log(`- inserted rows: ${rows.length}`);
  console.log(`- inserted sources: ${sources.length}`);
  console.log(`- inserted revisions: ${revisions.length}`);
  console.log(`- inserted branches: ${branches.length}`);
  console.log(`- works upserted (setOnInsert): ${works.length}`);
  console.log(`- minio uploaded: ${minioResult.uploaded.length}`);
  console.log(`- minio skipped: ${minioResult.skipped.length}`);
  console.log(`- minio missing local files: ${minioResult.missingLocal.length}`);
  console.log(`- fossil copied: ${fossilResult.copied.length}`);
  console.log(`- fossil skipped: ${fossilResult.skipped.length}`);
  console.log(`- fossil missing local files: ${fossilResult.missingLocal.length}`);
}

async function runVerify(args) {
  if (!args.dir) throw new Error('--dir is required for verify');
  const bundleDir = path.resolve(args.dir);
  const bundle = await readBundle(bundleDir);

  const mongoUri = resolveMongoUri();
  const fossilRoot = resolveFossilRoot();
  const minio = createMinioClientFromEnv();

  console.log(`Verify start: bundle=${bundleDir}`);
  console.log(`Mongo: ${mongoUri}`);
  console.log(`Fossil root: ${fossilRoot}`);

  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;

  const docs = bundle.docs || {};
  const project = docs.project;
  const rows = docs.projectSourceRows || [];
  const sources = docs.sources || [];
  const revisions = docs.sourceRevisions || [];
  const branches = docs.sourceBranches || [];

  if (!project?.projectId) throw new Error('Bundle missing project doc');

  const checks = {
    project: false,
    rowsFound: 0,
    sourcesFound: 0,
    revisionsFound: 0,
    branchesFound: 0,
    minioFound: 0,
    minioMissing: 0,
    fossilFound: 0,
    fossilMissing: 0
  };

  checks.project = !!(await db.collection('projects').findOne({ projectId: project.projectId }, { projection: { _id: 1 } }));

  for (const row of rows) {
    const found = await db.collection('project_source_rows').findOne(
      { projectId: row.projectId, rowId: row.rowId },
      { projection: { _id: 1 } }
    );
    if (found) checks.rowsFound += 1;
  }

  for (const source of sources) {
    const found = await db.collection('sources').findOne({ sourceId: source.sourceId }, { projection: { _id: 1 } });
    if (found) checks.sourcesFound += 1;
  }

  for (const rev of revisions) {
    const found = await db.collection('source_revisions').findOne({ revisionId: rev.revisionId }, { projection: { _id: 1 } });
    if (found) checks.revisionsFound += 1;
  }

  for (const b of branches) {
    const found = await db.collection('source_branches').findOne(
      { workId: b.workId, sourceId: b.sourceId, name: b.name },
      { projection: { _id: 1 } }
    );
    if (found) checks.branchesFound += 1;
  }

  const objectList = bundle.assets?.minioObjects || [];
  for (const item of objectList) {
    const exists = await minioObjectExists(minio, item.bucket, item.objectKey);
    if (exists) checks.minioFound += 1;
    else checks.minioMissing += 1;
  }

  const fossilList = bundle.assets?.fossilRepositories || [];
  for (const item of fossilList) {
    const rel = ensureRelativeSafePath(item.relativePath);
    const dst = path.join(fossilRoot, rel);
    const exists = await fs.access(dst).then(() => true).catch(() => false);
    if (exists) checks.fossilFound += 1;
    else checks.fossilMissing += 1;
  }

  console.log('Verify result');
  console.log(`- project found: ${checks.project}`);
  console.log(`- rows found: ${checks.rowsFound}/${rows.length}`);
  console.log(`- sources found: ${checks.sourcesFound}/${sources.length}`);
  console.log(`- revisions found: ${checks.revisionsFound}/${revisions.length}`);
  console.log(`- branches found: ${checks.branchesFound}/${branches.length}`);
  console.log(`- minio objects found: ${checks.minioFound}/${objectList.length}`);
  console.log(`- minio objects missing: ${checks.minioMissing}`);
  console.log(`- fossil repos found: ${checks.fossilFound}/${fossilList.length}`);
  console.log(`- fossil repos missing: ${checks.fossilMissing}`);

  const ok =
    checks.project &&
    checks.rowsFound === rows.length &&
    checks.sourcesFound === sources.length &&
    checks.revisionsFound === revisions.length &&
    checks.branchesFound === branches.length &&
    checks.minioMissing === 0 &&
    checks.fossilMissing === 0;

  if (!ok) {
    throw new Error('Verification failed. See counts above.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode) {
    throw new Error('Missing mode. Use one of: export | import | verify');
  }

  if (args.mode === 'export') {
    await runExport(args);
  } else if (args.mode === 'import') {
    await runImport(args);
  } else if (args.mode === 'verify') {
    await runVerify(args);
  } else {
    throw new Error(`Unsupported mode: ${args.mode}`);
  }
}

main()
  .then(async () => {
    try {
      await mongoose.connection.close();
    } catch {
      // ignore
    }
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('project-promotion failed:', error?.message || error);
    try {
      await mongoose.connection.close();
    } catch {
      // ignore
    }
    process.exit(1);
  });
