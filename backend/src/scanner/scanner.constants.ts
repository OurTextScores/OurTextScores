import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHash } from 'node:crypto';

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

export const SCANNER_UPLOAD_DIRECTORY = join(tmpdir(), 'ots-scanner-uploads');
