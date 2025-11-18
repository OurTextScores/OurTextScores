import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ImslpService } from './imslp.service';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBody, ApiParam } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

@ApiTags('imslp')
@Controller('imslp')
export class ImslpController {
  constructor(private readonly imslpService: ImslpService) {}

  @Get('search')
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // 10 searches per minute (anon), 30 for auth, 100 for admin
  @ApiTags('search', 'imslp')
  @ApiOperation({
    summary: 'Search IMSLP',
    description: 'Search for musical works in the IMSLP (International Music Score Library Project) database'
  })
  @ApiQuery({ name: 'q', required: true, description: 'Search query', example: 'Bach Prelude' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum results (1-25, default: 10)', example: 10 })
  @ApiResponse({ status: 200, description: 'Search results returned' })
  search(@Query('q') query = '', @Query('limit') limit?: string) {
    const numericLimit = limit ? Number.parseInt(limit, 10) || 10 : 10;
    return this.imslpService.search(query, Math.max(1, Math.min(numericLimit, 25)));
  }

  @Post('by-url')
  @ApiOperation({
    summary: 'Import work by IMSLP URL',
    description: 'Import a work from IMSLP by providing the permalink URL'
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', example: 'https://imslp.org/wiki/Special:ReverseLookup/164349', description: 'IMSLP permalink URL' }
      }
    }
  })
  @ApiResponse({ status: 200, description: 'Work imported successfully' })
  @ApiResponse({ status: 400, description: 'Invalid URL' })
  ensureByUrl(@Body('url') url: string) {
    return this.imslpService.ensureByPermalink(url);
  }

  @Get('works/:workId')
  @ApiOperation({
    summary: 'Get work from IMSLP',
    description: 'Fetch work metadata from IMSLP by page_id'
  })
  @ApiParam({ name: 'workId', description: 'IMSLP page_id', example: '164349' })
  @ApiResponse({ status: 200, description: 'Work metadata retrieved' })
  @ApiResponse({ status: 404, description: 'Work not found in IMSLP' })
  findByWorkId(@Param('workId') workId: string) {
    return this.imslpService.ensureByWorkId(workId);
  }

  @Post('works/:workId/refresh')
  @ApiOperation({
    summary: 'Refresh work metadata from IMSLP',
    description: 'Force refresh of work metadata from IMSLP, enriching with latest information'
  })
  @ApiParam({ name: 'workId', description: 'IMSLP page_id', example: '164349' })
  @ApiResponse({ status: 200, description: 'Work metadata refreshed' })
  async refreshByWorkId(@Param('workId') workId: string) {
    const enriched = await this.imslpService.enrichByWorkId(workId);
    if (enriched?.workId) {
      return this.imslpService.ensureByWorkId(enriched.workId);
    }
    return this.imslpService.ensureByWorkId(workId);
  }

  @Get('works/:workId/raw')
  @ApiOperation({
    summary: 'Get raw IMSLP data',
    description: 'Get the raw cached IMSLP data for a work (for debugging)'
  })
  @ApiParam({ name: 'workId', description: 'IMSLP page_id', example: '164349' })
  @ApiResponse({ status: 200, description: 'Raw IMSLP data returned' })
  async findRawByWorkId(@Param('workId') workId: string) {
    const doc = await this.imslpService.getRawByWorkId(workId);
    return doc;
  }
}
