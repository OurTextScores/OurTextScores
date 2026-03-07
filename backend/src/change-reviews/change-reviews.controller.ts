import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import type { RequestUser } from '../auth/types/auth-user';
import { ChangeReviewsService } from './change-reviews.service';

@ApiTags('change-reviews')
@Controller()
export class ChangeReviewsController {
  constructor(private readonly changeReviewsService: ChangeReviewsService) {}

  @Post('works/:workId/sources/:sourceId/branches/:branchName/change-review')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Create or open the branch change review',
    description:
      'Creates the shared change review for a reviewable branch, or returns the existing branch review if one already exists.',
  })
  @ApiParam({ name: 'workId', example: '164349' })
  @ApiParam({ name: 'sourceId', example: 'src-1' })
  @ApiParam({ name: 'branchName', example: 'trunk' })
  @ApiResponse({ status: 201, description: 'Branch change review created or returned' })
  createOrOpenBranchReview(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Param('branchName') branchName: string,
    @Body() body: { ownerUserId?: string; title?: string },
    @CurrentUser() viewer: RequestUser,
  ) {
    return this.changeReviewsService.createOrOpenBranchReview({
      workId,
      sourceId,
      branchName,
      ownerUserId: body.ownerUserId,
      title: body.title,
      opener: viewer,
    });
  }

  @Get('change-reviews')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'List change reviews for current user',
    description: 'Lists change reviews where the current user is the reviewer, owner, or a participant.',
  })
  @ApiQuery({ name: 'role', required: false, enum: ['reviewer', 'owner', 'all'] })
  @ApiQuery({ name: 'status', required: false, enum: ['draft', 'open', 'closed', 'withdrawn', 'all'] })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  listReviews(
    @CurrentUser() viewer: RequestUser,
    @Query('role') role?: 'reviewer' | 'owner' | 'all',
    @Query('status') status?: 'draft' | 'open' | 'closed' | 'withdrawn' | 'all',
    @Query('limit') limit?: string,
  ) {
    return this.changeReviewsService.listReviews({
      viewer,
      role,
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('change-reviews/:reviewId')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Get change review detail',
    description: 'Returns review metadata and permissions for the current user.',
  })
  @ApiParam({ name: 'reviewId', example: 'a245d562-7f9d-4b1c-8269-23ccfcab4e1b' })
  @ApiResponse({ status: 200, description: 'Change review detail returned' })
  getReviewDetail(@Param('reviewId') reviewId: string, @CurrentUser() viewer: RequestUser) {
    return this.changeReviewsService.getReviewDetail(reviewId, viewer);
  }

  @Get('change-reviews/:reviewId/diff')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Get structured diff for a change review',
    description: 'Returns structured canonical XML diff hunks and attached review threads.',
  })
  @ApiParam({ name: 'reviewId', example: 'a245d562-7f9d-4b1c-8269-23ccfcab4e1b' })
  @ApiQuery({ name: 'patchset', required: false, description: 'Patchset number to diff (defaults to latest)' })
  getReviewDiff(
    @Param('reviewId') reviewId: string,
    @Query('patchset') patchset: string | undefined,
    @CurrentUser() viewer: RequestUser,
  ) {
    const patchsetNumber = patchset ? Number(patchset) : undefined;
    return this.changeReviewsService.getReviewDiff(reviewId, viewer, patchsetNumber);
  }

  @Post('change-reviews/:reviewId/threads')
  @UseGuards(AuthRequiredGuard)
  createThread(
    @Param('reviewId') reviewId: string,
    @Body() body: { anchorId: string; content: string },
    @CurrentUser() viewer: RequestUser,
  ) {
    return this.changeReviewsService.createThread({
      reviewId,
      anchorId: body.anchorId,
      content: body.content,
      viewer,
    });
  }

  @Post('change-reviews/:reviewId/threads/:threadId/comments')
  @UseGuards(AuthRequiredGuard)
  addThreadComment(
    @Param('reviewId') reviewId: string,
    @Param('threadId') threadId: string,
    @Body() body: { content: string },
    @CurrentUser() viewer: RequestUser,
  ) {
    return this.changeReviewsService.addThreadComment({
      reviewId,
      threadId,
      content: body.content,
      viewer,
    });
  }

  @Patch('change-reviews/:reviewId/comments/:commentId')
  @UseGuards(AuthRequiredGuard)
  updateComment(
    @Param('reviewId') reviewId: string,
    @Param('commentId') commentId: string,
    @Body() body: { content: string },
    @CurrentUser() viewer: RequestUser,
  ) {
    return this.changeReviewsService.updateComment({
      reviewId,
      commentId,
      content: body.content,
      viewer,
    });
  }

  @Delete('change-reviews/:reviewId/comments/:commentId')
  @UseGuards(AuthRequiredGuard)
  deleteComment(
    @Param('reviewId') reviewId: string,
    @Param('commentId') commentId: string,
    @CurrentUser() viewer: RequestUser,
  ) {
    return this.changeReviewsService.deleteComment({
      reviewId,
      commentId,
      viewer,
    });
  }

  @Patch('change-reviews/:reviewId/threads/:threadId')
  @UseGuards(AuthRequiredGuard)
  updateThreadStatus(
    @Param('reviewId') reviewId: string,
    @Param('threadId') threadId: string,
    @Body() body: { status: 'open' | 'resolved' },
    @CurrentUser() viewer: RequestUser,
  ) {
    return this.changeReviewsService.updateThreadStatus({
      reviewId,
      threadId,
      status: body.status,
      viewer,
    });
  }

  @Post('change-reviews/:reviewId/submit')
  @UseGuards(AuthRequiredGuard)
  submitReview(
    @Param('reviewId') reviewId: string,
    @Body() body: { summary?: string },
    @CurrentUser() viewer: RequestUser,
  ) {
    return this.changeReviewsService.submitReview({
      reviewId,
      summary: body.summary,
      viewer,
    });
  }

  @Post('change-reviews/:reviewId/close')
  @UseGuards(AuthRequiredGuard)
  closeReview(@Param('reviewId') reviewId: string, @CurrentUser() viewer: RequestUser) {
    return this.changeReviewsService.closeReview({ reviewId, viewer });
  }

  @Post('change-reviews/:reviewId/reopen')
  @UseGuards(AuthRequiredGuard)
  reopenReview(@Param('reviewId') reviewId: string, @CurrentUser() viewer: RequestUser) {
    return this.changeReviewsService.reopenReview({ reviewId, viewer });
  }

  @Post('change-reviews/:reviewId/withdraw')
  @UseGuards(AuthRequiredGuard)
  withdrawReview(@Param('reviewId') reviewId: string, @CurrentUser() viewer: RequestUser) {
    return this.changeReviewsService.withdrawReview({ reviewId, viewer });
  }
}
