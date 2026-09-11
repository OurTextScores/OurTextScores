import { BadRequestException } from '@nestjs/common';

import { ScannerService } from './scanner.service';

/**
 * `setFindingDisposition` is where everything built for Phase 6 meets: the record, the
 * profile revisions, and the job. The unit tests underneath it all pass on their own, so
 * what is left to get wrong is the wiring -- specifically the order of it.
 *
 * A rejected amendment must leave no decision behind. Storing "profile-amended" and then
 * failing to amend would leave the finding recurring on every later page with a record
 * claiming it had been answered, which is exactly the failure the removed Dismiss and
 * Expected buttons had.
 */
const QUARTET = {
  schemaVersion: 'homr.score-profile.v1',
  parts: [
    { stableId: 'viola', displayName: 'Viola', likelyClefs: ['C3', 'G2'] },
    { stableId: 'cello', displayName: 'Cello', likelyClefs: ['F4'] }
  ]
};

function jobDocument(withProfile = true) {
  return {
    jobId: 'job-1',
    userId: 'user-1',
    statusVersion: 1,
    status: 'succeeded',
    pages: [
      {
        pageNumber: 1,
        // `ownedJob` repairs a job whose page statuses disagree with its own, and that
        // repair path writes. Matching them keeps the fixture on the read path.
        status: 'succeeded',
        included: true,
        engines: {
          'ots-homr': {
            crossStaffFindings: [
              { kind: 'clef_profile_mismatch', system: 0, part: 'cello', message: 'x' },
              { kind: 'clef_profile_mismatch', system: 1, part: 'cello', message: 'x' },
              { kind: 'clef_profile_mismatch', system: 2, part: 'viola', message: 'x' },
              { kind: 'dangling_slur_start', system: 0, message: 'y' }
            ]
          }
        }
      }
    ],
    // The real plan shape from job cc2ce56d: `ownedJob` re-validates it on every read,
    // so a minimal stub is rejected before the method under test runs.
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
      engineOptions: {
        'ots-homr': {
          textDetector: 'none',
          ...(withProfile ? { scoreProfile: QUARTET } : {})
        }
      }
    },
    scoreProfileRevisions: undefined as unknown,
    markModified: jest.fn(),
    save: jest.fn(async () => undefined)
  };
}

function build(job: ReturnType<typeof jobDocument>, dispositions: unknown = undefined) {
  const jobs = {
    findOne: () => ({ exec: async () => job }),
    // `ownedJob` repairs a finished job whose derived status differs from its stored
    // one, and returns the repaired document. Returning the same fixture keeps the test
    // about the method under test rather than about the normaliser.
    findOneAndUpdate: () => ({ exec: async () => job })
  };
  const service = new ScannerService(
    jobs as never,
    {} as never,
    {} as never,
    {} as never,
    { userHash: () => 'telemetry-hash' } as never,
    {} as never,
    { get: (key: string) => (key === 'SCANNER_ENABLED' ? 'true' : key === 'SCANNER_BETA_USER_IDS' ? '*' : '') } as never,
    undefined,
    undefined,
    dispositions as never
  );
  return service;
}

function recorder() {
  const calls: unknown[] = [];
  return {
    calls,
    set: jest.fn(async (input: unknown) => {
      calls.push(input);
      return input;
    }),
    clear: jest.fn(async () => true),
    list: jest.fn(async () => [])
  };
}

describe('setFindingDisposition', () => {
  it('widens the profile for profile-amended, and stores the revision it produced', async () => {
    const job = jobDocument();
    const store = recorder();
    const result = await build(job, store).setFindingDisposition('user-1', 'job-1', {
      kind: 'clef_profile_mismatch',
      part: 'cello',
      disposition: 'profile-amended',
      amendment: { stableId: 'cello', addClefs: ['C4'] }
    });

    expect(result.profileRevision).toBe(2);
    const revisions = job.scoreProfileRevisions as Array<{ profile: typeof QUARTET }>;
    expect(revisions[1].profile.parts[1].likelyClefs).toEqual(['F4', 'C4']);
    // Revision 1 is still exactly what the user supplied.
    expect(revisions[0].profile.parts[1].likelyClefs).toEqual(['F4']);
    expect(job.save).toHaveBeenCalled();
    expect(store.calls[0]).toMatchObject({ profileRevision: 2, part: 'cello' });
  });

  it('records how many findings the decision covered', async () => {
    const job = jobDocument();
    const store = recorder();
    await build(job, store).setFindingDisposition('user-1', 'job-1', {
      kind: 'clef_profile_mismatch',
      part: 'cello',
      disposition: 'acknowledged'
    });
    // Two of the three clef findings name the cello.
    expect(store.calls[0]).toMatchObject({ findingCount: 2 });
  });

  it('counts every part when the decision is kind-wide', async () => {
    const job = jobDocument();
    const store = recorder();
    await build(job, store).setFindingDisposition('user-1', 'job-1', {
      kind: 'clef_profile_mismatch',
      disposition: 'acknowledged'
    });
    expect(store.calls[0]).toMatchObject({ findingCount: 3, part: null });
  });

  it('stores no decision when the amendment is refused', async () => {
    // The ordering that matters: a decision claiming an effect it did not have is the
    // exact failure this whole phase exists to remove.
    const job = jobDocument();
    const store = recorder();
    await expect(
      build(job, store).setFindingDisposition('user-1', 'job-1', {
        kind: 'clef_profile_mismatch',
        disposition: 'profile-amended',
        amendment: { stableId: 'oboe', addClefs: ['G2'] }
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.set).not.toHaveBeenCalled();
    expect(job.save).not.toHaveBeenCalled();
  });

  it('refuses "the profile is wrong" that does not say how', async () => {
    const job = jobDocument();
    const store = recorder();
    await expect(
      build(job, store).setFindingDisposition('user-1', 'job-1', {
        kind: 'clef_profile_mismatch',
        disposition: 'profile-amended'
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('refuses to amend a job that never had a profile', async () => {
    const job = jobDocument(false);
    const store = recorder();
    await expect(
      build(job, store).setFindingDisposition('user-1', 'job-1', {
        kind: 'clef_profile_mismatch',
        disposition: 'profile-amended',
        amendment: { stableId: 'cello', addClefs: ['C4'] }
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('rejects an unknown disposition rather than storing it', async () => {
    const job = jobDocument();
    const store = recorder();
    await expect(
      build(job, store).setFindingDisposition('user-1', 'job-1', {
        kind: 'clef_profile_mismatch',
        disposition: 'dismissed' as never
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('touches no profile for acknowledged or reading-flagged', async () => {
    for (const disposition of ['acknowledged', 'reading-flagged'] as const) {
      const job = jobDocument();
      const store = recorder();
      const result = await build(job, store).setFindingDisposition('user-1', 'job-1', {
        kind: 'clef_profile_mismatch',
        disposition
      });
      expect(result.profileRevision).toBeUndefined();
      expect(job.save).not.toHaveBeenCalled();
      expect(job.scoreProfileRevisions).toBeUndefined();
    }
  });

  it('works without the disposition store, recording nothing rather than failing', async () => {
    // The service is constructed without it in many existing tests.
    const job = jobDocument();
    await expect(
      build(job, undefined).setFindingDisposition('user-1', 'job-1', {
        kind: 'clef_profile_mismatch',
        disposition: 'acknowledged'
      })
    ).resolves.toMatchObject({ disposition: 'acknowledged' });
  });
});

describe('clearFindingDisposition', () => {
  it('withdraws the decision but leaves an applied amendment in place', async () => {
    // The widened profile already decoded later pages; narrowing it again would leave
    // them decoded against a prior the job no longer claims.
    const job = jobDocument();
    const store = recorder();
    const service = build(job, store);
    await service.setFindingDisposition('user-1', 'job-1', {
      kind: 'clef_profile_mismatch',
      part: 'cello',
      disposition: 'profile-amended',
      amendment: { stableId: 'cello', addClefs: ['C4'] }
    });
    const afterAmend = job.scoreProfileRevisions;

    expect(await service.clearFindingDisposition('user-1', 'job-1', 'clef_profile_mismatch', 'cello'))
      .toEqual({ cleared: true });
    expect(store.clear).toHaveBeenCalledWith('job-1', 'clef_profile_mismatch', 'cello');
    expect(job.scoreProfileRevisions).toBe(afterAmend);
  });
});
