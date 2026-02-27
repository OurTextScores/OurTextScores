import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AnalyticsService } from '../analytics/analytics.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import type { RequestUser } from '../auth/types/auth-user';
import { WorksService } from './works.service';

@ApiTags('works')
@Controller('works')
export class WorksEngagementController {
  constructor(
    private readonly worksService: WorksService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  @Post(':workId/sources/:sourceId/revisions/:revisionId/approve')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Approve a revision',
    description:
      'Approve a pending revision (for branches with owner_approval policy). Requires authentication and ownership permissions.',
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID to approve' })
  @ApiResponse({ status: 200, description: 'Revision approved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - user is not the branch owner' })
  @ApiResponse({ status: 404, description: 'Revision not found' })
  approveRevision(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Param('revisionId') revisionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.worksService.approveRevision(workId, sourceId, revisionId, {
      userId: user.userId,
      roles: user.roles,
    });
  }

  @Post(':workId/sources/:sourceId/revisions/:revisionId/reject')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Reject a revision',
    description:
      'Reject a pending revision (for branches with owner_approval policy). Requires authentication and ownership permissions.',
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID to reject' })
  @ApiResponse({ status: 200, description: 'Revision rejected successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - user is not the branch owner' })
  @ApiResponse({ status: 404, description: 'Revision not found' })
  rejectRevision(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Param('revisionId') revisionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.worksService.rejectRevision(workId, sourceId, revisionId, {
      userId: user.userId,
      roles: user.roles,
    });
  }

  @Post(':workId/sources/:sourceId/revisions/:revisionId/rate')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Rate a revision',
    description: 'Submit a 1-5 star rating for a revision. One rating per user per revision.',
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID to rate' })
  @ApiResponse({ status: 200, description: 'Rating submitted successfully' })
  @ApiResponse({ status: 400, description: 'Invalid rating or user already rated' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 404, description: 'Revision not found' })
  async rateRevision(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Param('revisionId') revisionId: string,
    @Body() body: { rating: number },
    @CurrentUser() user: RequestUser,
    @Req() req?: Request,
  ) {
    const isAdmin = user?.roles?.includes('admin') ?? false;
    const result = await this.worksService.rateRevision(
      workId,
      sourceId,
      revisionId,
      user.userId,
      body.rating,
      isAdmin,
    );
    if (req) {
      await this.analyticsService.trackBestEffort({
        eventName: 'revision_rated',
        actor: this.analyticsService.toActor(user),
        requestContext: this.analyticsService.getRequestContext(req, {
          sourceApp: 'backend',
          route: req.originalUrl ?? req.url,
        }),
        properties: {
          work_id: workId,
          source_id: sourceId,
          revision_id: revisionId,
          rating_value: body.rating,
        },
      });
    }
    return result;
  }

  @Get(':workId/sources/:sourceId/revisions/:revisionId/ratings')
  @ApiOperation({
    summary: 'Get rating histogram',
    description:
      'Get rating distribution (histogram) for a revision, showing user and admin counts per star level',
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID' })
  @ApiResponse({ status: 200, description: 'Rating histogram returned' })
  @ApiResponse({ status: 404, description: 'Revision not found' })
  async getRevisionRatings(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Param('revisionId') revisionId: string,
  ) {
    return this.worksService.getRevisionRatings(workId, sourceId, revisionId);
  }

  @Get(':workId/sources/:sourceId/revisions/:revisionId/ratings/check')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Check if user has rated',
    description: 'Check if the current user has already rated this revision',
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID' })
  @ApiResponse({ status: 200, description: 'Returns { hasRated: boolean }' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  async checkUserRating(@Param('revisionId') revisionId: string, @CurrentUser() user: RequestUser) {
    const hasRated = await this.worksService.hasUserRatedRevision(revisionId, user.userId);
    return { hasRated };
  }

  @Post(':workId/sources/:sourceId/revisions/:revisionId/comments')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Create a comment',
    description: 'Post a comment on a revision or reply to an existing comment',
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID' })
  @ApiResponse({ status: 201, description: 'Comment created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid content or parent comment not found' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 404, description: 'Revision not found' })
  async createComment(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Param('revisionId') revisionId: string,
    @Body() body: { content: string; parentCommentId?: string },
    @CurrentUser() user: RequestUser,
    @Req() req?: Request,
  ) {
    const result = await this.worksService.createComment(
      workId,
      sourceId,
      revisionId,
      user.userId,
      body.content,
      body.parentCommentId,
    );
    if (req) {
      await this.analyticsService.trackBestEffort({
        eventName: 'revision_commented',
        actor: this.analyticsService.toActor(user),
        requestContext: this.analyticsService.getRequestContext(req, {
          sourceApp: 'backend',
          route: req.originalUrl ?? req.url,
        }),
        properties: {
          work_id: workId,
          source_id: sourceId,
          revision_id: revisionId,
          is_reply: Boolean(body.parentCommentId),
        },
      });
    }
    return result;
  }

  @Get(':workId/sources/:sourceId/revisions/:revisionId/comments')
  @ApiOperation({
    summary: 'Get comments',
    description: 'Get all comments for a revision (nested structure with vote info for authenticated user)',
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID' })
  @ApiResponse({ status: 200, description: 'Comments retrieved' })
  @ApiResponse({ status: 404, description: 'Revision not found' })
  async getComments(@Param('revisionId') revisionId: string, @CurrentUser() user?: RequestUser) {
    return this.worksService.getComments(revisionId, user?.userId);
  }

  @Patch(':workId/sources/:sourceId/revisions/:revisionId/comments/:commentId')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Update a comment',
    description: 'Edit your own comment',
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID' })
  @ApiParam({ name: 'commentId', description: 'Comment ID' })
  @ApiResponse({ status: 200, description: 'Comment updated' })
  @ApiResponse({ status: 400, description: 'Invalid content' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Not your comment' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async updateComment(
    @Param('commentId') commentId: string,
    @Body() body: { content: string },
    @CurrentUser() user: RequestUser,
  ) {
    return this.worksService.updateComment(commentId, user.userId, body.content);
  }

  @Delete(':workId/sources/:sourceId/revisions/:revisionId/comments/:commentId')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Delete a comment',
    description: 'Delete your own comment (or any comment if admin)',
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID' })
  @ApiParam({ name: 'commentId', description: 'Comment ID' })
  @ApiResponse({ status: 200, description: 'Comment deleted' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Not authorized to delete' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async deleteComment(@Param('commentId') commentId: string, @CurrentUser() user: RequestUser) {
    const isAdmin = user?.roles?.includes('admin') ?? false;
    return this.worksService.deleteComment(commentId, user.userId, isAdmin);
  }

  @Post(':workId/sources/:sourceId/revisions/:revisionId/comments/:commentId/vote')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Vote on a comment',
    description: 'Upvote or downvote a comment (toggle to remove vote)',
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID' })
  @ApiParam({ name: 'commentId', description: 'Comment ID' })
  @ApiResponse({ status: 200, description: 'Vote recorded' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async voteComment(
    @Param('commentId') commentId: string,
    @Body() body: { voteType: 'up' | 'down' },
    @CurrentUser() user: RequestUser,
  ) {
    return this.worksService.voteComment(commentId, user.userId, body.voteType);
  }

  @Post(':workId/sources/:sourceId/revisions/:revisionId/comments/:commentId/flag')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Flag a comment for review',
    description: 'Report a comment as inappropriate or violating guidelines',
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID' })
  @ApiParam({ name: 'commentId', description: 'Comment ID' })
  @ApiResponse({ status: 200, description: 'Comment flagged' })
  @ApiResponse({ status: 400, description: 'Reason required' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async flagComment(
    @Param('commentId') commentId: string,
    @Body() body: { reason: string },
    @CurrentUser() user: RequestUser,
  ) {
    return this.worksService.flagComment(commentId, user.userId, body.reason);
  }

  @Delete(':workId/sources/:sourceId/revisions/:revisionId/comments/:commentId/flag')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Remove flag from comment (admin only)',
    description: 'Clear the flag from a comment',
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID' })
  @ApiParam({ name: 'commentId', description: 'Comment ID' })
  @ApiResponse({ status: 200, description: 'Flag removed' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async unflagComment(@Param('commentId') commentId: string, @CurrentUser() user?: RequestUser) {
    if (!user?.roles?.includes('admin')) {
      throw new ForbiddenException('Admin role required');
    }
    return this.worksService.unflagComment(commentId);
  }
}
