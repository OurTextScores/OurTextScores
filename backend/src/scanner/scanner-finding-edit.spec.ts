import { ScannerService } from './scanner.service';

/**
 * The routing decision this file exists for: a bar rewritten because one engine flagged
 * itself must not be filed as evidence that two readings disagreed.
 *
 * `ScannerMergeDecision` records "two independent readings disagreed, and here is which
 * one a human believed". Findings live on single-engine jobs, where base and candidate
 * collapse to the same engine, so filing one there asserts a disagreement that never
 * happened. These tests pin the split at the one place it is made.
 */
function page() {
  return {
    pageNumber: 1,
    status: 'succeeded',
    recognitionRaster: { storage: { checksumSha256: 'page-sha' }, width: 10, height: 10 },
    engines: {
      'ots-homr': {
        status: 'succeeded',
        modelRevision: 'model-464',
        providerRevision: 'provider-v7',
        artifacts: { musicXml: { checksumSha256: 'artifact-sha' } }
      }
    }
  } as never;
}

function build(findingEdits?: unknown, mergeDecisions?: unknown) {
  return new ScannerService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { userHash: () => 'user-hash' } as never,
    {} as never,
    { get: (_key: string, fallback: string) => fallback } as never,
    undefined,
    mergeDecisions as never,
    undefined,
    findingEdits as never
  );
}

function store() {
  const created: Record<string, unknown>[] = [];
  return { created, create: jest.fn(async (doc: Record<string, unknown>) => created.push(doc)) };
}

/** `recordFindingEdit` is private; this is the seam the save path calls it through. */
function record(service: ScannerService, overrides: Record<string, unknown> = {}) {
  return (service as never as {
    recordFindingEdit: (input: Record<string, unknown>) => Promise<void>;
  }).recordFindingEdit({
    page: page(),
    userId: 'user-1',
    engineId: 'ots-homr',
    findingKind: 'clef_profile_mismatch',
    part: 'cello',
    measureIndex: 4,
    ...overrides
  });
}

describe('recordFindingEdit', () => {
  it('attributes the edit to exactly one engine', async () => {
    // The whole point: no second engine is named, because none was consulted.
    const edits = store();
    await record(build(edits));
    expect(edits.created[0]).toMatchObject({
      engineId: 'ots-homr',
      findingKind: 'clef_profile_mismatch',
      part: 'cello',
      measureIndex: 4
    });
    expect(edits.created[0]).not.toHaveProperty('baseEngineId');
    expect(edits.created[0]).not.toHaveProperty('candidateEngineId');
  });

  it('keys on the page image, so it outlives the job', async () => {
    const edits = store();
    await record(build(edits));
    expect(edits.created[0]).toMatchObject({ pageSha256: 'page-sha', userHash: 'user-hash' });
  });

  it('binds the sample to the model that produced it', async () => {
    // A sample is meaningless without knowing which revision wrote the reading.
    const edits = store();
    await record(build(edits));
    expect(edits.created[0]).toMatchObject({
      modelRevision: 'model-464',
      providerRevision: 'provider-v7',
      engineArtifactSha256: 'artifact-sha'
    });
  });

  it('records which profile revision the page was decoded against', async () => {
    // A finding raised under a narrow profile and one raised under a widened one are
    // different events.
    const edits = store();
    await record(build(edits), { scoreProfileRevision: 2 });
    expect(edits.created[0]).toMatchObject({ scoreProfileRevision: 2 });
  });

  it('records the training policy in force at capture time', async () => {
    const edits = store();
    await record(build(edits));
    expect(edits.created[0]).toMatchObject({ policyVersion: 'unset' });
  });

  it('writes nothing when the page has no durable identity', async () => {
    // Without a page hash the record could never be joined to anything.
    const edits = store();
    await record(build(edits), {
      page: { pageNumber: 1, engines: {} } as never
    });
    expect(edits.create).not.toHaveBeenCalled();
  });

  it('does not fail the reviewer’s save when recording throws', async () => {
    // Losing a training sample must not lose the reviewer's work.
    const edits = {
      create: jest.fn(async () => {
        throw new Error('mongo is down');
      })
    };
    await expect(record(build(edits))).resolves.toBeUndefined();
  });

  it('is inert without the collection, rather than breaking construction', async () => {
    await expect(record(build(undefined))).resolves.toBeUndefined();
  });

  it('never writes a merge decision', async () => {
    // The invariant. A merge decision here would assert a disagreement that did not
    // happen -- and on a single-engine job, could not have.
    const edits = store();
    const decisions = store();
    await record(build(edits, decisions));
    expect(decisions.create).not.toHaveBeenCalled();
    expect(edits.create).toHaveBeenCalledTimes(1);
  });
});
