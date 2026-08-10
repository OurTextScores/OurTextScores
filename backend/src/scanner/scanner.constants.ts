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

/**
 * The MusicXML that represents a page *now*.
 *
 * Reconciliation beats spot review beats raw recognition. One resolver, because
 * a page is downloaded, bundled, zipped, rendered and opened in the editor by
 * different code paths — and any of them reading `musicXml` directly hands back
 * work the reviewer has already superseded.
 */
export function effectivePageMusicXml(
  page: Pick<ScannerPageResult, 'musicXml' | 'reviewedMusicXml' | 'mergedMusicXml'> | undefined
): ScannerStorageLocator | undefined {
  return page?.mergedMusicXml || page?.reviewedMusicXml || page?.musicXml;
}

/** True when pre-review bundles, renders and manifests no longer describe a page. */
export function pageMusicXmlSuperseded(
  page: Pick<ScannerPageResult, 'reviewedMusicXml' | 'mergedMusicXml'> | undefined
): boolean {
  return Boolean(page?.mergedMusicXml || page?.reviewedMusicXml);
}
