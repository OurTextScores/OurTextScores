import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { ChangeReview, ChangeReviewDocument, ChangeReviewStatus } from './schemas/change-review.schema';
import { ChangeReviewThread, ChangeReviewThreadDocument } from './schemas/change-review-thread.schema';
import { ChangeReviewComment, ChangeReviewCommentDocument } from './schemas/change-review-comment.schema';
import { Work, WorkDocument } from '../works/schemas/work.schema';
import { Source, SourceDocument } from '../works/schemas/source.schema';
import { SourceRevision, SourceRevisionDocument } from '../works/schemas/source-revision.schema';
import { SourceBranch, SourceBranchDocument } from '../branches/schemas/source-branch.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';
import { UsersService } from '../users/users.service';
import type { RequestUser } from '../auth/types/auth-user';

type ReviewRole = 'reviewer' | 'owner' | 'all';
type ReviewStatusFilter = ChangeReviewStatus | 'all';

type RevisionLike = {
  revisionId: string;
  sequenceNumber: number;
  createdBy?: string;
  branchName?: string;
  fossilBranch?: string;
  status?: string;
  visibility?: string;
  approval?: { ownerUserId?: string };
};

@Injectable()
export class ChangeReviewsService {
  constructor(
    @InjectModel(ChangeReview.name)
    private readonly reviewModel: Model<ChangeReviewDocument>,
    @InjectModel(ChangeReviewThread.name)
    private readonly threadModel: Model<ChangeReviewThreadDocument>,
    @InjectModel(ChangeReviewComment.name)
    private readonly commentModel: Model<ChangeReviewCommentDocument>,
    @InjectModel(Work.name)
    private readonly workModel: Model<WorkDocument>,
    @InjectModel(Source.name)
    private readonly sourceModel: Model<SourceDocument>,
    @InjectModel(SourceRevision.name)
    private readonly sourceRevisionModel: Model<SourceRevisionDocument>,
    @InjectModel(SourceBranch.name)
    private readonly sourceBranchModel: Model<SourceBranchDocument>,
    private readonly notificationsService: NotificationsService,
    private readonly storageService: StorageService,
    private readonly usersService: UsersService,
  ) {}

  async createOrResumeReview(input: {
    workId: string;
    sourceId: string;
    baseRevisionId: string;
    headRevisionId: string;
    ownerUserId?: string;
    title?: string;
    reviewer: RequestUser;
  }) {
    const { workId, sourceId, baseRevisionId, headRevisionId, reviewer } = input;
    const viewerIsAdmin = this.isAdmin(reviewer);

    const { work, source, baseRevision, headRevision } = await this.loadRevisionPair({
      workId,
      sourceId,
      baseRevisionId,
      headRevisionId,
      viewer: reviewer,
    });

    const existing = await this.reviewModel
      .findOne({
        reviewerUserId: reviewer.userId,
        workId,
        sourceId,
        baseRevisionId,
        headRevisionId,
        status: { $in: ['draft', 'open'] },
      })
      .lean()
      .exec();

    if (existing) {
      return this.buildReviewDetail(existing, work as any, source as any, reviewer);
    }

    if (input.ownerUserId && !viewerIsAdmin) {
      throw new ForbiddenException('Only admins may set review owner explicitly');
    }

    const branchName = this.resolveBranchName(headRevision as any);
    const ownerUserId = await this.resolveOwnerUserId({
      explicitOwnerUserId: input.ownerUserId,
      workId,
      sourceId,
      branchName,
      headRevision: headRevision as any,
      source: source as any,
    });

    if (!ownerUserId) {
      throw new BadRequestException('Unable to resolve review owner');
    }

    const participantUserIds = Array.from(
      new Set(
        [
          reviewer.userId,
          ownerUserId,
          (source as any)?.provenance?.uploadedByUserId,
        ].filter(Boolean),
      ),
    );

    const now = new Date();
    const created = await this.reviewModel.create({
      reviewId: randomUUID(),
      workId,
      sourceId,
      branchName,
      baseRevisionId,
      headRevisionId,
      baseSequenceNumber: Number((baseRevision as any).sequenceNumber || 0),
      headSequenceNumber: Number((headRevision as any).sequenceNumber || 0),
      reviewerUserId: reviewer.userId,
      ownerUserId,
      participantUserIds,
      title: input.title?.trim() || undefined,
      status: 'draft',
      unresolvedThreadCount: 0,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });

    return this.buildReviewDetail(created.toObject() as any, work as any, source as any, reviewer);
  }

  async listReviews(input: {
    viewer: RequestUser;
    role?: ReviewRole;
    status?: ReviewStatusFilter;
    limit?: number;
  }) {
    const role = input.role || 'all';
    const status = input.status || 'all';
    const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 200);

    const query: Record<string, unknown> = {};
    if (role === 'reviewer') {
      query.reviewerUserId = input.viewer.userId;
    } else if (role === 'owner') {
      query.ownerUserId = input.viewer.userId;
    } else {
      query.$or = [
        { reviewerUserId: input.viewer.userId },
        { ownerUserId: input.viewer.userId },
        { participantUserIds: input.viewer.userId },
      ];
    }

    if (status !== 'all') {
      query.status = status;
    }

    const reviews = await this.reviewModel
      .find(query)
      .sort({ lastActivityAt: -1 })
      .limit(limit)
      .lean()
      .exec();

    const workIds = Array.from(new Set(reviews.map((review) => review.workId)));
    const sourceKeys = Array.from(new Set(reviews.map((review) => `${review.workId}::${review.sourceId}`)));
    const userIds = Array.from(
      new Set(
        reviews.flatMap((review) => [review.reviewerUserId, review.ownerUserId]),
      ),
    );

    const [works, sources, userIdToUsername] = await Promise.all([
      workIds.length > 0
        ? this.workModel.find({ workId: { $in: workIds } }).select('workId title composer').lean().exec()
        : Promise.resolve([]),
      sourceKeys.length > 0
        ? this.sourceModel
            .find({
              $or: sourceKeys.map((key) => {
                const [workId, sourceId] = key.split('::');
                return { workId, sourceId };
              }),
            })
            .select('workId sourceId label sourceType')
            .lean()
            .exec()
        : Promise.resolve([]),
      this.loadUsernames(userIds),
    ]);

    const worksById = new Map(works.map((work: any) => [String(work.workId), work]));
    const sourcesByKey = new Map(sources.map((source: any) => [`${source.workId}::${source.sourceId}`, source]));

    return {
      items: reviews.map((review) => {
        const work = worksById.get(review.workId) as any;
        const source = sourcesByKey.get(`${review.workId}::${review.sourceId}`) as any;
        return {
          reviewId: review.reviewId,
          workId: review.workId,
          sourceId: review.sourceId,
          branchName: review.branchName,
          baseRevisionId: review.baseRevisionId,
          headRevisionId: review.headRevisionId,
          baseSequenceNumber: review.baseSequenceNumber,
          headSequenceNumber: review.headSequenceNumber,
          reviewerUserId: review.reviewerUserId,
          reviewerUsername: userIdToUsername.get(review.reviewerUserId),
          ownerUserId: review.ownerUserId,
          ownerUsername: userIdToUsername.get(review.ownerUserId),
          title: review.title,
          status: review.status,
          unresolvedThreadCount: review.unresolvedThreadCount,
          submittedAt: review.submittedAt,
          lastActivityAt: review.lastActivityAt,
          workTitle: work?.title,
          composer: work?.composer,
          sourceLabel: source?.label,
          sourceType: source?.sourceType,
        };
      }),
      nextCursor: null,
    };
  }

  async getReviewDetail(reviewId: string, viewer: RequestUser) {
    const review = await this.getReadableReview(reviewId, viewer);

    const [work, source] = await Promise.all([
      this.workModel.findOne({ workId: review.workId }).select('workId title composer').lean().exec(),
      this.sourceModel.findOne({ workId: review.workId, sourceId: review.sourceId }).select('workId sourceId label sourceType').lean().exec(),
    ]);

    if (!work || !source) {
      throw new NotFoundException('Review target not found');
    }

    return this.buildReviewDetail(review as any, work as any, source as any, viewer);
  }

  async getReviewDiff(reviewId: string, viewer: RequestUser) {
    const review = await this.getReadableReview(reviewId, viewer);
    const [baseRevision, headRevision, threadViews] = await Promise.all([
      this.sourceRevisionModel
        .findOne({ workId: review.workId, sourceId: review.sourceId, revisionId: review.baseRevisionId })
        .lean()
        .exec(),
      this.sourceRevisionModel
        .findOne({ workId: review.workId, sourceId: review.sourceId, revisionId: review.headRevisionId })
        .lean()
        .exec(),
      this.buildThreadViews(review.reviewId),
    ]);

    if (!baseRevision || !headRevision) {
      throw new NotFoundException('Review target revisions not found');
    }

    const baseLocator = (baseRevision as any)?.derivatives?.canonicalXml;
    const headLocator = (headRevision as any)?.derivatives?.canonicalXml;
    if (!baseLocator || !headLocator) {
      throw new NotFoundException('Canonical XML missing for one or both revisions');
    }

    const rawDiff = await this.generateUnifiedDiff(baseLocator, headLocator);
    const parsed = this.parseUnifiedDiff(rawDiff);
    const scoreRegions = await this.buildScoreRegions(baseLocator, headLocator);

    return {
      reviewId: review.reviewId,
      fileKind: 'canonical' as const,
      baseRevisionId: review.baseRevisionId,
      headRevisionId: review.headRevisionId,
      scoreRegions,
      hunks: parsed.hunks,
      rawDiff,
      threads: threadViews,
    };
  }

  async createThread(input: {
    reviewId: string;
    anchorId: string;
    content: string;
    viewer: RequestUser;
  }) {
    const review = await this.reviewModel.findOne({ reviewId: input.reviewId }).lean().exec();
    if (!review) {
      throw new NotFoundException('Change review not found');
    }
    this.assertCanMutateReview(review as any, input.viewer, { allowNewThreads: true });

    const content = input.content?.trim();
    if (!content) {
      throw new BadRequestException('Comment content is required');
    }

    const diff = await this.getReviewDiff(review.reviewId, input.viewer);
    const scoreRegion = (diff as any).scoreRegions?.find((region: any) => region.anchorId === input.anchorId) || null;
    const anchor = scoreRegion ? null : this.findAnchor(diff.hunks, input.anchorId);
    if (!scoreRegion && (!anchor || !anchor.commentable)) {
      throw new BadRequestException('Invalid or non-commentable diff anchor');
    }

    const now = new Date();
    const threadId = randomUUID();
    const commentId = randomUUID();

    await this.threadModel.create({
      threadId,
      reviewId: review.reviewId,
      workId: review.workId,
      sourceId: review.sourceId,
      fileKind: 'canonical',
      diffAnchor: {
        side: scoreRegion?.side || anchor?.side || 'head',
        oldLineNumber: anchor?.oldLineNumber,
        newLineNumber: anchor?.newLineNumber,
        anchorId: scoreRegion?.anchorId || anchor?.anchorId || input.anchorId,
        lineHash: scoreRegion?.regionHash || anchor?.lineHash || this.hashText(input.anchorId),
        lineText: scoreRegion?.label || anchor?.content || 'Score region',
        hunkHeader: scoreRegion?.summary || anchor?.hunkHeader,
      },
      status: 'open',
      createdByUserId: input.viewer.userId,
      createdAt: now,
      updatedAt: now,
    });

    await this.commentModel.create({
      commentId,
      reviewId: review.reviewId,
      threadId,
      userId: input.viewer.userId,
      content,
      createdAt: now,
    });

    await this.syncReviewCounters(review.reviewId, now);
    return this.getReviewDiff(review.reviewId, input.viewer);
  }

  async addThreadComment(input: {
    reviewId: string;
    threadId: string;
    content: string;
    viewer: RequestUser;
  }) {
    const review = await this.reviewModel.findOne({ reviewId: input.reviewId }).lean().exec();
    if (!review) {
      throw new NotFoundException('Change review not found');
    }
    this.assertCanMutateReview(review as any, input.viewer, { allowNewThreads: false });

    const thread = await this.threadModel
      .findOne({ reviewId: input.reviewId, threadId: input.threadId })
      .lean()
      .exec();
    if (!thread) {
      throw new NotFoundException('Review thread not found');
    }

    const content = input.content?.trim();
    if (!content) {
      throw new BadRequestException('Comment content is required');
    }

    const now = new Date();
    await this.commentModel.create({
      commentId: randomUUID(),
      reviewId: input.reviewId,
      threadId: input.threadId,
      userId: input.viewer.userId,
      content,
      createdAt: now,
    });
    await this.syncReviewCounters(input.reviewId, now);
    return this.buildThreadViews(input.reviewId);
  }

  async updateComment(input: {
    reviewId: string;
    commentId: string;
    content: string;
    viewer: RequestUser;
  }) {
    const review = await this.reviewModel.findOne({ reviewId: input.reviewId }).lean().exec();
    if (!review) {
      throw new NotFoundException('Change review not found');
    }
    this.assertCanMutateReview(review as any, input.viewer, { allowNewThreads: false });

    const comment = await this.commentModel
      .findOne({ reviewId: input.reviewId, commentId: input.commentId, deleted: { $ne: true } })
      .exec();
    if (!comment) {
      throw new NotFoundException('Review comment not found');
    }
    if (String((comment as any).userId) !== input.viewer.userId) {
      throw new ForbiddenException('Only the comment author may edit this comment');
    }

    const content = input.content?.trim();
    if (!content) {
      throw new BadRequestException('Comment content is required');
    }

    (comment as any).content = content;
    (comment as any).editedAt = new Date();
    await comment.save();
    await this.syncReviewCounters(input.reviewId, new Date());
    return { ok: true };
  }

  async deleteComment(input: {
    reviewId: string;
    commentId: string;
    viewer: RequestUser;
  }) {
    const review = await this.reviewModel.findOne({ reviewId: input.reviewId }).lean().exec();
    if (!review) {
      throw new NotFoundException('Change review not found');
    }
    this.assertCanMutateReview(review as any, input.viewer, { allowNewThreads: false });

    const comment = await this.commentModel
      .findOne({ reviewId: input.reviewId, commentId: input.commentId, deleted: { $ne: true } })
      .exec();
    if (!comment) {
      throw new NotFoundException('Review comment not found');
    }
    if (String((comment as any).userId) !== input.viewer.userId) {
      throw new ForbiddenException('Only the comment author may delete this comment');
    }

    (comment as any).deleted = true;
    (comment as any).deletedAt = new Date();
    await comment.save();
    await this.syncReviewCounters(input.reviewId, new Date());
    return { ok: true };
  }

  async updateThreadStatus(input: {
    reviewId: string;
    threadId: string;
    status: 'open' | 'resolved';
    viewer: RequestUser;
  }) {
    const review = await this.reviewModel.findOne({ reviewId: input.reviewId }).lean().exec();
    if (!review) {
      throw new NotFoundException('Change review not found');
    }
    this.assertCanMutateReview(review as any, input.viewer, { allowNewThreads: false });

    const thread = await this.threadModel
      .findOne({ reviewId: input.reviewId, threadId: input.threadId })
      .exec();
    if (!thread) {
      throw new NotFoundException('Review thread not found');
    }

    (thread as any).status = input.status;
    (thread as any).updatedAt = new Date();
    if (input.status === 'resolved') {
      (thread as any).resolvedAt = new Date();
      (thread as any).resolvedByUserId = input.viewer.userId;
    } else {
      (thread as any).resolvedAt = undefined;
      (thread as any).resolvedByUserId = undefined;
    }
    await thread.save();
    await this.syncReviewCounters(input.reviewId, new Date());
    return { ok: true };
  }

  async submitReview(input: {
    reviewId: string;
    summary?: string;
    viewer: RequestUser;
  }) {
    const review = await this.reviewModel.findOne({ reviewId: input.reviewId }).exec();
    if (!review) {
      throw new NotFoundException('Change review not found');
    }
    if ((review as any).status !== 'draft') {
      throw new BadRequestException('Only draft reviews can be submitted');
    }
    if (String((review as any).reviewerUserId) !== input.viewer.userId) {
      throw new ForbiddenException('Only the reviewer may submit this review');
    }

    const summary = input.summary?.trim();
    const threadCount = await this.threadModel.countDocuments({ reviewId: input.reviewId }).exec();
    if (!summary && threadCount === 0) {
      throw new BadRequestException('Review must include a summary or at least one thread before submit');
    }

    const now = new Date();
    (review as any).summary = summary || (review as any).summary;
    (review as any).status = 'open';
    (review as any).submittedAt = now;
    (review as any).lastActivityAt = now;
    await review.save();

    await this.notificationsService.queueChangeReviewSubmitted({
      workId: String((review as any).workId),
      sourceId: String((review as any).sourceId),
      revisionId: String((review as any).headRevisionId),
      reviewId: String((review as any).reviewId),
      recipientUserId: String((review as any).ownerUserId),
      actorUserId: input.viewer.userId,
      unresolvedThreadCount: Number((review as any).unresolvedThreadCount || 0),
      baseRevisionId: String((review as any).baseRevisionId),
      headRevisionId: String((review as any).headRevisionId),
    });

    return this.getReviewDetail(String((review as any).reviewId), input.viewer);
  }

  async closeReview(input: {
    reviewId: string;
    viewer: RequestUser;
  }) {
    const review = await this.reviewModel.findOne({ reviewId: input.reviewId }).exec();
    if (!review) {
      throw new NotFoundException('Change review not found');
    }
    if ((review as any).status !== 'open') {
      throw new BadRequestException('Only open reviews can be closed');
    }
    if (String((review as any).reviewerUserId) !== input.viewer.userId) {
      throw new ForbiddenException('Only the reviewer may close this review');
    }

    const now = new Date();
    (review as any).status = 'closed';
    (review as any).closedAt = now;
    (review as any).closedByUserId = input.viewer.userId;
    (review as any).closedReason = 'completed';
    (review as any).lastActivityAt = now;
    await review.save();
    return { ok: true };
  }

  async withdrawReview(input: {
    reviewId: string;
    viewer: RequestUser;
  }) {
    const review = await this.reviewModel.findOne({ reviewId: input.reviewId }).exec();
    if (!review) {
      throw new NotFoundException('Change review not found');
    }
    if (!['draft', 'open'].includes(String((review as any).status))) {
      throw new BadRequestException('Only active reviews can be withdrawn');
    }
    if (String((review as any).reviewerUserId) !== input.viewer.userId) {
      throw new ForbiddenException('Only the reviewer may withdraw this review');
    }

    const now = new Date();
    (review as any).status = 'withdrawn';
    (review as any).closedAt = now;
    (review as any).closedByUserId = input.viewer.userId;
    (review as any).closedReason = 'withdrawn';
    (review as any).lastActivityAt = now;
    await review.save();
    return { ok: true };
  }

  private async buildReviewDetail(review: any, work: any, source: any, viewer: RequestUser) {
    const participantIds = Array.from(
      new Set(
        [review.reviewerUserId, review.ownerUserId, ...(review.participantUserIds || [])].filter(Boolean),
      ),
    );
    const userIdToUsername = await this.loadUsernames(participantIds);
    const threadCounts = await this.threadModel.aggregate([
      { $match: { reviewId: review.reviewId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const openThreads = Number(threadCounts.find((item) => item._id === 'open')?.count || 0);
    const resolvedThreads = Number(threadCounts.find((item) => item._id === 'resolved')?.count || 0);

    return {
      reviewId: review.reviewId,
      workId: review.workId,
      sourceId: review.sourceId,
      branchName: review.branchName,
      baseRevisionId: review.baseRevisionId,
      headRevisionId: review.headRevisionId,
      baseSequenceNumber: review.baseSequenceNumber,
      headSequenceNumber: review.headSequenceNumber,
      reviewerUserId: review.reviewerUserId,
      reviewerUsername: userIdToUsername.get(review.reviewerUserId),
      ownerUserId: review.ownerUserId,
      ownerUsername: userIdToUsername.get(review.ownerUserId),
      participantUserIds: review.participantUserIds || [],
      participants: participantIds.map((userId) => ({
        userId,
        username: userIdToUsername.get(userId),
      })),
      title: review.title,
      summary: review.summary,
      status: review.status,
      unresolvedThreadCount: review.unresolvedThreadCount,
      openThreadCount: openThreads,
      resolvedThreadCount: resolvedThreads,
      submittedAt: review.submittedAt,
      closedAt: review.closedAt,
      closedByUserId: review.closedByUserId,
      closedReason: review.closedReason,
      lastActivityAt: review.lastActivityAt,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      work: {
        workId: work.workId,
        title: work.title,
        composer: work.composer,
      },
      source: {
        sourceId: source.sourceId,
        label: source.label,
        sourceType: source.sourceType,
      },
      permissions: {
        canRead: true,
        canEditDraft: review.status === 'draft' && review.reviewerUserId === viewer.userId,
        canAddThread:
          (review.status === 'draft' && review.reviewerUserId === viewer.userId)
          || (review.status === 'open' && this.canCreateTopLevelThread(review, viewer)),
        canSubmit: review.status === 'draft' && review.reviewerUserId === viewer.userId,
        canClose: review.status === 'open' && review.reviewerUserId === viewer.userId,
        canWithdraw:
          ['draft', 'open'].includes(String(review.status)) && review.reviewerUserId === viewer.userId,
        canReply: review.status === 'open' && this.canParticipateInOpenReview(review, viewer),
        canResolve: review.status === 'open' && this.canParticipateInOpenReview(review, viewer),
      },
    };
  }

  private async buildThreadViews(reviewId: string) {
    const [threads, comments] = await Promise.all([
      this.threadModel.find({ reviewId }).sort({ createdAt: 1 }).lean().exec(),
      this.commentModel
        .find({ reviewId, deleted: { $ne: true } })
        .sort({ createdAt: 1 })
        .lean()
        .exec(),
    ]);
    const userIds = Array.from(
      new Set(
        [
          ...threads.map((thread: any) => String(thread.createdByUserId)),
          ...comments.map((comment: any) => String(comment.userId)),
          ...threads.map((thread: any) => String(thread.resolvedByUserId || '')).filter(Boolean),
        ],
      ),
    );
    const userIdToUsername = await this.loadUsernames(userIds);
    const commentsByThreadId = new Map<string, any[]>();
    for (const comment of comments) {
      const list = commentsByThreadId.get(String((comment as any).threadId)) || [];
      list.push({
        commentId: (comment as any).commentId,
        userId: (comment as any).userId,
        username: userIdToUsername.get(String((comment as any).userId)),
        content: (comment as any).content,
        createdAt: (comment as any).createdAt,
        editedAt: (comment as any).editedAt,
      });
      commentsByThreadId.set(String((comment as any).threadId), list);
    }
    return threads.map((thread: any) => ({
      threadId: thread.threadId,
      reviewId: thread.reviewId,
      status: thread.status,
      fileKind: thread.fileKind,
      diffAnchor: thread.diffAnchor,
      createdByUserId: thread.createdByUserId,
      createdByUsername: userIdToUsername.get(String(thread.createdByUserId)),
      resolvedAt: thread.resolvedAt,
      resolvedByUserId: thread.resolvedByUserId,
      resolvedByUsername: thread.resolvedByUserId ? userIdToUsername.get(String(thread.resolvedByUserId)) : undefined,
      comments: commentsByThreadId.get(String(thread.threadId)) || [],
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    }));
  }

  private async loadRevisionPair(input: {
    workId: string;
    sourceId: string;
    baseRevisionId: string;
    headRevisionId: string;
    viewer: RequestUser;
  }) {
    const viewerIsAdmin = this.isAdmin(input.viewer);
    const [work, source, baseRevision, headRevision] = await Promise.all([
      this.workModel.findOne({ workId: input.workId }).select('workId title composer').lean().exec(),
      this.sourceModel.findOne({ workId: input.workId, sourceId: input.sourceId }).lean().exec(),
      this.sourceRevisionModel
        .findOne({ workId: input.workId, sourceId: input.sourceId, revisionId: input.baseRevisionId })
        .lean()
        .exec(),
      this.sourceRevisionModel
        .findOne({ workId: input.workId, sourceId: input.sourceId, revisionId: input.headRevisionId })
        .lean()
        .exec(),
    ]);

    if (!work) {
      throw new NotFoundException(`Work ${input.workId} not found`);
    }
    if (!source) {
      throw new NotFoundException('Source not found');
    }
    if (!baseRevision || !headRevision) {
      throw new NotFoundException('Revision pair not found');
    }
    if (!this.canViewerAccessRevision(baseRevision as any, input.viewer, viewerIsAdmin)) {
      throw new NotFoundException(`Revision ${input.baseRevisionId} not found`);
    }
    if (!this.canViewerAccessRevision(headRevision as any, input.viewer, viewerIsAdmin)) {
      throw new NotFoundException(`Revision ${input.headRevisionId} not found`);
    }
    if (Number((baseRevision as any).sequenceNumber || 0) >= Number((headRevision as any).sequenceNumber || 0)) {
      throw new BadRequestException('baseRevisionId must be older than headRevisionId');
    }

    return { work, source, baseRevision, headRevision };
  }

  private async getReadableReview(reviewId: string, viewer: RequestUser) {
    const review = await this.reviewModel.findOne({ reviewId }).lean().exec();
    if (!review) {
      throw new NotFoundException('Change review not found');
    }
    this.assertCanReadReview(review as any, viewer);
    return review;
  }

  private async resolveOwnerUserId(input: {
    explicitOwnerUserId?: string;
    workId: string;
    sourceId: string;
    branchName: string;
    headRevision: RevisionLike;
    source: any;
  }) {
    if (input.explicitOwnerUserId) {
      return input.explicitOwnerUserId;
    }
    if (input.headRevision.createdBy && input.headRevision.createdBy !== 'system') {
      return String(input.headRevision.createdBy);
    }
    const branch = await this.sourceBranchModel
      .findOne({ workId: input.workId, sourceId: input.sourceId, name: input.branchName })
      .select('ownerUserId')
      .lean()
      .exec();
    if (branch?.ownerUserId) {
      return String(branch.ownerUserId);
    }
    const uploader = input.source?.provenance?.uploadedByUserId;
    if (uploader) {
      return String(uploader);
    }
    return undefined;
  }

  private assertCanReadReview(review: any, viewer: RequestUser) {
    if (review.status === 'draft') {
      if (review.reviewerUserId !== viewer.userId) {
        throw new NotFoundException('Change review not found');
      }
      return;
    }
    const participantUserIds = new Set<string>([
      review.reviewerUserId,
      review.ownerUserId,
      ...(review.participantUserIds || []),
    ]);
    if (participantUserIds.has(viewer.userId) || this.isAdmin(viewer)) {
      return;
    }
    throw new NotFoundException('Change review not found');
  }

  private assertCanMutateReview(
    review: any,
    viewer: RequestUser,
    options: { allowNewThreads: boolean },
  ) {
    if (review.status === 'draft') {
      if (review.reviewerUserId !== viewer.userId) {
        throw new ForbiddenException('Only the reviewer may modify a draft review');
      }
      return;
    }
    if (review.status !== 'open') {
      throw new ForbiddenException('Review is not editable');
    }
    const isParticipant = this.canParticipateInOpenReview(review, viewer) || this.isAdmin(viewer);
    if (!isParticipant) {
      throw new ForbiddenException('You do not have access to modify this review');
    }
    if (options.allowNewThreads && !this.canCreateTopLevelThread(review, viewer)) {
      throw new ForbiddenException('You do not have access to create top-level threads on this review');
    }
  }

  private canParticipateInOpenReview(review: any, viewer: RequestUser) {
    return review.reviewerUserId === viewer.userId
      || review.ownerUserId === viewer.userId
      || (review.participantUserIds || []).includes(viewer.userId);
  }

  private canCreateTopLevelThread(review: any, viewer: RequestUser) {
    return this.isAdmin(viewer)
      || review.reviewerUserId === viewer.userId
      || review.ownerUserId === viewer.userId;
  }

  private canViewerAccessRevision(revision: RevisionLike, viewer?: RequestUser, viewerIsAdmin?: boolean): boolean {
    const isAdmin = viewerIsAdmin ?? this.isAdmin(viewer);
    const visibility = (revision.visibility || 'public') as string;
    if (visibility !== 'public' && !isAdmin) {
      return false;
    }
    const status = revision.status || 'approved';
    if (status === 'approved') {
      return true;
    }
    if (isAdmin) {
      return true;
    }
    if (viewer?.userId && viewer.userId === String(revision.createdBy || '')) {
      return true;
    }
    const ownerUserId = revision.approval?.ownerUserId;
    if (ownerUserId && viewer?.userId === ownerUserId) {
      return true;
    }
    return false;
  }

  private resolveBranchName(revision: RevisionLike): string {
    const raw = String(revision.branchName || revision.fossilBranch || 'trunk').trim();
    if (!raw) return 'trunk';
    return raw.toLowerCase() === 'main' ? 'trunk' : raw;
  }

  private isAdmin(viewer?: RequestUser) {
    return Boolean(viewer?.roles?.includes('admin'));
  }

  private async loadUsernames(userIds: string[]) {
    const map = new Map<string, string>();
    for (const userId of userIds) {
      if (!userId || map.has(userId)) continue;
      try {
        const user = await this.usersService.findById(userId);
        if (user) {
          map.set(userId, user.username || user.email || user.displayName || 'Unknown');
        }
      } catch {
        // ignore per-user failures
      }
    }
    return map;
  }

  private async syncReviewCounters(reviewId: string, activityAt: Date) {
    const openThreadCount = await this.threadModel.countDocuments({ reviewId, status: 'open' }).exec();
    await this.reviewModel
      .updateOne(
        { reviewId },
        {
          $set: {
            unresolvedThreadCount: openThreadCount,
            lastActivityAt: activityAt,
          },
        },
      )
      .exec();
  }

  private async generateUnifiedDiff(aLoc: { bucket: string; objectKey: string }, bLoc: { bucket: string; objectKey: string }) {
    const [bufA, bufB] = await Promise.all([
      this.storageService.getObjectBuffer(aLoc.bucket, aLoc.objectKey),
      this.storageService.getObjectBuffer(bLoc.bucket, bLoc.objectKey),
    ]);
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    const tmp = await import('node:os');
    const fsPromises = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = await fsPromises.mkdtemp(path.join(tmp.tmpdir(), 'ots-crdiff-'));
    try {
      const pA = path.join(dir, 'a.xml');
      const pB = path.join(dir, 'b.xml');
      await fsPromises.writeFile(pA, bufA);
      await fsPromises.writeFile(pB, bufB);
      try {
        const { stdout } = await execAsync(`diff -u ${pA} ${pB}`);
        return stdout || '(no differences)\n';
      } catch (error: any) {
        if (error && error.stdout) {
          return String(error.stdout);
        }
        throw error;
      }
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async buildScoreRegions(aLoc: { bucket: string; objectKey: string }, bLoc: { bucket: string; objectKey: string }) {
    const [bufA, bufB] = await Promise.all([
      this.storageService.getObjectBuffer(aLoc.bucket, aLoc.objectKey),
      this.storageService.getObjectBuffer(bLoc.bucket, bLoc.objectKey),
    ]);
    const baseScore = this.extractScoreStructure(bufA.toString('utf8'));
    const headScore = this.extractScoreStructure(bufB.toString('utf8'));
    return this.diffScoreStructures(baseScore, headScore);
  }

  private parseUnifiedDiff(rawDiff: string) {
    const hunks: Array<{
      hunkId: string;
      header: string;
      lines: Array<{
        anchorId: string;
        type: 'context' | 'add' | 'del';
        side: 'base' | 'head';
        oldLineNumber?: number;
        newLineNumber?: number;
        content: string;
        commentable: boolean;
        lineHash: string;
        hunkHeader: string;
      }>;
    }> = [];

    const lines = String(rawDiff || '').split('\n');
    let currentHunk:
      | {
          hunkId: string;
          header: string;
          lines: Array<{
            anchorId: string;
            type: 'context' | 'add' | 'del';
            side: 'base' | 'head';
            oldLineNumber?: number;
            newLineNumber?: number;
            content: string;
            commentable: boolean;
            lineHash: string;
            hunkHeader: string;
          }>;
        }
      | null = null;
    let oldLine = 0;
    let newLine = 0;

    for (const rawLine of lines) {
      if (rawLine.startsWith('@@')) {
        const match = rawLine.match(/^@@\s+\-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
        if (!match) continue;
        currentHunk = {
          hunkId: this.hashText(`hunk:${rawLine}`),
          header: rawLine,
          lines: [],
        };
        hunks.push(currentHunk);
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
        continue;
      }
      if (!currentHunk) {
        continue;
      }
      if (rawLine.startsWith('\\')) {
        continue;
      }
      const marker = rawLine[0];
      const content = rawLine.slice(1);
      if (marker === ' ') {
        currentHunk.lines.push({
          anchorId: this.hashText(`${currentHunk.header}|context|${oldLine}|${newLine}|${content}`),
          type: 'context',
          side: 'head',
          oldLineNumber: oldLine,
          newLineNumber: newLine,
          content,
          commentable: false,
          lineHash: this.hashText(content),
          hunkHeader: currentHunk.header,
        });
        oldLine += 1;
        newLine += 1;
      } else if (marker === '-') {
        currentHunk.lines.push({
          anchorId: this.hashText(`${currentHunk.header}|del|${oldLine}||${content}`),
          type: 'del',
          side: 'base',
          oldLineNumber: oldLine,
          content,
          commentable: true,
          lineHash: this.hashText(content),
          hunkHeader: currentHunk.header,
        });
        oldLine += 1;
      } else if (marker === '+') {
        currentHunk.lines.push({
          anchorId: this.hashText(`${currentHunk.header}|add||${newLine}|${content}`),
          type: 'add',
          side: 'head',
          newLineNumber: newLine,
          content,
          commentable: true,
          lineHash: this.hashText(content),
          hunkHeader: currentHunk.header,
        });
        newLine += 1;
      }
    }

    return { hunks };
  }

  private findAnchor(
    hunks: Array<{
      lines: Array<{
        anchorId: string;
        type: 'context' | 'add' | 'del';
        side: 'base' | 'head';
        oldLineNumber?: number;
        newLineNumber?: number;
        content: string;
        commentable: boolean;
        lineHash: string;
        hunkHeader: string;
      }>;
    }>,
    anchorId: string,
  ) {
    for (const hunk of hunks) {
      const found = hunk.lines.find((line) => line.anchorId === anchorId);
      if (found) {
        return found;
      }
    }
    return null;
  }

  private hashText(value: string) {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  private extractScoreStructure(xml: string) {
    const cleaned = String(xml || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<print\b[\s\S]*?<\/print>/gi, '')
      .replace(/<layout-break\b[\s\S]*?<\/layout-break>/gi, '')
      .replace(/>\s+</g, '><')
      .trim();
    const scoreBody = cleaned.replace(/<part-list\b[\s\S]*?<\/part-list>/gi, '');

    const partNames = new Map<string, string>();
    const scorePartRegex = /<score-part\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/score-part>/gi;
    let scorePartMatch: RegExpExecArray | null;
    while ((scorePartMatch = scorePartRegex.exec(cleaned))) {
      const [, partId, body] = scorePartMatch;
      const partNameMatch = body.match(/<part-name\b[^>]*>([\s\S]*?)<\/part-name>/i);
      if (partNameMatch) {
        partNames.set(partId, this.stripXmlText(partNameMatch[1]));
      }
    }

    const parts: Array<{
      partId: string;
      partIndex: number;
      partName?: string;
      measures: Array<{ measureIndex: number; measureNumber: string; signature: string }>;
    }> = [];
    const partRegex = /<part\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/part>/gi;
    let partMatch: RegExpExecArray | null;
    let partIndex = 0;
    while ((partMatch = partRegex.exec(scoreBody))) {
      const [, partId, body] = partMatch;
      const measures: Array<{ measureIndex: number; measureNumber: string; signature: string }> = [];
      const measureRegex = /<measure\b([^>]*)>([\s\S]*?)<\/measure>/gi;
      let measureMatch: RegExpExecArray | null;
      let measureIndex = 0;
      while ((measureMatch = measureRegex.exec(body))) {
        const attrs = measureMatch[1] || '';
        const measureBody = measureMatch[2] || '';
        const numberMatch = attrs.match(/\bnumber="([^"]+)"/i);
        measures.push({
          measureIndex,
          measureNumber: (numberMatch?.[1] || `${measureIndex + 1}`).trim(),
          signature: this.hashText(
            measureBody
              .replace(/\s+/g, ' ')
              .replace(/\s+</g, '<')
              .replace(/>\s+/g, '>')
              .trim(),
          ),
        });
        measureIndex += 1;
      }
      parts.push({
        partId,
        partIndex,
        partName: partNames.get(partId),
        measures,
      });
      partIndex += 1;
    }

    return { parts };
  }

  private diffScoreStructures(
    baseScore: {
      parts: Array<{
        partId: string;
        partIndex: number;
        partName?: string;
        measures: Array<{ measureIndex: number; measureNumber: string; signature: string }>;
      }>;
    },
    headScore: {
      parts: Array<{
        partId: string;
        partIndex: number;
        partName?: string;
        measures: Array<{ measureIndex: number; measureNumber: string; signature: string }>;
      }>;
    },
  ) {
    const baseById = new Map(baseScore.parts.map((part) => [part.partId, part]));
    const headById = new Map(headScore.parts.map((part) => [part.partId, part]));
    const orderedPartIds = Array.from(new Set([...headScore.parts.map((part) => part.partId), ...baseScore.parts.map((part) => part.partId)]));
    const regions: Array<{
      anchorId: string;
      partId: string;
      partIndex: number;
      partName?: string;
      side: 'base' | 'head';
      changeType: 'added' | 'removed' | 'modified';
      baseMeasureIndex?: number;
      headMeasureIndex?: number;
      baseMeasureNumber?: string;
      headMeasureNumber?: string;
      label: string;
      summary: string;
      commentable: boolean;
      regionHash: string;
    }> = [];

    for (const partId of orderedPartIds) {
      const basePart = baseById.get(partId);
      const headPart = headById.get(partId);
      const baseMeasures = basePart?.measures || [];
      const headMeasures = headPart?.measures || [];
      const partName = headPart?.partName || basePart?.partName;
      const partIndex = headPart?.partIndex ?? basePart?.partIndex ?? 0;
      const maxLength = Math.max(baseMeasures.length, headMeasures.length);

      for (let index = 0; index < maxLength; index += 1) {
        const baseMeasure = baseMeasures[index];
        const headMeasure = headMeasures[index];
        const changed =
          !baseMeasure ||
          !headMeasure ||
          baseMeasure.signature !== headMeasure.signature ||
          baseMeasure.measureNumber !== headMeasure.measureNumber;
        if (!changed) {
          continue;
        }

        const changeType = !baseMeasure ? 'added' : !headMeasure ? 'removed' : 'modified';
        const side = changeType === 'removed' ? 'base' : 'head';
        const measureNumber = headMeasure?.measureNumber || baseMeasure?.measureNumber || `${index + 1}`;
        const label = `${partName || `Part ${partIndex + 1}`} - m. ${measureNumber}`;
        const summary = changeType === 'added' ? `Added ${label}` : changeType === 'removed' ? `Removed ${label}` : `Changed ${label}`;
        const regionHash = this.hashText(`${partId}|${index}|${baseMeasure?.signature || ''}|${headMeasure?.signature || ''}|${changeType}`);
        regions.push({
          anchorId: this.hashText(`score-region|${partId}|${index}|${baseMeasure?.measureNumber || ''}|${headMeasure?.measureNumber || ''}|${regionHash}`),
          partId,
          partIndex,
          partName,
          side,
          changeType,
          baseMeasureIndex: baseMeasure?.measureIndex,
          headMeasureIndex: headMeasure?.measureIndex,
          baseMeasureNumber: baseMeasure?.measureNumber,
          headMeasureNumber: headMeasure?.measureNumber,
          label,
          summary,
          commentable: true,
          regionHash,
        });
      }
    }

    return regions;
  }

  private stripXmlText(value: string) {
    return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}
