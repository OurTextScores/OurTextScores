import { NotFoundException } from '@nestjs/common';
import type { Model } from 'mongoose';
import { ChangeReviewsService } from './change-reviews.service';
import { ChangeReview } from './schemas/change-review.schema';
import { ChangeReviewPatchset } from './schemas/change-review-patchset.schema';
import { ChangeReviewThread } from './schemas/change-review-thread.schema';
import { ChangeReviewComment } from './schemas/change-review-comment.schema';
import { Work } from '../works/schemas/work.schema';
import { Source } from '../works/schemas/source.schema';
import { SourceRevision } from '../works/schemas/source-revision.schema';
import { SourceBranch } from '../branches/schemas/source-branch.schema';

function chain<T>(result: T) {
  return {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(result),
  } as any;
}

describe('ChangeReviewsService', () => {
  let service: ChangeReviewsService;
  let reviewModel: jest.Mocked<Partial<Model<ChangeReview>>> & any;
  let patchsetModel: jest.Mocked<Partial<Model<ChangeReviewPatchset>>> & any;
  let threadModel: any;
  let commentModel: any;
  let workModel: any;
  let sourceModel: any;
  let sourceRevisionModel: any;
  let sourceBranchModel: any;
  let notificationsService: any;
  let storageService: any;
  let usersService: any;
  let watchesService: any;
  let branchesService: any;

  const work = { workId: '164349', title: 'Test Work', composer: 'Test Composer' };
  const source = {
    workId: '164349',
    sourceId: 'src-1',
    label: 'Primary Score',
    sourceType: 'score',
    provenance: { uploadedByUserId: 'uploader-1' },
  };
  const baseRevision = {
    workId: '164349',
    sourceId: 'src-1',
    revisionId: 'rev-1',
    sequenceNumber: 1,
    createdBy: 'author-1',
    status: 'approved',
    visibility: 'public',
    branchName: 'trunk',
    derivatives: { canonicalXml: { bucket: 'der', objectKey: 'base.xml' } },
  };
  const headRevision = {
    workId: '164349',
    sourceId: 'src-1',
    revisionId: 'rev-2',
    sequenceNumber: 2,
    createdBy: 'author-2',
    status: 'approved',
    visibility: 'public',
    branchName: 'trunk',
    derivatives: { canonicalXml: { bucket: 'der', objectKey: 'head.xml' } },
  };

  beforeEach(() => {
    jest.resetAllMocks();
    reviewModel = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(undefined) }),
    } as any;
    patchsetModel = {
      create: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockReturnValue(chain(null)),
      countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(0) }),
    } as any;
    threadModel = {
      aggregate: jest.fn().mockResolvedValue([]),
    } as any;
    commentModel = {} as any;
    workModel = {
      findOne: jest.fn(),
      find: jest.fn(),
    } as any;
    sourceModel = {
      findOne: jest.fn(),
      find: jest.fn(),
    } as any;
    sourceRevisionModel = {
      findOne: jest.fn(),
    } as any;
    sourceBranchModel = {
      findOne: jest.fn(),
    } as any;
    notificationsService = {
      queueChangeReviewSubmitted: jest.fn().mockResolvedValue(undefined),
      queueChangeReviewActivity: jest.fn().mockResolvedValue(undefined),
    } as any;
    storageService = {
      getObjectBuffer: jest.fn(),
    } as any;
    usersService = {
      findById: jest.fn(async (id: string) => ({ _id: id, username: `${id}-name`, email: `${id}@example.com` })),
    };
    watchesService = {
      getSubscribersUserIds: jest.fn().mockResolvedValue([]),
    };
    branchesService = {
      sanitizeName: jest.fn((name?: string) => (name || 'trunk').trim() || 'trunk'),
      getBranchPolicy: jest.fn().mockResolvedValue('public'),
      listBranches: jest.fn().mockResolvedValue([{ name: 'trunk', policy: 'public', lifecycle: 'open' }]),
      setBranchLifecycle: jest.fn().mockResolvedValue({ name: 'trunk', policy: 'public', lifecycle: 'open' }),
    };

    workModel.findOne.mockImplementation((query: any) => {
      if (query?.workId === '164349') return chain(work);
      return chain(null);
    });
    sourceModel.findOne.mockImplementation((query: any) => {
      if (query?.workId === '164349' && query?.sourceId === 'src-1') return chain(source);
      return chain(null);
    });
    sourceRevisionModel.findOne.mockImplementation((query: any) => {
      if (query?.revisionId === 'rev-1') return chain(baseRevision);
      if (query?.revisionId === 'rev-2') return chain(headRevision);
      return chain(null);
    });
    sourceBranchModel.findOne.mockReturnValue(chain({ ownerUserId: 'branch-owner-1' }));
    reviewModel.findOne.mockReturnValue(chain(null));
    reviewModel.find.mockReturnValue(chain([]));
    reviewModel.create.mockImplementation(async (doc: any) => ({
      toObject: () => doc,
    }));
    threadModel.find = jest.fn().mockReturnValue(chain([]));
    threadModel.countDocuments = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });
    threadModel.create = jest.fn().mockResolvedValue(undefined);
    commentModel.find = jest.fn().mockReturnValue(chain([]));
    commentModel.create = jest.fn().mockResolvedValue(undefined);
    storageService.getObjectBuffer.mockResolvedValue(Buffer.from('<score-partwise/>\n'));

    service = new ChangeReviewsService(
      reviewModel as any,
      patchsetModel as any,
      threadModel as any,
      commentModel as any,
      workModel as any,
      sourceModel as any,
      sourceRevisionModel as any,
      sourceBranchModel as any,
      branchesService as any,
      notificationsService as any,
      storageService as any,
      usersService as any,
      watchesService as any,
    );
  });

  it('creates an open branch review, seeds patchset 1, and adds uploader as participant', async () => {
    reviewModel.findOne.mockReturnValueOnce(chain(null));
    sourceRevisionModel.find = jest.fn().mockReturnValue(
      chain([headRevision, baseRevision]),
    );

    const result = await service.createOrOpenBranchReview({
      workId: '164349',
      sourceId: 'src-1',
      branchName: 'trunk',
      opener: { userId: 'reviewer-1', roles: ['user'] },
    });

    expect(reviewModel.create).toHaveBeenCalled();
    const payload = reviewModel.create.mock.calls[0][0];
    expect(payload.status).toBe('open');
    expect(payload.branchName).toBe('trunk');
    expect(payload.ownerUserId).toBe('author-2');
    expect(payload.participantUserIds).toEqual(
      expect.arrayContaining(['reviewer-1', 'author-2', 'uploader-1']),
    );
    expect(patchsetModel.create).toHaveBeenCalledWith(expect.objectContaining({
      reviewId: payload.reviewId,
      patchsetNumber: 1,
      baseRevisionId: 'rev-1',
      headRevisionId: 'rev-2',
    }));
    expect(result.work.title).toBe('Test Work');
    expect(result.source.label).toBe('Primary Score');
  });

  it('returns an existing active branch review instead of creating another one', async () => {
    reviewModel.findOne.mockReturnValueOnce(
      chain({
        reviewId: 'review-1',
        workId: '164349',
        sourceId: 'src-1',
        branchName: 'trunk',
        baseRevisionId: 'rev-1',
        headRevisionId: 'rev-2',
        baseSequenceNumber: 1,
        headSequenceNumber: 2,
        reviewerUserId: 'reviewer-1',
        ownerUserId: 'author-2',
        participantUserIds: ['reviewer-1', 'author-2'],
        status: 'open',
        unresolvedThreadCount: 0,
        lastActivityAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );

    const result = await service.createOrOpenBranchReview({
      workId: '164349',
      sourceId: 'src-1',
      branchName: 'trunk',
      opener: { userId: 'reviewer-1', roles: ['user'] },
    });

    expect(reviewModel.create).not.toHaveBeenCalled();
    expect(result.reviewId).toBe('review-1');
  });

  it('lists reviews for the current reviewer', async () => {
    reviewModel.find.mockReturnValue(
      chain([
        {
          reviewId: 'review-1',
          workId: '164349',
          sourceId: 'src-1',
          branchName: 'trunk',
          baseRevisionId: 'rev-1',
          headRevisionId: 'rev-2',
          baseSequenceNumber: 1,
          headSequenceNumber: 2,
          reviewerUserId: 'reviewer-1',
          ownerUserId: 'author-2',
          title: 'Please review',
          status: 'open',
          unresolvedThreadCount: 2,
          submittedAt: new Date('2026-03-07T12:00:00Z'),
          lastActivityAt: new Date('2026-03-07T12:30:00Z'),
        },
      ]),
    );
    workModel.find.mockReturnValue(chain([work]));
    sourceModel.find.mockReturnValue(chain([source]));

    const result = await service.listReviews({
      viewer: { userId: 'reviewer-1', roles: ['user'] },
      role: 'reviewer',
      status: 'open',
    });

    expect(reviewModel.find).toHaveBeenCalledWith({
      reviewerUserId: 'reviewer-1',
      status: 'open',
    });
    expect(result.items[0]).toMatchObject({
      reviewId: 'review-1',
      workTitle: 'Test Work',
      sourceLabel: 'Primary Score',
      reviewerUsername: 'reviewer-1-name',
      ownerUsername: 'author-2-name',
    });
  });

  it('hides draft reviews from non-reviewers', async () => {
    reviewModel.findOne.mockReturnValue(
      chain({
        reviewId: 'review-1',
        workId: '164349',
        sourceId: 'src-1',
        reviewerUserId: 'reviewer-1',
        ownerUserId: 'author-2',
        participantUserIds: ['reviewer-1', 'author-2'],
        status: 'draft',
      }),
    );

    await expect(
      service.getReviewDetail('review-1', { userId: 'author-2', roles: ['user'] }),
    ).rejects.toThrow(NotFoundException);
  });

  it('returns structured diff hunks for a readable review', async () => {
    reviewModel.findOne.mockReturnValue(
      chain({
        reviewId: 'review-1',
        workId: '164349',
        sourceId: 'src-1',
        baseRevisionId: 'rev-1',
        headRevisionId: 'rev-2',
        reviewerUserId: 'reviewer-1',
        ownerUserId: 'author-2',
        participantUserIds: ['reviewer-1', 'author-2'],
        status: 'open',
      }),
    );
    threadModel.find.mockReturnValue(chain([]));
    commentModel.find.mockReturnValue(chain([]));
    storageService.getObjectBuffer
      .mockResolvedValueOnce(
        Buffer.from(
          '<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch></note></measure></part></score-partwise>',
        ),
      )
      .mockResolvedValueOnce(
        Buffer.from(
          '<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><note><pitch><step>D</step><octave>4</octave></pitch></note></measure></part></score-partwise>',
        ),
      )
      .mockResolvedValueOnce(
        Buffer.from(
          '<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch></note></measure></part></score-partwise>',
        ),
      )
      .mockResolvedValueOnce(
        Buffer.from(
          '<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><note><pitch><step>D</step><octave>4</octave></pitch></note></measure></part></score-partwise>',
        ),
      );

    const result = await service.getReviewDiff('review-1', { userId: 'reviewer-1', roles: ['user'] });

    expect(result.fileKind).toBe('canonical');
    expect(result.scoreRegions.length).toBeGreaterThan(0);
    expect(result.scoreRegions[0]).toEqual(
      expect.objectContaining({
        label: 'Piano - m. 1',
        changeType: 'modified',
        commentable: true,
      }),
    );
  });

  it('submits a draft review and queues notifications for participants and watchers', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    reviewModel.findOne.mockReturnValue(
      chain({
        reviewId: 'review-1',
        workId: '164349',
        sourceId: 'src-1',
        branchName: 'trunk',
        baseRevisionId: 'rev-1',
        headRevisionId: 'rev-2',
        baseSequenceNumber: 1,
        headSequenceNumber: 2,
        reviewerUserId: 'reviewer-1',
        ownerUserId: 'author-2',
        participantUserIds: ['reviewer-1', 'author-2', 'uploader-1'],
        status: 'draft',
        unresolvedThreadCount: 1,
        lastActivityAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        save,
      }),
    );
    watchesService.getSubscribersUserIds.mockResolvedValue(['watcher-1', 'author-2', 'reviewer-1']);
    threadModel.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(1) });

    const result = await service.submitReview({
      reviewId: 'review-1',
      summary: 'Please address these changes',
      viewer: { userId: 'reviewer-1', roles: ['user'] },
    });

    expect(save).toHaveBeenCalled();
    expect(notificationsService.queueChangeReviewSubmitted).toHaveBeenCalledTimes(3);
    expect(notificationsService.queueChangeReviewSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: 'review-1',
        recipientUserId: 'author-2',
        actorUserId: 'reviewer-1',
      }),
    );
    expect(notificationsService.queueChangeReviewSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: 'review-1',
        recipientUserId: 'uploader-1',
        actorUserId: 'reviewer-1',
      }),
    );
    expect(notificationsService.queueChangeReviewSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: 'review-1',
        recipientUserId: 'watcher-1',
        actorUserId: 'reviewer-1',
      }),
    );
    expect(result.status).toBe('open');
  });

  it('closing a review closes the branch lifecycle', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    reviewModel.findOne.mockReturnValue(
      chain({
        reviewId: 'review-1',
        workId: '164349',
        sourceId: 'src-1',
        branchName: 'trunk',
        reviewerUserId: 'reviewer-1',
        ownerUserId: 'author-2',
        status: 'open',
        save,
      }),
    );

    const result = await service.closeReview({
      reviewId: 'review-1',
      viewer: { userId: 'author-2', roles: ['user'] },
    });

    expect(save).toHaveBeenCalled();
    expect(branchesService.setBranchLifecycle).toHaveBeenCalledWith('164349', 'src-1', 'trunk', 'closed');
    expect(result).toEqual({ ok: true });
  });

  it('reopening a review reopens the branch lifecycle', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    reviewModel.findOne.mockReturnValue(
      chain({
        reviewId: 'review-1',
        workId: '164349',
        sourceId: 'src-1',
        branchName: 'trunk',
        reviewerUserId: 'reviewer-1',
        ownerUserId: 'author-2',
        status: 'closed',
        save,
      }),
    );

    const result = await service.reopenReview({
      reviewId: 'review-1',
      viewer: { userId: 'author-2', roles: ['user'] },
    });

    expect(save).toHaveBeenCalled();
    expect(branchesService.setBranchLifecycle).toHaveBeenCalledWith('164349', 'src-1', 'trunk', 'open');
    expect(result).toEqual({ ok: true });
  });
});
