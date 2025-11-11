import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SourceRevision, SourceRevisionDocument } from '../works/schemas/source-revision.schema';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { type RequestUser } from '../auth/types/auth-user';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';

@ApiTags('approvals')
@Controller('approvals')
export class ApprovalsController {
  constructor(
    @InjectModel(SourceRevision.name)
    private readonly revModel: Model<SourceRevisionDocument>
  ) {}

  @Get('inbox')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Get approval inbox',
    description: 'Get pending revisions awaiting approval from the current user. Requires authentication.'
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Maximum number of items to return (default: 50, max: 200)',
    example: 50
  })
  @ApiResponse({
    status: 200,
    description: 'Approval inbox retrieved',
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              workId: { type: 'string', example: '164349' },
              sourceId: { type: 'string' },
              revisionId: { type: 'string' },
              sequenceNumber: { type: 'number', example: 5 },
              createdAt: { type: 'string', format: 'date-time' }
            }
          }
        }
      }
    }
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async inbox(@CurrentUser() user: RequestUser, @Query('limit') limit = '50') {
    const max = Math.min(parseInt(String(limit), 10) || 50, 200);
    const revs = await this.revModel
      .find({ status: 'pending_approval', 'approval.ownerUserId': user.userId })
      .sort({ createdAt: -1 })
      .limit(max)
      .lean()
      .exec();

    return {
      items: revs.map((r) => ({
        workId: r.workId,
        sourceId: r.sourceId,
        revisionId: r.revisionId,
        sequenceNumber: r.sequenceNumber,
        createdAt: r.createdAt,
        createdBy: r.createdBy,
        changeSummary: r.changeSummary,
        derivatives: r.derivatives,
        manifest: r.manifest
      }))
    };
  }
}

