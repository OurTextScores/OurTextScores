import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    | Pick<ScannerPageResult, 'musicXml' | 'reviewedMusicXml' | 'mergedMusicXml' | 'engines'>
    | undefined,
  enginePlan?: { primaryEngineId: string; fallbackEngineIds: string[] }
): ScannerStorageLocator | undefined {
  return effectivePageMusicXmlSelection(page, enginePlan)?.musicXml;
}

/** Resolve the artifact and, for raw recognition output, the engine that supplied it. */
export function effectivePageMusicXmlSelection(
  page:
    | Pick<ScannerPageResult, 'musicXml' | 'reviewedMusicXml' | 'mergedMusicXml' | 'engines'>
    | undefined,
  enginePlan?: { primaryEngineId: string; fallbackEngineIds: string[] }
): EffectivePageMusicXmlSelection | undefined {
  if (!page) return undefined;
  if (page.mergedMusicXml) return { musicXml: page.mergedMusicXml };

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
  page: Pick<ScannerPageResult, 'reviewedMusicXml' | 'mergedMusicXml' | 'engines'> | undefined
): boolean {
  return Boolean(
    page?.mergedMusicXml ||
      page?.reviewedMusicXml ||
      Object.values(page?.engines || {}).some(
        (run) => run?.status === 'succeeded' && run.reviewedMusicXml
      )
  );
}
