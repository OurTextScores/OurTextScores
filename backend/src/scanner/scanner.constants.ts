import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SCANNER_UPLOAD_DIRECTORY = join(tmpdir(), 'ots-scanner-uploads');
