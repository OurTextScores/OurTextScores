import { UploadOperationsService } from './upload-operations.service';

describe('upload operations persistence', () => {
  const query = (value: any) => ({ sort: () => ({ lean: () => ({ exec: async () => value }) }) });
  it('expires allowances and honors revocation', async () => {
    const audit: any = { findOne: jest.fn() };
    const service = new UploadOperationsService({} as any, audit);
    audit.findOne.mockReturnValue(
      query({ action: 'grant', expiresAt: new Date(Date.now() - 1), limit: 200 })
    );
    expect(await service.allowance('user')).toBeNull();
    audit.findOne.mockReturnValue(
      query({ action: 'revoke', expiresAt: new Date(Date.now() + 100000), limit: 200 })
    );
    expect(await service.allowance('user')).toBeNull();
  });
  it('validates changes before appending an audit record', async () => {
    const audit: any = { create: jest.fn() };
    const service = new UploadOperationsService({} as any, audit);
    await expect(
      service.changeLimit('admin', 'user', {
        action: 'grant',
        limit: 9000,
        reason: 'Bulk import',
        expiresAt: new Date(Date.now() + 1000)
      })
    ).rejects.toThrow();
    expect(audit.create).not.toHaveBeenCalled();
    await service.changeLimit('admin', 'user', { action: 'reset', reason: 'Resume import' });
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin',
        userId: 'user',
        action: 'reset',
        reason: 'Resume import'
      })
    );
  });
  it('stores an observation idempotently and excludes caller-provided event time', async () => {
    const updateOne = jest.fn((_filter: any, _update: any, _options: any) => ({
      exec: async () => ({})
    }));
    const service = new UploadOperationsService({ updateOne } as any, {} as any);
    await service.record({
      attemptId: 'id',
      observation: 'client',
      userId: 'user',
      at: new Date(0)
    });
    expect(updateOne).toHaveBeenCalledWith(
      { attemptId: 'id', observation: 'client', userId: 'user' },
      { $setOnInsert: expect.objectContaining({ at: expect.any(Date) }) },
      { upsert: true }
    );
    expect(updateOne.mock.calls[0][1].$setOnInsert.at.getTime()).toBeGreaterThan(0);
  });
});
