import { Controller, Get, Param, Post, Delete, UseGuards } from '@nestjs/common';
import { WatchesService } from './watches.service';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { AuthOptionalGuard } from '../auth/guards/auth-optional.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types/auth-user';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';

@ApiTags('watches')
@Controller('works/:workId/sources/:sourceId')
export class WatchesController {
  constructor(private readonly watches: WatchesService) {}

  @Post('watch')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Watch a source',
    description: 'Subscribe to notifications for changes to this source. Requires authentication.'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiResponse({ status: 200, description: 'Successfully subscribed', schema: { type: 'object', properties: { ok: { type: 'boolean', example: true } } } })
  @ApiResponse({ status: 401, description: 'Unauthorized - authentication required' })
  async watch(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: RequestUser
  ) {
    await this.watches.subscribe(user.userId, workId, sourceId);
    return { ok: true };
  }

  @Delete('watch')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Unwatch a source',
    description: 'Unsubscribe from notifications for this source. Requires authentication.'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiResponse({ status: 200, description: 'Successfully unsubscribed', schema: { type: 'object', properties: { ok: { type: 'boolean', example: true } } } })
  @ApiResponse({ status: 401, description: 'Unauthorized - authentication required' })
  async unwatch(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: RequestUser
  ) {
    await this.watches.unsubscribe(user.userId, workId, sourceId);
    return { ok: true };
  }

  @Get('watchers/count')
  @UseGuards(AuthOptionalGuard)
  @ApiOperation({
    summary: 'Get watch count and status',
    description: 'Returns the number of users watching this source and whether the current user is subscribed'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiResponse({
    status: 200,
    description: 'Watch status retrieved',
    schema: {
      type: 'object',
      properties: {
        count: { type: 'number', example: 5, description: 'Number of watchers' },
        subscribed: { type: 'boolean', example: true, description: 'Whether current user is subscribed' }
      }
    }
  })
  async count(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user?: RequestUser
  ) {
    const [count, subscribed] = await Promise.all([
      this.watches.count(workId, sourceId),
      user?.userId ? this.watches.isSubscribed(user.userId, workId, sourceId) : Promise.resolve(false)
    ]);
    return { count, subscribed };
  }
}

