import { promises as fs } from 'node:fs';
import {
  materializeScannerAutoBeams,
  scannerMusicXmlNeedsBeamMaterialization
} from './scanner-beam-normalization';

const score = (notes: string) =>
  Buffer.from(
    `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>2</divisions></attributes>${notes}</measure></part></score-partwise>`
  );

describe('scanner beam normalization', () => {
  it('detects the mixed explicit/automatic MusicXML case', () => {
    const base = score('<note><rest/><duration>1</duration><type>eighth</type><beam number="1">begin</beam></note>');
    const automatic = score('<note><rest/><duration>1</duration><type>eighth</type></note>');
    expect(scannerMusicXmlNeedsBeamMaterialization(automatic, base)).toBe(true);
    expect(scannerMusicXmlNeedsBeamMaterialization(base, automatic)).toBe(false);
    expect(scannerMusicXmlNeedsBeamMaterialization(automatic, automatic)).toBe(false);
    expect(scannerMusicXmlNeedsBeamMaterialization(base, base)).toBe(false);
  });

  it('uses MuseScore output so the candidate keeps the beaming it rendered with', async () => {
    const input = score('<note><rest/><duration>1</duration><type>eighth</type></note>');
    const normalized = score('<note><rest/><duration>1</duration><type>eighth</type><beam number="1">begin</beam></note>');
    const museScoreOutput = Buffer.from(
      normalized
        .toString('utf8')
        .replace(
          '<score-partwise',
          '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd"><score-partwise'
        )
    );
    const run = jest.fn(async (_executable: string, _inputPath: string, outputPath: string) => {
      await fs.writeFile(outputPath, museScoreOutput);
    });

    const result = await materializeScannerAutoBeams(input, { executable: 'musescore-test', run });

    expect(run).toHaveBeenCalledWith('musescore-test', expect.stringContaining('input.musicxml'), expect.stringContaining('output.musicxml'));
    expect(result).toEqual({ musicXml: normalized, materialized: true });
  });
});
