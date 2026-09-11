import { ScannerService } from './scanner.service';

/**
 * The findings review document. Its job is to be internally consistent: the findings and
 * the systems they point at have to come from one revision of one page, or a finding
 * addresses a system that no longer means what it meant.
 */
const STAVES = [
  { index: 0, systemIndex: 0, partIndex: 0, region: [50, 100, 950, 200] },
  { index: 1, systemIndex: 0, partIndex: 1, region: [50, 210, 950, 310] },
  { index: 2, systemIndex: 1, partIndex: 0, region: [50, 400, 950, 500] }
];

const FINDINGS = [
  { kind: 'clef_profile_mismatch', system: 0, part: 'cello', message: 'x' },
  { kind: 'dangling_slur_start', system: 1, message: 'y' }
];

function jobDocument(overrides: Record<string, unknown> = {}) {
  return {
    jobId: 'job-1',
    userId: 'user-1',
    statusVersion: 4,
    status: 'succeeded',
    pages: [
      {
        pageNumber: 1,
        status: 'succeeded',
        included: true,
        recognitionRaster: { storage: { checksumSha256: 'sha' }, width: 1000, height: 800 },
        engines: {
          'ots-homr': {
            status: 'succeeded',
            review: { staves: STAVES },
            crossStaffFindings: FINDINGS,
            artifacts: { musicXml: { checksumSha256: 'artifact-sha' } }
          }
        },
        ...(overrides.page as object)
      }
    ],
    enginePlan: {
      version: 'scanner-engine-plan-v1',
      engineIds: ['ots-homr'],
      primaryEngineId: 'ots-homr',
      fallbackEngineIds: [],
      capabilitySnapshots: {
        'ots-homr': {
          displayName: 'OTS-HOMR',
          outputArtifactKinds: ['musicxml'],
          supportsSpotReview: true,
          supportsMeasureGeometry: true,
          unsupportedSemanticClasses: []
        }
      },
      engineOptions: { 'ots-homr': { textDetector: 'none' } }
    },
    markModified: jest.fn(),
    save: jest.fn(async () => undefined)
  };
}

function build(job: ReturnType<typeof jobDocument>) {
  const jobs = {
    findOne: () => ({ exec: async () => job }),
    findOneAndUpdate: () => ({ exec: async () => job })
  };
  return new ScannerService(
    jobs as never,
    {} as never,
    {} as never,
    {} as never,
    { userHash: () => 'hash' } as never,
    {} as never,
    {
      get: (key: string) =>
        key === 'SCANNER_ENABLED' ? 'true' : key === 'SCANNER_BETA_USER_IDS' ? '*' : ''
    } as never
  );
}

describe('pageFindingsRegions', () => {
  it('carries the findings in the same document as the systems', async () => {
    // Two documents could disagree about statusVersion, and a finding pointing at a
    // system from another revision of the page points somewhere wrong.
    const doc = await build(jobDocument()).pageFindingsRegions('user-1', 'job-1', 1, 'ots-homr');
    expect(doc.findings).toEqual(FINDINGS);
    expect(doc.statusVersion).toBe(4);
  });

  it('derives systems from the engine’s own staff geometry', async () => {
    const doc = await build(jobDocument()).pageFindingsRegions('user-1', 'job-1', 1, 'ots-homr');
    expect(doc.systems.map((system: any) => system.systemIndex)).toEqual([0, 1]);
    expect(doc.systems[0].staffIndexes).toEqual([0, 1]);
  });

  it('every finding’s system resolves against the systems it ships with', async () => {
    // The property the whole document exists for.
    const doc = await build(jobDocument()).pageFindingsRegions('user-1', 'job-1', 1, 'ots-homr');
    const known = new Set(doc.systems.map((system: any) => system.systemIndex));
    for (const finding of doc.findings) {
      if (finding.system === undefined) continue;
      expect(known.has(finding.system)).toBe(true);
    }
  });

  it('has no right side, and pins the crop to this status version', async () => {
    const doc = await build(jobDocument()).pageFindingsRegions('user-1', 'job-1', 1, 'ots-homr');
    expect(doc.right).toBeUndefined();
    expect(doc.left).toMatchObject({ engineId: 'ots-homr', displayName: 'OTS-HOMR' });
    expect(doc.systems[0].cropUrl).toBe(
      'engines/ots-homr/systems/0/crop?statusVersion=4'
    );
  });

  it('ships no measure indexes, because no geometry manifest exists for one engine', async () => {
    const doc = await build(jobDocument()).pageFindingsRegions('user-1', 'job-1', 1, 'ots-homr');
    expect(doc.systems[0].leftMeasureIndexes).toEqual([]);
    expect(doc.systems[0].rightMeasureIndexes).toEqual([]);
  });

  it('refuses an engine that did not succeed', async () => {
    // A reading that failed has no staves to point at, and a document of empty systems
    // would look like a page with no music on it.
    const job = jobDocument({ page: { engines: { 'ots-homr': { status: 'failed' } } } });
    await expect(
      build(job).pageFindingsRegions('user-1', 'job-1', 1, 'ots-homr')
    ).rejects.toThrow();
  });

  it('refuses an unknown engine', async () => {
    await expect(
      build(jobDocument()).pageFindingsRegions('user-1', 'job-1', 1, 'not-an-engine')
    ).rejects.toThrow();
  });

  it('returns an empty findings list rather than omitting the field', async () => {
    // The embed reads `body.findings`; an absent field and an empty one must mean the
    // same thing to it.
    const job = jobDocument({
      page: {
        recognitionRaster: { storage: { checksumSha256: 'sha' }, width: 1000, height: 800 },
        engines: { 'ots-homr': { status: 'succeeded', review: { staves: STAVES } } }
      }
    });
    const doc = await build(job).pageFindingsRegions('user-1', 'job-1', 1, 'ots-homr');
    expect(doc.findings).toEqual([]);
  });
});
