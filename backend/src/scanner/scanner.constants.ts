import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scannerMergedScoreStale } from './scanner-dual-engine';
import type { ScannerPageResult, ScannerStorageLocator } from './schemas/scanner-job.schema';

/**
 * Design section 7.2: object keys carry a hashed owner segment, never the user
 * identifier itself. `SCANNER_OBJECT_KEY_SALT` turns this from obfuscation into
 * a real barrier — without it, a known user id still yields a guessable hash.
 *
 * Existing objects are always reached through the locator stored on the job, so
 * changing this affects new keys only and needs no migration.
 */
export function scannerUserHash(userId: string, salt = ''): string {
  return createHash('sha256').update(`${salt}:${userId}`).digest('hex').slice(0, 32);
}

/**
 * Where multipart uploads are staged before they reach object storage.
 *
 * Configurable so staging can be pointed at a dedicated volume. In Docker,
 * `tmpdir()` is the container's own `/tmp` on the writable layer — not the
 * host's — so it consumes the same disk as the image store and everything else
 * under `/var/lib/docker`. That is survivable but shared, and a deployment that
 * wants staging isolated (or on faster storage) sets `SCANNER_UPLOAD_DIR`.
 * The default keeps development and CI unchanged.
 */
export const SCANNER_UPLOAD_DIRECTORY =
  process.env.SCANNER_UPLOAD_DIR?.trim() || join(tmpdir(), 'ots-scanner-uploads');

/**
 * Ceiling for the whole multipart request, applied from `Content-Length` before
 * a single byte is written. `SCANNER_MAX_UPLOAD_BYTES` is checked in
 * `createJob`, which runs only after multer has already staged every file, so
 * on its own it bounds what is accepted but not what is written: 20 files at
 * the per-file limit is 500 MB staged per request, and concurrent requests
 * multiply that against shared disk. The slack covers multipart boundaries and
 * part headers.
 */
export const SCANNER_REQUEST_OVERHEAD_BYTES = 64 * 1024;

/**
 * Ceiling on a saved merged score.
 *
 * One page of MusicXML from either engine is a few hundred kilobytes at most;
 * this leaves generous room for a heavily edited orchestral page while keeping
 * a runaway client from writing an unbounded object under the reviewer's name.
 * Shared with the body parser in `main.ts` so the two cannot drift — a parser
 * limit below this one rejects with a 413 the service never sees.
 */
export const SCANNER_MAX_MERGED_SCORE_BYTES = 8 * 1024 * 1024;

export interface EffectivePageMusicXmlSelection {
  musicXml: ScannerStorageLocator;
  /** Engine owner for raw or reviewed output; absent only for reconciled output. */
  engineId?: string;
}

/**
 * The MusicXML that represents a page *now*.
 *
 * Reconciliation beats spot review beats raw recognition. One resolver, because
 * a page is downloaded, bundled, zipped, rendered and opened in the editor by
 * different code paths — and any of them reading `musicXml` directly hands back
 * work the reviewer has already superseded.
 */
export function effectivePageMusicXml(
  page:
    | Pick<
        ScannerPageResult,
        'musicXml' | 'reviewedMusicXml' | 'mergedMusicXml' | 'mergedScore' | 'engines'
      >
    | undefined,
  enginePlan?: { primaryEngineId: string; fallbackEngineIds: string[] }
): ScannerStorageLocator | undefined {
  return effectivePageMusicXmlSelection(page, enginePlan)?.musicXml;
}

/** Resolve the artifact and, for raw recognition output, the engine that supplied it. */
export function effectivePageMusicXmlSelection(
  page:
    | Pick<
        ScannerPageResult,
        'musicXml' | 'reviewedMusicXml' | 'mergedMusicXml' | 'mergedScore' | 'engines'
      >
    | undefined,
  enginePlan?: { primaryEngineId: string; fallbackEngineIds: string[] }
): EffectivePageMusicXmlSelection | undefined {
  if (!page) return undefined;
  // A stale merge is kept but not used. It survives a re-run because it is the
  // reviewer's own work (comparator design §3.1), and it stops being the page
  // in the same breath, because it answers readings that no longer exist —
  // assembling from it would graft old hand corrections onto a new recognition
  // without anyone deciding that was right. It becomes effective again the
  // moment the reviewer accepts it against the current readings.
  if (page.mergedMusicXml && !scannerMergedScoreStale(page)) {
    return { musicXml: page.mergedMusicXml };
  }

  const reviewedForEngine = (engineId: string): EffectivePageMusicXmlSelection | undefined => {
    const run = page.engines?.[engineId];
    if (run?.status === 'succeeded' && run.reviewedMusicXml) {
      return { musicXml: run.reviewedMusicXml, engineId };
    }
    if (engineId === 'homr' && page.reviewedMusicXml && (!run || run.status === 'succeeded')) {
      return { musicXml: page.reviewedMusicXml, engineId };
    }
    return undefined;
  };

  const artifactForEngine = (engineId: string): EffectivePageMusicXmlSelection | undefined => {
    const run = page.engines?.[engineId];
    if (engineId === 'homr' && page.musicXml && (!run || run.status === 'succeeded')) {
      return { musicXml: page.musicXml, engineId };
    }
    return run?.status === 'succeeded' && run.artifacts.musicXml
      ? { musicXml: run.artifacts.musicXml, engineId }
      : undefined;
  };
  if (enginePlan) {
    const engineIds = [enginePlan.primaryEngineId, ...enginePlan.fallbackEngineIds];
    for (const engineId of engineIds) {
      const reviewed = reviewedForEngine(engineId);
      if (reviewed) return reviewed;
    }
    for (const engineId of engineIds) {
      const artifact = artifactForEngine(engineId);
      if (artifact) return artifact;
    }
    return undefined;
  }

  // Legacy callers have no job plan. Preserve HOMR precedence, then use the
  // recorded engine insertion order (which new workers create in plan order).
  if (page.reviewedMusicXml && (!page.engines?.homr || page.engines.homr.status === 'succeeded')) {
    return { musicXml: page.reviewedMusicXml, engineId: 'homr' };
  }
  if (page.musicXml && (!page.engines?.homr || page.engines.homr.status === 'succeeded')) {
    return { musicXml: page.musicXml, engineId: 'homr' };
  }
  const homr = artifactForEngine('homr');
  if (homr) return homr;
  for (const engineId of Object.keys(page.engines || {})) {
    if (engineId === 'homr') continue;
    const artifact = artifactForEngine(engineId);
    if (artifact) return artifact;
  }
  return undefined;
}

/** True when pre-review bundles, renders and manifests no longer describe a page. */
export function pageMusicXmlSuperseded(
  page:
    | Pick<ScannerPageResult, 'reviewedMusicXml' | 'mergedMusicXml' | 'mergedScore' | 'engines'>
    | undefined
): boolean {
  return Boolean(
    (page?.mergedMusicXml && !scannerMergedScoreStale(page)) ||
      page?.reviewedMusicXml ||
      Object.values(page?.engines || {}).some(
        (run) => run?.status === 'succeeded' && run.reviewedMusicXml
      )
  );
}
