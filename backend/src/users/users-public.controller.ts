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

  @Get(':userId/contributions')
  @ApiOperation({
    summary: 'Get contributed sources for a user',
    description: 'Return sources the user has contributed revisions to (distinct by workId/sourceId).'
  })
  @ApiParam({ name: 'userId', description: 'User identifier', example: '507f1f77bcf86cd799439011' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Maximum number of sources to return (default: 50, max: 200)',
    example: 50
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Number of sources to skip for pagination (default: 0)',
    example: 0
  })
  @ApiResponse({
    status: 200,
    description: 'User contributions returned',
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
        total: { type: 'number' },
        limit: { type: 'number' },
        offset: { type: 'number' },
        contributions: { type: 'array', items: { type: 'object' } }
      }
    }
  })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getContributions(
    @Param('userId') userId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    const userDoc = await this.users.findById(userId);
    if (!userDoc) {
      throw new NotFoundException('User not found');
    }

    const parsedLimit = limit ? Math.min(parseInt(limit, 10), 200) : 50;
    const parsedOffset = offset ? Math.max(parseInt(offset, 10), 0) : 0;

    const [result] = await this.sourceRevisionModel.aggregate([
      { $match: { createdBy: userId } },
      {
        $group: {
          _id: { workId: '$workId', sourceId: '$sourceId' },
          lastContributionAt: { $max: '$createdAt' },
          revisionCount: { $sum: 1 }
        }
      },
      { $sort: { lastContributionAt: -1 } },
      {
        $facet: {
          total: [{ $count: 'count' }],
          items: [
            { $skip: parsedOffset },
            { $limit: parsedLimit }
          ]
        }
      }
    ]).exec();

    const total = result?.total?.[0]?.count ?? 0;
    const items: Array<{
      _id: { workId: string; sourceId: string };
      lastContributionAt: string;
      revisionCount: number;
    }> = result?.items ?? [];

    const sourceOr: Array<{ workId: string; sourceId: string }> = items.map((item) => ({
      workId: item._id.workId,
      sourceId: item._id.sourceId
    }));

    const sources = sourceOr.length
      ? await this.sourceModel
          .find({ $or: sourceOr })
          .lean()
          .exec()
      : [];

    const workIds = new Set<string>();
    for (const src of sources) {
      if (src.workId) workIds.add(src.workId);
    }

    const workDocs = workIds.size
      ? await this.workModel.find({ workId: { $in: Array.from(workIds) } }).lean().exec()
      : [];
    const workById = new Map<string, WorkDocument>();
    for (const w of workDocs) {
      workById.set(w.workId, w as any);
    }

    const sourceByKey = new Map<string, any>();
    for (const src of sources) {
      sourceByKey.set(`${src.workId}::${src.sourceId}`, src);
    }

    const contributions = items.map((item) => {
      const key = `${item._id.workId}::${item._id.sourceId}`;
      const src = sourceByKey.get(key);
      const work = workById.get(item._id.workId);
      return {
        workId: item._id.workId,
        workTitle: work?.title ?? undefined,
        workComposer: work?.composer ?? undefined,
        workCatalogNumber: work?.catalogNumber ?? undefined,
        sourceId: item._id.sourceId,
        label: src?.label ?? undefined,
        format: src?.format ?? undefined,
        isPrimary: src?.isPrimary ?? false,
        latestRevisionId: src?.latestRevisionId ?? undefined,
        latestRevisionAt: src?.latestRevisionAt ?? undefined,
        lastContributionAt: item.lastContributionAt,
        revisionCount: item.revisionCount
      };
    });

    return {
      user: {
        id: String(userDoc._id),
        username: userDoc.username,
        displayName: userDoc.displayName ?? undefined
      },
      total,
      limit: parsedLimit,
      offset: parsedOffset,
      contributions
    };
  }
}
