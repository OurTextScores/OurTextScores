import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Source, SourceDocument } from '../works/schemas/source.schema';
import { SourceRevision, SourceRevisionDocument } from '../works/schemas/source-revision.schema';
import { Work, WorkDocument } from '../works/schemas/work.schema';

@ApiTags('users')
@Controller('users')
export class UsersPublicController {
  constructor(
    private readonly users: UsersService,
    @InjectModel(Source.name)
    private readonly sourceModel: Model<SourceDocument>,
    @InjectModel(SourceRevision.name)
    private readonly sourceRevisionModel: Model<SourceRevisionDocument>,
    @InjectModel(Work.name)
    private readonly workModel: Model<WorkDocument>
  ) {}

  @Get('by-username/:username')
  @ApiOperation({
    summary: 'Get public user profile by username',
    description: 'Resolve a username to a public user profile (id, username, displayName).'
  })
  @ApiParam({ name: 'username', description: 'Username (lowercase)', example: 'alice' })
  @ApiResponse({
    status: 200,
    description: 'User profile found',
    schema: {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            id: { type: 'string', example: '507f1f77bcf86cd799439011' },
            username: { type: 'string', example: 'alice' },
            displayName: { type: 'string', example: 'Alice Example' }
          }
        }
      }
    }
  })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getByUsername(@Param('username') username: string) {
    const doc = await this.users.findByUsername(username);
    if (!doc || !doc.username) {
      throw new NotFoundException('User not found');
    }
    return {
      user: {
        id: String(doc._id),
        username: doc.username,
        displayName: doc.displayName ?? undefined
      }
    };
  }

  @Get(':userId/uploads')
  @ApiOperation({
    summary: 'Get uploads for a user',
    description: 'Return sources uploaded by the given user and a list of their recent revisions.'
  })
  @ApiParam({ name: 'userId', description: 'User identifier', example: '507f1f77bcf86cd799439011' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Maximum number of sources to return (default: 20, max: 100)',
    example: 20
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Number of sources to skip for pagination (default: 0)',
    example: 0
  })
  @ApiResponse({
    status: 200,
    description: 'User uploads returned',
    schema: {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            username: { type: 'string' },
            displayName: { type: 'string' }
          }
        },
        stats: {
          type: 'object',
          properties: {
            sourceCount: { type: 'number' },
            revisionCount: { type: 'number' },
            workCount: { type: 'number' }
          }
        },
        sources: { type: 'array', items: { type: 'object' } },
        recentRevisions: { type: 'array', items: { type: 'object' } }
      }
    }
  })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getUploads(
    @Param('userId') userId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    const userDoc = await this.users.findById(userId);
    if (!userDoc) {
      throw new NotFoundException('User not found');
    }

    const parsedLimit = limit ? Math.min(parseInt(limit, 10), 100) : 20;
    const parsedOffset = offset ? Math.max(parseInt(offset, 10), 0) : 0;

    const sourceFilter = { 'provenance.uploadedByUserId': userId };

    const [sourceCount, sources, revisionCount, recentRevisionsAll, distinctWorkIds] = await Promise.all([
      this.sourceModel.countDocuments(sourceFilter).exec(),
      this.sourceModel
        .find(sourceFilter)
        .sort({ 'provenance.uploadedAt': -1, workId: 1 })
        .skip(parsedOffset)
        .limit(parsedLimit)
        .lean()
        .exec(),
      this.sourceRevisionModel.countDocuments({ createdBy: userId }).exec(),
      this.sourceRevisionModel
        .find({ createdBy: userId })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean()
        .exec(),
      this.sourceModel.distinct('workId', sourceFilter).exec()
    ]);

    const workIds = new Set<string>();
    for (const w of distinctWorkIds as string[]) {
      if (w) workIds.add(w);
    }
    for (const rev of recentRevisionsAll) {
      if (rev.workId) workIds.add(rev.workId);
    }

    const workDocs = workIds.size
      ? await this.workModel.find({ workId: { $in: Array.from(workIds) } }).lean().exec()
      : [];
    const workById = new Map<string, WorkDocument>();
    for (const w of workDocs) {
      workById.set(w.workId, w as any);
    }

    const sourcesPayload = sources.map((src) => {
      const work = workById.get(src.workId);
      return {
        workId: src.workId,
        workTitle: work?.title ?? undefined,
        workComposer: work?.composer ?? undefined,
        workCatalogNumber: work?.catalogNumber ?? undefined,
        sourceId: src.sourceId,
        label: src.label,
        format: src.format,
        isPrimary: src.isPrimary,
        latestRevisionId: src.latestRevisionId ?? undefined,
        latestRevisionAt: src.latestRevisionAt ?? undefined
      };
    });

    const recentRevisions = recentRevisionsAll.map((rev) => {
      const work = workById.get(rev.workId);
      return {
        workId: rev.workId,
        workTitle: work?.title ?? undefined,
        sourceId: rev.sourceId,
        revisionId: rev.revisionId,
        sequenceNumber: rev.sequenceNumber,
        createdAt: rev.createdAt,
        changeSummary: rev.changeSummary ?? undefined
      };
    });

    const workCount = workIds.size;

    return {
      user: {
        id: String(userDoc._id),
        username: userDoc.username,
        displayName: userDoc.displayName ?? undefined
      },
      stats: {
        sourceCount,
        revisionCount,
        workCount
      },
      sources: sourcesPayload,
      recentRevisions
    };
  }
}

