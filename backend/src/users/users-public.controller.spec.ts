import { NotFoundException } from '@nestjs/common';
import { UsersPublicController } from './users-public.controller';

describe('UsersPublicController', () => {
  const users = {
    findById: jest.fn()
  } as any;
  const sourceModel = {
    find: jest.fn()
  } as any;
  const sourceRevisionModel = {
    aggregate: jest.fn()
  } as any;
  const workModel = {
    find: jest.fn()
  } as any;

  const controller = new UsersPublicController(
    users as any,
    sourceModel as any,
    sourceRevisionModel as any,
    workModel as any
  );

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('getContributions returns distinct sources with metadata', async () => {
    users.findById.mockResolvedValue({ _id: 'user-1', username: 'alice', displayName: 'Alice' });

    sourceRevisionModel.aggregate.mockReturnValue({
      exec: jest.fn().mockResolvedValue([
        {
          total: [{ count: 1 }],
          items: [
            {
              _id: { workId: 'w1', sourceId: 's1' },
              lastContributionAt: '2026-02-01T00:00:00.000Z',
              revisionCount: 2
            }
          ]
        }
      ])
    });

    sourceModel.find.mockReturnValue({
      lean: () => ({
        exec: jest.fn().mockResolvedValue([
          {
            workId: 'w1',
            sourceId: 's1',
            label: 'Source 1',
            format: 'application/xml',
            isPrimary: true,
            latestRevisionId: 'r1',
            latestRevisionAt: '2026-02-01T00:00:00.000Z'
          }
        ])
      })
    });

    workModel.find.mockReturnValue({
      lean: () => ({
        exec: jest.fn().mockResolvedValue([
          { workId: 'w1', title: 'Work 1', composer: 'Composer 1', catalogNumber: 'Op. 1' }
        ])
      })
    });

    const result = await controller.getContributions('user-1', '50', '0');

    expect(result.user.username).toBe('alice');
    expect(result.total).toBe(1);
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0]).toMatchObject({
      workId: 'w1',
      sourceId: 's1',
      label: 'Source 1',
      workTitle: 'Work 1',
      workComposer: 'Composer 1',
      workCatalogNumber: 'Op. 1'
    });
  });

  it('getContributions throws when user not found', async () => {
    users.findById.mockResolvedValue(null);
    await expect(controller.getContributions('missing', '10', '0')).rejects.toBeInstanceOf(NotFoundException);
  });
});
