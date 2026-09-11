import { ScannerFindingDispositionService } from './scanner-finding-disposition.service';

/**
 * These tests exist for one reason: `part` is nullable, and the difference between
 * `null` and absent decides whether the unique index sees two rows or one. A service
 * that wrote `undefined` would create a second "all parts" row on every edit and quietly
 * stop the standing decision from being standing. Nothing about that failure is visible
 * from the outside, so it is asserted on the query the service actually sends.
 */
function fakeModel() {
  const calls: any[] = [];
  return {
    calls,
    findOneAndUpdate: jest.fn((filter: any, update: any, options: any) => {
      calls.push({ op: 'findOneAndUpdate', filter, update, options });
      return { lean: () => ({ exec: async () => ({ ...filter, ...update.$set }) }) };
    }),
    deleteOne: jest.fn((filter: any) => {
      calls.push({ op: 'deleteOne', filter });
      return { exec: async () => ({ deletedCount: 1 }) };
    }),
    find: jest.fn((filter: any) => {
      calls.push({ op: 'find', filter });
      return {
        sort: () => ({
          lean: () => ({
            exec: async () => [
              { kind: 'clef_profile_mismatch', part: 'cello', disposition: 'profile-amended' },
              { kind: 'dangling_slur_start', part: null, disposition: 'acknowledged' }
            ]
          })
        }),
        lean: () => ({
          exec: async () => [
            { kind: 'a', part: null, disposition: 'acknowledged' },
            { kind: 'b', part: null, disposition: 'acknowledged' },
            { kind: 'c', part: null, disposition: 'reading-flagged' }
          ]
        })
      };
    })
  };
}

function service(model: ReturnType<typeof fakeModel>) {
  return new ScannerFindingDispositionService(model as never);
}

describe('ScannerFindingDispositionService', () => {
  it('normalises an absent part to null, so the unique index sees one row', async () => {
    const model = fakeModel();
    await service(model).set({
      jobId: 'job-1',
      kind: 'dangling_slur_start',
      disposition: 'acknowledged',
      userHash: 'hash'
    });
    const { filter, options } = model.calls[0];
    expect(filter).toEqual({ jobId: 'job-1', kind: 'dangling_slur_start', part: null });
    expect(options).toEqual({ upsert: true, new: true });
  });

  it('normalises an explicit null the same way', async () => {
    const model = fakeModel();
    await service(model).set({
      jobId: 'job-1',
      kind: 'x',
      part: null,
      disposition: 'acknowledged',
      userHash: 'hash'
    });
    expect(model.calls[0].filter.part).toBeNull();
  });

  it('keeps a named part as the key, so it does not collide with the all-parts row', async () => {
    const model = fakeModel();
    await service(model).set({
      jobId: 'job-1',
      kind: 'clef_profile_mismatch',
      part: 'cello',
      disposition: 'profile-amended',
      userHash: 'hash'
    });
    expect(model.calls[0].filter.part).toBe('cello');
  });

  it('omits optional fields rather than writing undefined over an existing value', async () => {
    // $set with an explicit undefined is not a no-op everywhere; a later edit that did
    // not restate profileRevision must not erase it.
    const model = fakeModel();
    await service(model).set({
      jobId: 'job-1',
      kind: 'x',
      disposition: 'acknowledged',
      userHash: 'hash'
    });
    expect(Object.keys(model.calls[0].update.$set).sort()).toEqual(['disposition', 'userHash']);
  });

  it('records the profile revision when one is given', async () => {
    const model = fakeModel();
    await service(model).set({
      jobId: 'job-1',
      kind: 'clef_profile_mismatch',
      part: 'cello',
      disposition: 'profile-amended',
      userHash: 'hash',
      profileRevision: 2,
      findingCount: 11
    });
    expect(model.calls[0].update.$set).toMatchObject({ profileRevision: 2, findingCount: 11 });
  });

  it('sets the key only on insert, so an edit cannot move a row between jobs', async () => {
    const model = fakeModel();
    await service(model).set({
      jobId: 'job-1',
      kind: 'x',
      disposition: 'acknowledged',
      userHash: 'hash'
    });
    expect(model.calls[0].update.$setOnInsert).toEqual({
      jobId: 'job-1',
      kind: 'x',
      part: null
    });
  });

  it('clears a decision by the same normalised key', async () => {
    const model = fakeModel();
    expect(await service(model).clear('job-1', 'dangling_slur_start')).toBe(true);
    expect(model.calls[0].filter).toEqual({
      jobId: 'job-1',
      kind: 'dangling_slur_start',
      part: null
    });
  });

  it('lists decisions in the shape the rules module consumes', async () => {
    const model = fakeModel();
    const rows = await service(model).list('job-1');
    expect(rows).toEqual([
      { kind: 'clef_profile_mismatch', part: 'cello', disposition: 'profile-amended', updatedAt: undefined },
      { kind: 'dangling_slur_start', part: null, disposition: 'acknowledged', updatedAt: undefined }
    ]);
  });

  it('counts decisions by kind of disposition', async () => {
    const model = fakeModel();
    expect(await service(model).countByDisposition('job-1')).toEqual({
      acknowledged: 2,
      'reading-flagged': 1
    });
  });
});
