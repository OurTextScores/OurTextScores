import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertValidMusicXml } from './scanner-musicxml';

const execFileAsync = promisify(execFile);
const BEAMABLE_NOTE_TYPE = /<type(?:\s[^>]*)?>\s*(?:eighth|16th|32nd|64th|128th|256th|512th|1024th)\s*<\/type>/i;
const MUSESCORE_MUSICXML_DOCTYPE =
  /<!DOCTYPE\s+score-(?:partwise|timewise)\s+(?:PUBLIC\s+(?:"[^"]*"|'[^']*')\s+(?:"[^"]*"|'[^']*')|SYSTEM\s+(?:"[^"]*"|'[^']*'))\s*>/i;

/**
 * MuseScore adds MusicXML's standard external DTD declaration on export.
 * Scanner input correctly refuses every DTD because it is untrusted, but this
 * document was just produced by our local MuseScore process and the declaration
 * is metadata, not score content. Remove only the narrow standard-shaped form;
 * an internal subset or entity declaration still reaches validation and fails.
 */
function scannerMuseScoreOutput(musicXml: Buffer): Buffer {
  const text = musicXml.toString('utf8');
  if (/<!ENTITY/i.test(text)) return musicXml;
  return Buffer.from(text.replace(MUSESCORE_MUSICXML_DOCTYPE, ''));
}

/**
 * MusicXML's missing-beam semantics depend on the rest of the document.
 *
 * MuseScore auto-beams a document with no explicit `<beam>` elements. Once
 * any explicit beam exists, however, a short note without one is imported as
 * deliberately unbeamed. That makes a beamless OMR measure change appearance
 * merely because it was copied into another engine's explicitly-beamed score.
 */
export function scannerMusicXmlNeedsBeamMaterialization(
  musicXml: Buffer,
  companionMusicXml: Buffer
): boolean {
  const target = musicXml.toString('utf8');
  const companion = companionMusicXml.toString('utf8');
  return !/<beam(?:\s|>)/i.test(target) && /<beam(?:\s|>)/i.test(companion) && BEAMABLE_NOTE_TYPE.test(target);
}

export type ScannerMuseScoreRunner = (
  executable: string,
  inputPath: string,
  outputPath: string
) => Promise<void>;

const defaultRunner: ScannerMuseScoreRunner = async (executable, inputPath, outputPath) => {
  await execFileAsync(executable, ['--export-to', outputPath, inputPath], {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      QT_QPA_PLATFORM: process.env.QT_QPA_PLATFORM || 'offscreen'
    }
  });
};

export async function materializeScannerAutoBeams(
  musicXml: Buffer,
  options: {
    executable?: string;
    run?: ScannerMuseScoreRunner;
  } = {}
): Promise<{ musicXml: Buffer; materialized: boolean }> {
  assertValidMusicXml(musicXml);
  const directory = await fs.mkdtemp(join(tmpdir(), 'ots-scanner-beams-'));
  const inputPath = join(directory, 'input.musicxml');
  const outputPath = join(directory, 'output.musicxml');
  try {
    await fs.writeFile(inputPath, musicXml);
    await (options.run || defaultRunner)(
      options.executable || process.env.MUSESCORE_CLI || 'musescore4',
      inputPath,
      outputPath
    );
    const normalized = scannerMuseScoreOutput(await fs.readFile(outputPath));
    assertValidMusicXml(normalized);
    return {
      musicXml: normalized,
      materialized: /<beam(?:\s|>)/i.test(normalized.toString('utf8'))
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
