import { ApprovalsController } from './approvals.controller';
import type { Model } from 'mongoose';
import { SourceRevision } from '../works/schemas/source-revision.schema';

describe('ApprovalsController', () => {
  const model: jest.Mocked<Partial<Model<SourceRevision>>> & any = {
    find: jest.fn()
  } as any;

  const chain = (result: any) => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: () => Promise.resolve(result) }) }) }) });

  it('inbox returns pending approvals for owner', async () => {
    const controller = new ApprovalsController(model as any);
    const items = [{ workId: 'w', sourceId: 's', revisionId: 'r', sequenceNumber: 2, createdAt: new Date(), createdBy: 'u', changeSummary: 'msg' }];
    model.find.mockReturnValue(chain(items));
    const out = await controller.inbox({ userId: 'owner1', email: 'e' } as any, '50' as any);
    expect(out.items).toHaveLength(1);
    expect(model.find).toHaveBeenCalledWith({ status: 'pending_approval', 'approval.ownerUserId': 'owner1' });
  });
});

