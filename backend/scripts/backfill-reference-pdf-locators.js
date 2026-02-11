#!/usr/bin/env node

/**
 * Backfill `sources.derivatives.referencePdf` from source revision history.
 *
 * Why:
 * - Some sources have `hasReferencePdf=true` but the current source-level
 *   derivative locator is missing.
 * - UI and derivative endpoints rely on a stable source-level summary.
 *
 * Behavior:
 * - Finds sources where either:
 *   1) `hasReferencePdf=true` and `derivatives.referencePdf` is missing, or
 *   2) `hasReferencePdf!=true` but at least one revision has referencePdf.
 * - For each source, finds newest revision with `derivatives.referencePdf`.
 * - Updates source:
 *   - `derivatives.referencePdf` = newest revision's locator
 *   - `hasReferencePdf` = true
 *
 * Usage:
 *   DRY_RUN=true  node backend/scripts/backfill-reference-pdf-locators.js
 *   DRY_RUN=false node backend/scripts/backfill-reference-pdf-locators.js
 *
 * Requires:
 *   - MONGO_URI in env
 */

/* eslint-disable no-console */

const mongoose = require('mongoose');

const DRY_RUN = String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false';
const REPAIR_FALSE_FLAGS = String(process.env.REPAIR_FALSE_FLAGS || 'false').toLowerCase() === 'true';
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('MONGO_URI is required');
  process.exit(1);
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const sources = db.collection('sources');
  const revisions = db.collection('source_revisions');

  const sourceQuery = REPAIR_FALSE_FLAGS
    ? {
        $or: [
          {
            hasReferencePdf: true,
            $or: [
              { 'derivatives.referencePdf': { $exists: false } },
              { 'derivatives.referencePdf': null }
            ]
          },
          {
            hasReferencePdf: { $ne: true }
          }
        ]
      }
    : {
        hasReferencePdf: true,
        $or: [
          { 'derivatives.referencePdf': { $exists: false } },
          { 'derivatives.referencePdf': null }
        ]
      };

  const cursor = sources.find(sourceQuery);
  const summary = {
    startedAt: nowIso(),
    dryRun: DRY_RUN,
    repairFalseFlags: REPAIR_FALSE_FLAGS,
    scanned: 0,
    candidates: 0,
    updated: 0,
    skippedNoRevisionReference: 0,
    skippedAlreadyCurrent: 0,
    errors: 0
  };

  while (await cursor.hasNext()) {
    const source = await cursor.next();
    summary.scanned += 1;

    const revisionWithRef = await revisions
      .find({
        workId: source.workId,
        sourceId: source.sourceId,
        'derivatives.referencePdf': { $exists: true }
      })
      .sort({ sequenceNumber: -1 })
      .limit(1)
      .next();

    if (!revisionWithRef || !revisionWithRef.derivatives || !revisionWithRef.derivatives.referencePdf) {
      summary.skippedNoRevisionReference += 1;
      continue;
    }

    summary.candidates += 1;
    const nextRef = revisionWithRef.derivatives.referencePdf;
    const currentRef = source?.derivatives?.referencePdf;
    const sameLocator =
      currentRef &&
      currentRef.bucket === nextRef.bucket &&
      currentRef.objectKey === nextRef.objectKey;

    if (sameLocator && source.hasReferencePdf === true) {
      summary.skippedAlreadyCurrent += 1;
      continue;
    }

    if (!DRY_RUN) {
      try {
        await sources.updateOne(
          { _id: source._id },
          {
            $set: {
              hasReferencePdf: true,
              'derivatives.referencePdf': nextRef
            }
          }
        );
      } catch (error) {
        summary.errors += 1;
        console.error(
          `[${nowIso()}] failed update`,
          JSON.stringify({ workId: source.workId, sourceId: source.sourceId, message: error?.message || String(error) })
        );
        continue;
      }
    }

    summary.updated += 1;
  }

  summary.finishedAt = nowIso();
  console.log(JSON.stringify(summary, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
