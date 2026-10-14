import { createHash } from 'node:crypto';
import type { ScannerPageResult, ScannerStorageLocator } from './schemas/scanner-job.schema';
import {
  type ReviewSnapshot,
  REVIEW_STEPS,
  reviewSignature,
  snapshotArtifactLocators
} from './scanner-review-workflow';

type ReadCheckpoint = (locator: ScannerStorageLocator) => Promise<Buffer>;
type WriteCheckpoint = (body: Buffer) => Promise<ScannerStorageLocator>;
const SNAPSHOT_SCHEMA = 'scanner-review-snapshot-v1';

export async function loadReviewSnapshot(
  snapshot: ReviewSnapshot,
  read: ReadCheckpoint
): Promise<ReviewSnapshot> {
  if (!snapshot.checkpointStorage) return structuredClone(snapshot);
  const body = await read(snapshot.checkpointStorage);
  if (
    createHash('sha256').update(body).digest('hex') !== snapshot.checkpointStorage.checksumSha256
  ) {
    throw new Error('The saved review checkpoint failed its integrity check');
  }
  const decoded = JSON.parse(body.toString('utf8'));
  if (
    decoded.schema !== SNAPSHOT_SCHEMA ||
    !decoded.snapshot ||
    typeof decoded.snapshot !== 'object'
  ) {
    throw new Error('The saved review checkpoint has an invalid format');
  }
  return decoded.snapshot as ReviewSnapshot;
}

/** Hydrate only during a stage transition; ordinary reads and worker writes stay compact. */
export async function loadWorkflowCheckpoints(
  page: ScannerPageResult,
  read: ReadCheckpoint
): Promise<ScannerPageResult> {
  if (!page.reviewWorkflow) return page;
  const result = structuredClone(page);
  const cache = new Map<string, Promise<ReviewSnapshot>>();
  for (const step of REVIEW_STEPS) {
    const checkpoint = result.reviewWorkflow.steps[step];
    if (!checkpoint) continue;
    for (const key of ['snapshot', 'original', 'previous'] as const) {
      const saved = checkpoint[key];
      if (!saved) continue;
      const locator = saved.checkpointStorage;
      if (!locator) continue;
      const id = `${locator.bucket}/${locator.objectKey}`;
      if (!cache.has(id)) cache.set(id, loadReviewSnapshot(saved, read));
      checkpoint[key] = structuredClone(await cache.get(id));
    }
  }
  return result;
}

/** Also migrates checkpoints written by the initial inline-snapshot implementation. */
export async function storeWorkflowCheckpoints(
  pages: ScannerPageResult[],
  write: WriteCheckpoint,
  existing: ScannerPageResult[] = []
): Promise<ScannerPageResult[]> {
  const cache = new Map<string, ReviewSnapshot>();
  for (const page of existing) {
    for (const checkpoint of Object.values(page.reviewWorkflow?.steps || {})) {
      for (const saved of [checkpoint.snapshot, checkpoint.original, checkpoint.previous]) {
        if (saved?.checkpointStorage?.checksumSha256)
          cache.set(saved.checkpointStorage.checksumSha256, saved);
      }
    }
  }
  const result: ScannerPageResult[] = [];
  for (const page of pages) {
    if (!page.reviewWorkflow) {
      result.push(page);
      continue;
    }
    const compact = { ...page, reviewWorkflow: structuredClone(page.reviewWorkflow) };
    for (const step of REVIEW_STEPS) {
      const checkpoint = compact.reviewWorkflow.steps[step];
      if (!checkpoint) continue;
      for (const key of ['snapshot', 'original', 'previous'] as const) {
        const saved = checkpoint[key];
        if (!saved || saved.checkpointStorage) continue;
        const body = Buffer.from(JSON.stringify({ schema: SNAPSHOT_SCHEMA, snapshot: saved }));
        const hash = createHash('sha256').update(body).digest('hex');
        if (!cache.has(hash)) {
          cache.set(hash, {
            checkpointStorage: await write(body),
            checkpointSignature: reviewSignature(saved),
            checkpointMergeRevision: saved.mergedScore?.revision || 0,
            retainedArtifacts: snapshotArtifactLocators(saved)
          });
        }
        checkpoint[key] = cache.get(hash)!;
      }
    }
    result.push(compact);
  }
  return result;
}
