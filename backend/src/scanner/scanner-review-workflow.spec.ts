import { BSON } from 'mongodb';
import { loadReviewSnapshot } from './scanner-review-checkpoint-storage';
import { ScannerService } from './scanner.service';
import {
  scannerEnginePlan,
  scannerMergedScoreBasis,
  scannerEngineReviewContentSignature,
  scannerEngineArtifactLocators
} from './scanner-dual-engine';
import { effectivePageMusicXml } from './scanner.constants';
import {
  reviewSignature,
  reviewSnapshot,
  workflowState,
  workflowRetains,
  startReviewWorkflow
} from './scanner-review-workflow';

const locator = (name: string) => ({
  bucket: 'scores',
  objectKey: name,
  checksumSha256: name,
  sizeBytes: 1,
  contentType: 'application/xml'
});
function fixture() {
  const core = locator('core');
  const selected = locator('selected');
  const job: any = {
    _id: 'job',
    jobId: 'job-1',
    userId: 'user-1',
    status: 'succeeded',
    statusVersion: 1,
    pageCount: 1,
    generation: 1,
    originalFilename: 'page.png',
    enginePlan: scannerEnginePlan(['ots-homr', 'transcoda'], 'ots-homr', {
      'ots-homr': {
        displayName: 'OTS-HOMR',
        supportsSpotReview: true,
        supportsMeasureGeometry: true,
        outputArtifactKinds: ['musicxml'],
        unsupportedSemanticClasses: []
      }
    }),
    pages: [
      {
        pageNumber: 1,
        ordinal: 1,
        status: 'succeeded',
        included: true,
        attempts: 1,
        engines: {
          'ots-homr': {
            engine: 'ots-homr',
            status: 'succeeded',
            attempts: 1,
            idempotencyKey: 'ots',
            artifacts: { musicXml: core, 'structured-heads': locator('proposal') },
            outputCandidates: {
              core: { musicXml: core },
              'all-structured': { musicXml: selected }
            },
            availableStructuredHeadFamilies: ['beam'],
            selectedStructuredHeadFamilies: [],
            review: {
              staves: [
                {
                  index: 0,
                  tokens: [],
                  symbols: [
                    {
                      index: 0,
                      heads: {
                        pitch: {
                          chosen: 'C4',
                          confidence: 0.4,
                          alternatives: [{ value: 'D4', confidence: 0.39 }]
                        }
                      }
                    }
                  ]
                }
              ]
            }
          },
          transcoda: {
            engine: 'transcoda',
            status: 'succeeded',
            attempts: 1,
            idempotencyKey: 'transcoda',
            artifacts: { musicXml: locator('transcoda') }
          }
        }
      }
    ]
  };
  const writes: any[] = [];
  const model = {
    findOne: jest.fn(() => ({ exec: async () => job })),
    updateOne: jest.fn((filter: any, update: any) => ({
      exec: async () => {
        if (filter.statusVersion !== job.statusVersion) return { matchedCount: 0 };
        writes.push(update);
        Object.assign(job, update.$set);
        job.statusVersion += update.$inc?.statusVersion || 0;
        return { matchedCount: 1 };
      }
    }))
  };
  const config = {
    get: (key: string, fallback?: unknown) =>
      ({ SCANNER_ENABLED: 'true', SCANNER_BETA_USER_IDS: 'user-1' })[key] ?? fallback
  };
  const objects = new Map<string, Buffer>();
  const storage = {
    putAuxiliaryObject: jest.fn(async (objectKey: string, body: Buffer) => {
      objects.set(objectKey, body);
      return { bucket: 'scores', objectKey };
    }),
    getObjectBuffer: jest.fn(async (_bucket: string, objectKey: string) => {
      const body = objects.get(objectKey);
      if (!body) throw new Error('Missing checkpoint');
      return body;
    }),
    deleteObject: jest.fn(async (_bucket: string, objectKey: string) => {
      objects.delete(objectKey);
    })
  };
  const service = new ScannerService(
    model as any,
    {} as any,
    storage as any,
    {} as any,
    { emit: jest.fn() } as any,
    {} as any,
    config as any
  );
  const transition = (action: string, step?: string, extra = {}) =>
    service.transitionReviewWorkflow('user-1', 'job-1', 1, {
      action,
      step,
      statusVersion: job.statusVersion,
      ...extra
    });
  const snapshot = (step: string, kind = 'snapshot') =>
    loadReviewSnapshot(job.pages[0].reviewWorkflow.steps[step][kind], (locator) =>
      storage.getObjectBuffer(locator.bucket, locator.objectKey)
    );
  return { service, job, writes, transition, storage, objects, model, snapshot };
}

describe('guided scanner review', () => {
  it('skips each stage, retaining base answers and archiving merge work without accepting it', async () => {
    const { job, transition, snapshot } = fixture();
    await transition('start');
    job.pages[0].engines['ots-homr'].artifacts.musicXml = locator('corrected-base');
    await transition('skip');
    expect(workflowState(job.pages[0])?.steps.base).toMatchObject({ complete: true, skipped: true });
    expect(job.pages[0].reviewWorkflow.active).toBe('heads');
    job.pages[0].engines['ots-homr'].selectedStructuredHeadFamilies = ['beam'];
    job.pages[0].mergedMusicXml = locator('unfinished-heads');
    await transition('skip');
    expect(job.pages[0].reviewWorkflow.active).toBe('engines');
    expect(workflowState(job.pages[0])?.steps.heads).toMatchObject({ complete: true, skipped: true });
    expect(job.pages[0].engines['ots-homr'].selectedStructuredHeadFamilies).toEqual([]);
    expect(effectivePageMusicXml(job.pages[0], job.enginePlan)?.objectKey).toBe('corrected-base');
    expect((await snapshot('heads', 'previous')).mergedMusicXml.objectKey).toBe('unfinished-heads');
    job.pages[0].mergedMusicXml = locator('unfinished-engines');
    await transition('skip');
    expect(workflowState(job.pages[0])?.steps.engines).toMatchObject({ complete: true, skipped: true });
    expect(job.pages[0].mergedMusicXml).toBeUndefined();
    expect((await snapshot('engines', 'previous')).mergedMusicXml.objectKey).toBe('unfinished-engines');
    await transition('redo', 'base');
    expect(workflowState(job.pages[0])?.steps.base.skipped).toBe(false);
  });

  it('isolates all three stages, carries the heads result forward, and resumes each saved merge', async () => {
    const { job, transition } = fixture();
    await transition('start');
    expect(job.pages[0].reviewWorkflow.active).toBe('base');
    await expect(transition('open', 'engines')).rejects.toThrow(/previous/);
    // A corrected base is the input to step two.
    job.pages[0].engines['ots-homr'].artifacts.musicXml = locator('corrected-core');
    await transition('complete');
    expect(job.pages[0].reviewWorkflow.active).toBe('heads');
    expect(job.pages[0].engines['ots-homr'].artifacts.musicXml.objectKey).toBe('corrected-core');
    job.pages[0].mergedMusicXml = locator('heads-merge');
    job.pages[0].mergedScore = {
      sourceEngineId: 'ots-homr-core',
      basisSignature: scannerMergedScoreBasis(job.pages[0]),
      revision: 1,
      decisions: [{ blockIndex: 4 }]
    };
    await transition('complete');
    expect(job.pages[0].reviewWorkflow.active).toBe('engines');
    expect(job.pages[0].engines['ots-homr'].reviewedMusicXml.objectKey).toBe('heads-merge');
    expect(job.pages[0].mergedMusicXml).toBeUndefined();
    expect(effectivePageMusicXml(job.pages[0], job.enginePlan)?.objectKey).toBe('heads-merge');
    job.pages[0].mergedMusicXml = locator('engine-merge');
    job.pages[0].mergedScore = {
      sourceEngineId: 'ots-homr',
      basisSignature: scannerMergedScoreBasis(job.pages[0]),
      revision: 2,
      decisions: [{ blockIndex: 7 }]
    };
    await transition('complete');
    expect(workflowState(job.pages[0])?.steps.engines.complete).toBe(true);
    await transition('open', 'heads');
    expect(job.pages[0].mergedMusicXml.objectKey).toBe('heads-merge');
    expect(job.pages[0].mergedScore.decisions).toEqual([{ blockIndex: 4 }]);
    const resumedRevision = job.pages[0].mergedScore.revision;
    await transition('open', 'engines');
    expect(job.pages[0].mergedMusicXml.objectKey).toBe('engine-merge');
    expect(job.pages[0].mergedScore.decisions).toEqual([{ blockIndex: 7 }]);
    expect(job.pages[0].mergedScore.revision).toBeGreaterThan(resumedRevision);
    await transition('open', 'base');
    expect(job.pages[0].mergedMusicXml).toBeUndefined();
    expect(job.pages[0].engines['ots-homr'].artifacts.musicXml.objectKey).toBe('corrected-core');
    expect(workflowRetains(job.pages[0], locator('heads-merge'))).toBe(true);
    expect(workflowRetains(job.pages[0], locator('engine-merge'))).toBe(true);
    expect(scannerEngineArtifactLocators(job.pages[0]).map((item) => item.objectKey)).toContain(
      'engine-merge'
    );
  });

  it('marks downstream work stale after changing an earlier result and retains it when explicitly redone', async () => {
    const { job, transition, snapshot } = fixture();
    await transition('start');
    await transition('complete');
    job.pages[0].mergedMusicXml = locator('old-heads-work');
    await transition('complete');
    job.pages[0].mergedMusicXml = locator('old-engine-work');
    await transition('complete');
    await transition('open', 'base');
    job.pages[0].engines['ots-homr'].artifacts.musicXml = locator('new-base');
    expect(workflowState(job.pages[0])?.steps.base.complete).toBe(false);
    expect(workflowState(job.pages[0])?.steps.heads.stale).toBe(true);
    expect(workflowState(job.pages[0])?.steps.engines.available).toBe(false);
    await transition('complete');
    expect(job.pages[0].mergedMusicXml).toBeUndefined();
    expect((await snapshot('heads', 'previous')).mergedMusicXml.objectKey).toBe('old-heads-work');
    expect(workflowRetains(job.pages[0], locator('old-engine-work'))).toBe(true);
  });

  it('reports an unfinished correction separately from a stale question', async () => {
    const { service, job, transition } = fixture();
    await transition('start');
    job.pages[0].engines['ots-homr'].requestedStructuredHeadFamilies = [];
    await expect(service.applyCorrection('user-1', 'job-1', 1, 0, 'D4', 'ots-homr', 'old', 'base'))
      .rejects.toThrow('Your previous choice is still being processed');
  });

  it('persists skipped-question progress and rejects a position from an older recognition', async () => {
    const { service, job, transition } = fixture();
    await transition('start');
    const signature = scannerEngineReviewContentSignature(job.pages[0].engines['ots-homr']);
    await transition('progress', undefined, {
      engineId: 'ots-homr',
      position: 1,
      contentSignature: signature
    });
    const review = await service.pageReview('user-1', 'job-1', 1, 'ots-homr', 'base');
    expect(review.position).toBe(1);
    await expect(
      transition('progress', undefined, {
        engineId: 'ots-homr',
        position: 1,
        contentSignature: 'old'
      })
    ).rejects.toThrow(/changed/);
  });

  it('refuses a stale transition, pending materialization, and corrections from an old step', async () => {
    const { service, job, transition } = fixture();
    await expect(
      service.transitionReviewWorkflow('user-1', 'job-1', 1, { action: 'start', statusVersion: 0 })
    ).rejects.toThrow(/changed/);
    job.pages[0].engines['ots-homr'].requestedStructuredHeadFamilies = [];
    await expect(transition('start')).rejects.toThrow(/rebuilding/);
    delete job.pages[0].engines['ots-homr'].requestedStructuredHeadFamilies;
    await transition('start');
    await transition('complete');
    await expect(
      service.applyCorrection('user-1', 'job-1', 1, 0, 'D4', 'ots-homr', 'old')
    ).rejects.toThrow(/Reopen the base/);
    await expect(
      service.pageComparisonReading(
        'user-1',
        'job-1',
        1,
        'transcoda',
        job.statusVersion,
        'a'.repeat(64)
      )
    ).rejects.toThrow(/matching review step/);
  });

  it('can redo base recognition while retaining its last corrected result', async () => {
    const { job, transition, snapshot } = fixture();
    await transition('start');
    job.pages[0].engines['ots-homr'].artifacts.musicXml = locator('corrected');
    await transition('complete');
    await transition('redo', 'base');
    expect(job.pages[0].engines['ots-homr'].artifacts.musicXml.objectKey).toBe('core');
    expect(
      (await snapshot('base', 'previous')).engines['ots-homr'].artifacts.musicXml.objectKey
    ).toBe('corrected');
    expect(workflowState(job.pages[0])?.steps.base.complete).toBe(false);
  });

  it('rejects an old unsaved editor after leaving and reopening the same merge step', async () => {
    const { service, job, transition } = fixture();
    await transition('start');
    await transition('complete');
    const old = await service.pageMergedScore('user-1', 'job-1', 1);
    await transition('open', 'base');
    await transition('open', 'heads');
    await expect(
      service.saveMergedScore('user-1', 'job-1', 1, {
        sourceEngineId: 'ots-homr-core',
        revision: old.revision,
        basisSignature: scannerMergedScoreBasis(job.pages[0]),
        musicXml: ''
      })
    ).rejects.toThrow(/merged score changed/);
  });

  it('retries correction writes when only worker bookkeeping changed', async () => {
    const { service, job, model, transition } = fixture();
    await transition('start');
    const page = structuredClone(job.pages[0]);
    const run = structuredClone(page.engines['ots-homr']);
    run.corrections = [{ chosen: 'D4' }];
    model.updateOne.mockImplementationOnce(() => ({
      exec: async () => {
        job.statusVersion += 1;
        return { matchedCount: 0 };
      }
    }));
    await expect(
      (service as any).writeCorrectionAgainstCurrentPage('user-1', job, page, run)
    ).resolves.toMatchObject({ matchedCount: 1 });
    expect(job.pages[0].engines['ots-homr'].corrections).toEqual([{ chosen: 'D4' }]);
  });

  it('does not retry a correction over another reviewers changes', async () => {
    const { service, job, model, transition } = fixture();
    await transition('start');
    const page = structuredClone(job.pages[0]);
    const run = structuredClone(page.engines['ots-homr']);
    model.updateOne.mockImplementationOnce(() => ({
      exec: async () => {
        job.statusVersion += 1;
        job.pages[0].engines['ots-homr'].artifacts.musicXml = locator('other-reviewer');
        return { matchedCount: 0 };
      }
    }));
    await expect(
      (service as any).writeCorrectionAgainstCurrentPage('user-1', job, page, run)
    ).resolves.toMatchObject({ matchedCount: 0 });
    expect(job.pages[0].engines['ots-homr'].artifacts.musicXml.objectKey).toBe('other-reviewer');
  });

  it('preserves pre-workflow merges when initializing base review', async () => {
    const { job, transition, snapshot } = fixture();
    job.pages[0].mergedMusicXml = locator('legacy-work');
    job.pages[0].mergedScore = { sourceEngineId: 'transcoda', revision: 3 };
    await transition('start');
    expect(job.pages[0].mergedMusicXml).toBeUndefined();
    expect((await snapshot('engines')).mergedMusicXml.objectKey).toBe('legacy-work');
  });

  it('keeps a large scan below the BSON limit through checkpoints, redo, and reopen', async () => {
    const { job, transition, writes, storage } = fixture();
    const payload = 'x'.repeat(6 * 1024 * 1024);
    job.pages[0].engines['ots-homr'].review.staves[0].tokens = [[payload]];
    await transition('start');
    expect(storage.putAuxiliaryObject).toHaveBeenCalledTimes(1);
    const checkpoint = job.pages[0].reviewWorkflow.steps.base;
    expect(checkpoint.snapshot.engines).toBeUndefined();
    expect(checkpoint.original.checkpointStorage).toEqual(checkpoint.snapshot.checkpointStorage);
    expect(BSON.calculateObjectSize(job.pages[0].reviewWorkflow)).toBeLessThan(20_000);
    await transition('complete');
    await transition('complete');
    await transition('complete');
    await transition('open', 'base');
    await transition('redo', 'base');
    expect(job.pages[0].engines['ots-homr'].review.staves[0].tokens[0][0]).toBe(payload);
    expect(storage.putAuxiliaryObject).toHaveBeenCalledTimes(1);
    for (const update of writes) {
      expect(
        BSON.calculateObjectSize({ update: 'scanner_jobs', updates: [{ q: {}, u: update }] })
      ).toBeLessThan(8 * 1024 * 1024);
    }
  });

  it('migrates already-saved inline checkpoints while preserving their saved state', async () => {
    const { job, transition, snapshot } = fixture();
    job.pages[0] = startReviewWorkflow(job.pages[0]);
    const signature = scannerEngineReviewContentSignature(job.pages[0].engines['ots-homr']);
    await transition('progress', undefined, {
      engineId: 'ots-homr',
      position: 1,
      contentSignature: signature
    });
    expect(job.pages[0].reviewWorkflow.steps.base.snapshot.checkpointStorage).toBeDefined();
    expect(job.pages[0].reviewWorkflow.steps.base.positions['ots-homr'].position).toBe(1);
    expect((await snapshot('base')).engines['ots-homr'].review.staves[0].symbols).toHaveLength(1);
    expect(workflowState(job.pages[0])?.active).toBe('base');
  });

  it('leaves MongoDB unchanged when saving a checkpoint fails', async () => {
    const { transition, storage, writes, job } = fixture();
    storage.putAuxiliaryObject.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(transition('start')).rejects.toThrow('Storage unavailable');
    expect(writes).toHaveLength(0);
    expect(job.pages[0].reviewWorkflow).toBeUndefined();
  });

  it('retries a checkpoint save after a worker-only version update', async () => {
    const { transition, model, job, objects } = fixture();
    model.updateOne.mockImplementationOnce(() => ({
      exec: async () => {
        job.statusVersion += 1;
        return { matchedCount: 0 };
      }
    }));
    await expect(transition('start')).resolves.toMatchObject({
      pages: [{ reviewWorkflow: { active: 'base' } }]
    });
    expect(objects.size).toBe(1);
  });

  it('cleans up newly uploaded checkpoint blobs after a concurrent update rejects the write', async () => {
    const { transition, model, storage, objects, job } = fixture();
    model.updateOne.mockImplementationOnce(() => ({
      exec: async () => {
        job.pages = structuredClone(job.pages);
        job.pages[0].engines['ots-homr'].artifacts.musicXml = locator('other-reviewer-update');
        job.statusVersion += 1;
        return { matchedCount: 0 };
      }
    }));
    await expect(transition('start')).rejects.toThrow(/changed/);
    expect(storage.deleteObject).toHaveBeenCalled();
    expect(objects.size).toBe(0);
  });

  it('does not restore a damaged checkpoint over the current review', async () => {
    const { transition, storage, writes, job } = fixture();
    await transition('start');
    storage.getObjectBuffer.mockResolvedValueOnce(Buffer.from('damaged checkpoint'));
    await expect(transition('complete')).rejects.toThrow(/integrity check/);
    expect(writes).toHaveLength(1);
    expect(job.pages[0].reviewWorkflow.active).toBe('base');
  });

  it('does not invalidate completion when only derivative artifacts change', () => {
    const { job } = fixture();
    const signature = reviewSignature(reviewSnapshot(job.pages[0]));
    job.pages[0].engines['ots-homr'].artifacts.pdf = locator('new.pdf');
    expect(reviewSignature(reviewSnapshot(job.pages[0]))).toBe(signature);
  });
});
