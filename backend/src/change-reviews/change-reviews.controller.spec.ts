import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { ChangeReviewsController } from './change-reviews.controller';
import { ChangeReviewsService } from './change-reviews.service';

describe('ChangeReviewsController', () => {
  const service = {
    createOrResumeReview: jest.fn(),
    createOrOpenBranchReview: jest.fn(),
    listReviews: jest.fn(),
    getReviewDetail: jest.fn(),
    getReviewDiff: jest.fn(),
    createThread: jest.fn(),
    addThreadComment: jest.fn(),
    updateComment: jest.fn(),
    deleteComment: jest.fn(),
    updateThreadStatus: jest.fn(),
    submitReview: jest.fn(),
    closeReview: jest.fn(),
    reopenReview: jest.fn(),
    withdrawReview: jest.fn(),
  } as any as jest.Mocked<ChangeReviewsService>;

  const controller = new ChangeReviewsController(service);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('createOrResumeReview delegates to service', async () => {
    service.createOrResumeReview.mockResolvedValue({ reviewId: 'review-1' } as any);
    const viewer = { userId: 'reviewer-1', roles: ['user'] } as any;

    const result = await controller.createOrResumeReview(
      '164349',
      'src-1',
      { baseRevisionId: 'rev-1', headRevisionId: 'rev-2', title: 'Please review' },
      viewer,
    );

    expect(service.createOrResumeReview).toHaveBeenCalledWith({
      workId: '164349',
      sourceId: 'src-1',
      baseRevisionId: 'rev-1',
      headRevisionId: 'rev-2',
      ownerUserId: undefined,
      title: 'Please review',
      reviewer: viewer,
    });
    expect(result).toEqual({ reviewId: 'review-1' });
  });

  it('listReviews delegates query params to service', async () => {
    service.listReviews.mockResolvedValue({ items: [] } as any);
    const viewer = { userId: 'reviewer-1', roles: ['user'] } as any;

    await controller.listReviews(viewer, 'owner', 'open', '25');

    expect(service.listReviews).toHaveBeenCalledWith({
      viewer,
      role: 'owner',
      status: 'open',
      limit: 25,
    });
  });

  it('createOrOpenBranchReview delegates to service', async () => {
    service.createOrOpenBranchReview.mockResolvedValue({ reviewId: 'review-branch-1' } as any);
    const viewer = { userId: 'reviewer-1', roles: ['user'] } as any;

    const result = await controller.createOrOpenBranchReview(
      '164349',
      'src-1',
      'trunk',
      { title: 'CR for trunk' },
      viewer,
    );

    expect(service.createOrOpenBranchReview).toHaveBeenCalledWith({
      workId: '164349',
      sourceId: 'src-1',
      branchName: 'trunk',
      ownerUserId: undefined,
      title: 'CR for trunk',
      opener: viewer,
    });
    expect(result).toEqual({ reviewId: 'review-branch-1' });
  });

  it('requires auth for all routes', () => {
    const createGuards = Reflect.getMetadata(GUARDS_METADATA, ChangeReviewsController.prototype.createOrResumeReview);
    const createBranchReviewGuards = Reflect.getMetadata(GUARDS_METADATA, ChangeReviewsController.prototype.createOrOpenBranchReview);
    const listGuards = Reflect.getMetadata(GUARDS_METADATA, ChangeReviewsController.prototype.listReviews);
    const detailGuards = Reflect.getMetadata(GUARDS_METADATA, ChangeReviewsController.prototype.getReviewDetail);
    const diffGuards = Reflect.getMetadata(GUARDS_METADATA, ChangeReviewsController.prototype.getReviewDiff);
    const createThreadGuards = Reflect.getMetadata(GUARDS_METADATA, ChangeReviewsController.prototype.createThread);
    const addThreadCommentGuards = Reflect.getMetadata(GUARDS_METADATA, ChangeReviewsController.prototype.addThreadComment);
    const updateCommentGuards = Reflect.getMetadata(GUARDS_METADATA, ChangeReviewsController.prototype.updateComment);
    const deleteCommentGuards = Reflect.getMetadata(GUARDS_METADATA, ChangeReviewsController.prototype.deleteComment);
    const updateThreadStatusGuards = Reflect.getMetadata(GUARDS_METADATA, ChangeReviewsController.prototype.updateThreadStatus);
    const submitReviewGuards = Reflect.getMetadata(GUARDS_METADATA, ChangeReviewsController.prototype.submitReview);
    const closeReviewGuards = Reflect.getMetadata(GUARDS_METADATA, ChangeReviewsController.prototype.closeReview);
    const reopenReviewGuards = Reflect.getMetadata(GUARDS_METADATA, ChangeReviewsController.prototype.reopenReview);
    const withdrawReviewGuards = Reflect.getMetadata(GUARDS_METADATA, ChangeReviewsController.prototype.withdrawReview);

    expect(createGuards).toEqual(expect.arrayContaining([AuthRequiredGuard]));
    expect(createBranchReviewGuards).toEqual(expect.arrayContaining([AuthRequiredGuard]));
    expect(listGuards).toEqual(expect.arrayContaining([AuthRequiredGuard]));
    expect(detailGuards).toEqual(expect.arrayContaining([AuthRequiredGuard]));
    expect(diffGuards).toEqual(expect.arrayContaining([AuthRequiredGuard]));
    expect(createThreadGuards).toEqual(expect.arrayContaining([AuthRequiredGuard]));
    expect(addThreadCommentGuards).toEqual(expect.arrayContaining([AuthRequiredGuard]));
    expect(updateCommentGuards).toEqual(expect.arrayContaining([AuthRequiredGuard]));
    expect(deleteCommentGuards).toEqual(expect.arrayContaining([AuthRequiredGuard]));
    expect(updateThreadStatusGuards).toEqual(expect.arrayContaining([AuthRequiredGuard]));
    expect(submitReviewGuards).toEqual(expect.arrayContaining([AuthRequiredGuard]));
    expect(closeReviewGuards).toEqual(expect.arrayContaining([AuthRequiredGuard]));
    expect(reopenReviewGuards).toEqual(expect.arrayContaining([AuthRequiredGuard]));
    expect(withdrawReviewGuards).toEqual(expect.arrayContaining([AuthRequiredGuard]));
  });
});
