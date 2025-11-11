/*
 * Copyright (C) 2025 OurTextScores Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { SearchService } from './search.service';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get('works')
  @ApiOperation({
    summary: 'Search for works',
    description: 'Search for music works using MeiliSearch full-text search. Searches across title, composer, catalog number, and work ID.'
  })
  @ApiQuery({
    name: 'q',
    required: true,
    description: 'Search query string',
    example: 'Bach Cello Suite'
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Maximum number of results (default: 20, max: 100)',
    example: 20
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Number of results to skip for pagination (default: 0)',
    example: 0
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    description: 'Sort by field (e.g., "latestRevisionAt:desc" or "sourceCount:asc")',
    example: 'latestRevisionAt:desc'
  })
  @ApiResponse({
    status: 200,
    description: 'Search results returned successfully',
    schema: {
      type: 'object',
      properties: {
        hits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              workId: { type: 'string', example: '164349' },
              title: { type: 'string', example: 'Cello Suite No.1 in G major' },
              composer: { type: 'string', example: 'Bach, Johann Sebastian' },
              catalogNumber: { type: 'string', example: 'BWV 1007' },
              sourceCount: { type: 'number', example: 4 },
              availableFormats: {
                type: 'array',
                items: { type: 'string' },
                example: ['application/vnd.recordare.musicxml', 'application/xml']
              },
              latestRevisionAt: { type: 'number', example: 1699564800000 }
            }
          }
        },
        estimatedTotalHits: { type: 'number', example: 42 },
        processingTimeMs: { type: 'number', example: 15 },
        query: { type: 'string', example: 'Bach' }
      }
    }
  })
  async searchWorks(
    @Query('q') query: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('sort') sort?: string
  ) {
    const parsedLimit = limit ? Math.min(parseInt(limit, 10), 100) : 20;
    const parsedOffset = offset ? parseInt(offset, 10) : 0;
    const sortArray = sort ? [sort] : undefined;

    return this.searchService.searchWorks(query || '', {
      limit: parsedLimit,
      offset: parsedOffset,
      sort: sortArray
    });
  }

  @Get('health')
  @ApiOperation({
    summary: 'Check search service health',
    description: 'Returns the health status of the MeiliSearch integration'
  })
  @ApiResponse({
    status: 200,
    description: 'Health status returned',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'healthy' },
        isHealthy: { type: 'boolean', example: true }
      }
    }
  })
  async getHealth() {
    return this.searchService.getHealth();
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Get search index statistics',
    description: 'Returns statistics about the works search index'
  })
  @ApiResponse({
    status: 200,
    description: 'Index statistics returned'
  })
  async getStats() {
    return this.searchService.getStats();
  }
}
