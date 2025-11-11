import { WatchesService } from './watches.service';

describe('WatchesService', () => {
  let svc: WatchesService;
  const model = {
    findOneAndUpdate: jest.fn(),
    deleteOne: jest.fn(),
    countDocuments: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn()
  } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    svc = new WatchesService(model as any);
  });

  it('subscribe and unsubscribe', async () => {
    model.findOneAndUpdate.mockReturnValue({ exec: () => Promise.resolve({}) });
    await svc.subscribe('u1', 'w1', 's1');
    expect(model.findOneAndUpdate).toHaveBeenCalled();
    model.deleteOne.mockReturnValue({ exec: () => Promise.resolve({}) });
    await svc.unsubscribe('u1', 'w1', 's1');
    expect(model.deleteOne).toHaveBeenCalled();
  });

  it('count, isSubscribed, and getSubscribersUserIds', async () => {
    model.countDocuments.mockReturnValue({ exec: () => Promise.resolve(3) });
    expect(await svc.count('w1', 's1')).toBe(3);
    model.findOne.mockReturnValue({ lean: () => ({ exec: () => Promise.resolve({ userId: 'u1' }) }) });
    expect(await svc.isSubscribed('u1', 'w1', 's1')).toBe(true);
    model.find.mockReturnValue({ lean: () => ({ exec: () => Promise.resolve([{ userId: 'a' }, { userId: 'b' }]) }) });
    expect(await svc.getSubscribersUserIds('w1', 's1')).toEqual(['a', 'b']);
  });
});

