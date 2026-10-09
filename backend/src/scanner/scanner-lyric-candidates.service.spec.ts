import { ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sharp = require('sharp');
import { ScannerService } from './scanner.service';

const values: Record<string, string> = { SCANNER_ENABLED: 'true', SCANNER_BETA_USER_IDS: 'user-1' };
const config = { get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback) } as any;

async function setup(artifact: object | Buffer, mutateRaster?: (raster: any) => void) {
  const png = await sharp({
    create: { width: 400, height: 300, channels: 3, background: '#ffffff' }
  })
    .png()
    .toBuffer();
  const objects: Record<string, Buffer> = {
    raster: png,
    musicxml: Buffer.from(
      '<score-partwise><part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list><part id="P1"><measure number="1"><note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration></note></measure></part></score-partwise>'
    ),
    fusion: Buffer.isBuffer(artifact) ? artifact : Buffer.from(JSON.stringify(artifact))
  };
  const storage = {
    getObjectBuffer: jest.fn(async (_b: string, key: string) => objects[key])
  } as any;
  const raster: any = {
    checksumSha256: createHash('sha256').update(png).digest('hex'),
    width: 400,
    height: 300,
    storage: { bucket: 'b', objectKey: 'raster' }
  };
  mutateRaster?.(raster);
  const service = new ScannerService(
    {} as any,
    {} as any,
    storage,
    {} as any,
    {} as any,
    {} as any,
    config
  );
  jest.spyOn(service as any, 'ownedJob').mockResolvedValue({
    pages: [
      {
        pageNumber: 1,
        recognitionRaster: raster,
        engines: {
          'ots-homr': {
            artifacts: {
              'text-fusion-review': { bucket: 'b', objectKey: 'fusion' },
              musicXml: { bucket: 'b', objectKey: 'musicxml' }
            }
          }
        }
      }
    ]
  });
  return service;
}

const artifact = {
  textPolicy: { mode: 'fusion-v1' },
  fusedRegions: [
    {
      status: 'accepted',
      reason: 'independent',
      candidates: [
        {
          id: 'c1',
          label: 'Lyrics',
          box: [20, 100, 220, 140],
          rawConfidence: 0.9,
          calibratedConfidence: 0.8
        }
      ]
    }
  ]
};

describe('ScannerService lyric candidates', () => {
  afterEach(() => {
    delete process.env.SCANNER_OTS_HOMR_LYRIC_REVIEW_ENABLED;
  });

  it('is not available unless explicitly enabled', async () => {
    const service = await setup(artifact);
    await expect(service.pageLyricCandidates('user-1', 'job', 1)).rejects.toThrow(
      NotFoundException
    );
  });

  it('returns the inventory and a crop with the stored raster pixels', async () => {
    process.env.SCANNER_OTS_HOMR_LYRIC_REVIEW_ENABLED = '1';
    const service = await setup(artifact);
    const inventory = await service.pageLyricCandidates('user-1', 'job', 1);
    expect(inventory.candidates.map((c) => c.id)).toEqual(['c1']);
    expect(inventory.automaticAttachment).toBe(false);
    const crop = await service.pageLyricCandidateCrop('user-1', 'job', 1, 'c1');
    expect(crop.contentType).toBe('image/png');
    expect(await sharp(crop.body).metadata()).toMatchObject({ width: 244, height: 88 });
    await expect(service.pageLyricCandidateCrop('user-1', 'job', 1, 'nope')).rejects.toThrow(
      NotFoundException
    );
  });

  it('returns note choices and downloads only a hash-bound explicitly confirmed copy', async () => {
    process.env.SCANNER_OTS_HOMR_LYRIC_REVIEW_ENABLED = '1';
    const service = await setup(artifact);
    const notes = await service.pageLyricNoteInventory('user-1', 'job', 1);
    const candidates = await service.pageLyricCandidates('user-1', 'job', 1);
    const request = {
      automaticAttachment: false,
      musicXmlSha256: notes.musicXmlSha256,
      rasterSha256: candidates.raster.checksumSha256,
      placements: [
        {
          id: 's1',
          candidateId: 'c1',
          noteId: notes.notes[0].id,
          text: 'fi',
          printedLine: 1,
          textConfirmed: true,
          lineConfirmed: true,
          noteConfirmed: true
        }
      ]
    };
    const copy = await service.pageReviewedLyricCopy('user-1', 'job', 1, request);
    expect(copy.toString()).toContain('<text>fi</text>');
    expect((await service.pageLyricNoteInventory('user-1', 'job', 1)).musicXmlSha256).toBe(
      notes.musicXmlSha256
    );
    await expect(
      service.pageReviewedLyricCopy('user-1', 'job', 1, { ...request, rasterSha256: 'stale' })
    ).rejects.toThrow(ConflictException);
    delete process.env.SCANNER_OTS_HOMR_LYRIC_REVIEW_ENABLED;
    await expect(service.pageReviewedLyricCopy('user-1', 'job', 1, request)).rejects.toThrow(
      NotFoundException
    );
  });

  it('refuses a raster that changed and an unreadable review', async () => {
    process.env.SCANNER_OTS_HOMR_LYRIC_REVIEW_ENABLED = '1';
    const changed = await setup(artifact, (r) => (r.checksumSha256 = 'stale'));
    await expect(changed.pageLyricCandidateCrop('user-1', 'job', 1, 'c1')).rejects.toThrow(
      ConflictException
    );
    const broken = await setup(Buffer.from('{not json'));
    await expect(broken.pageLyricCandidates('user-1', 'job', 1)).rejects.toThrow(ConflictException);
  });
});
