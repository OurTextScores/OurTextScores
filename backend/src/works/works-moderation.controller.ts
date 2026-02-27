import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import type { RequestUser } from '../auth/types/auth-user';
import { WorksService } from './works.service';

@ApiTags('works')
@Controller('works')
export class WorksModerationController {
  constructor(private readonly worksService: WorksService) {}

  @Post(':workId/sources/:sourceId/migrate')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Migrate source to a new work (admin only)',
    description: 'Move a source and all associated data to a new work by IMSLP URL. Creates the work if needed.',
  })
  @ApiParam({ name: 'workId', description: 'Current Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        imslpUrl: { type: 'string', description: 'IMSLP permalink or slug URL for the target work' },
      },
      required: ['imslpUrl'],
    },
  })
  @ApiResponse({ status: 200, description: 'Migration completed' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  @ApiResponse({ status: 404, description: 'Source not found' })
  async migrateSource(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Body('imslpUrl') imslpUrl: string,
    @CurrentUser() user?: RequestUser,
  ) {
    if (!user?.roles?.includes('admin')) {
      throw new ForbiddenException('Admin role required');
    }
    if (!imslpUrl || !imslpUrl.trim()) {
      throw new BadRequestException('imslpUrl is required');
    }
    return this.worksService.migrateSourceToWorkByImslpUrl(workId, sourceId, imslpUrl.trim(), {
      userId: user.userId,
      roles: user.roles,
    });
  }

  @Get('admin/flagged-comments')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Get all flagged comments (admin only)',
    description: 'Retrieve all flagged comments for moderation dashboard',
  })
  @ApiResponse({ status: 200, description: 'List of flagged comments with context' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  async getFlaggedComments(@CurrentUser() user?: RequestUser) {
    if (!user?.roles?.includes('admin')) {
      throw new ForbiddenException('Admin role required');
    }
    return this.worksService.getFlaggedComments();
  }

  @Get('admin/flagged-sources')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Get all flagged sources (admin only)',
    description: 'Retrieve all flagged sources for moderation and legal review.',
  })
  @ApiResponse({ status: 200, description: 'List of flagged sources with context' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  async getFlaggedSources(@CurrentUser() user?: RequestUser) {
    if (!user?.roles?.includes('admin')) {
      throw new ForbiddenException('Admin role required');
    }
    return this.worksService.getFlaggedSources();
  }

  @Post(':workId/sources/:sourceId/verify')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Verify source (admin only)',
    description: 'Mark a source as verified/valid transcription',
  })
  @ApiParam({ name: 'workId', description: 'Work ID' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Optional verification note' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Source verified successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Source not found' })
  async verifySource(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Body() body: { note?: string },
    @CurrentUser() user?: RequestUser,
  ) {
    if (!user?.roles?.includes('admin')) {
      throw new ForbiddenException('Admin role required');
    }
    return this.worksService.verifySource(workId, sourceId, user.userId, body.note);
  }

  @Delete(':workId/sources/:sourceId/verify')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Remove verification (admin only)',
    description: 'Remove verification from a source',
  })
  @ApiParam({ name: 'workId', description: 'Work ID' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiResponse({ status: 200, description: 'Verification removed successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Source not found' })
  async removeVerification(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user?: RequestUser,
  ) {
    if (!user?.roles?.includes('admin')) {
      throw new ForbiddenException('Admin role required');
    }
    return this.worksService.removeVerification(workId, sourceId);
  }

  @Post(':workId/sources/:sourceId/flag')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Flag source for deletion',
    description: 'Mark a source as problematic/should be deleted. Any authenticated user can flag sources.',
  })
  @ApiParam({ name: 'workId', description: 'Work ID' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string', description: 'Reason for flagging' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Source flagged successfully' })
  @ApiResponse({ status: 400, description: 'Reason required' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 404, description: 'Source not found' })
  async flagSource(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Body() body: { reason: string },
    @CurrentUser() user?: RequestUser,
  ) {
    if (!body.reason?.trim()) {
      throw new BadRequestException('Reason is required');
    }
    return this.worksService.flagSource(workId, sourceId, user.userId, body.reason);
  }

  @Delete(':workId/sources/:sourceId/flag')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Remove flag (admin only)',
    description: 'Remove deletion flag from a source',
  })
  @ApiParam({ name: 'workId', description: 'Work ID' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiResponse({ status: 200, description: 'Flag removed successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Source not found' })
  async removeFlag(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user?: RequestUser,
  ) {
    if (!user?.roles?.includes('admin')) {
      throw new ForbiddenException('Admin role required');
    }
    return this.worksService.removeFlag(workId, sourceId);
  }
}
