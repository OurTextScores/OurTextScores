import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
  BadRequestException,
  ForbiddenException,
  Query,
  Sse,
  Headers,
  Req
} from '@nestjs/common';
import type { Request } from 'express';
import { FileInterceptor, FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { EnsureWorkResponse, WorksService } from './works.service';
import { UseGuards } from '@nestjs/common';
import { AuthOptionalGuard } from '../auth/guards/auth-optional.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types/auth-user';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { AdminRequiredGuard } from '../auth/guards/admin-required.guard';
import { UploadSourceService, UploadSourceRequest } from './upload-source.service';
import { ProgressService } from '../progress/progress.service';
import { AnalyticsService } from '../analytics/analytics.service';
import type { Observable } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody, ApiConsumes, ApiQuery } from '@nestjs/swagger';

@ApiTags('works')
@Controller('works')
export class WorksController {
  constructor(
    private readonly worksService: WorksService,
    private readonly uploadSourceService: UploadSourceService,
    private readonly progressService: ProgressService,
    private readonly analyticsService: AnalyticsService
  ) { }

  private trackScoreViewed(
    req: Request,
    user: RequestUser | undefined,
    payload: { workId: string; sourceId?: string; revisionId?: string }
  ): void {
    const actor = this.analyticsService.toActor(user);
    const requestContext = this.analyticsService.getRequestContext(req, {
      sourceApp: 'backend',
      route: req.originalUrl ?? req.url
    });

    void this.analyticsService.trackBestEffort({
      eventName: 'score_viewed',
      actor,
      requestContext,
      properties: {
        work_id: payload.workId,
        source_id: payload.sourceId ?? null,
        revision_id: payload.revisionId ?? null,
        view_surface: 'api_work_detail'
      }
    });

    void this.analyticsService.trackFirstScoreLoadedIfNeeded({
      actor,
      requestContext,
      entryType: 'existing',
      workId: payload.workId,
      sourceId: payload.sourceId,
      revisionId: payload.revisionId
    }).catch(() => undefined);
  }

  @Get()
  @ApiOperation({
    summary: 'List all works',
    description: 'Returns a paginated list of works in the system with their sources and metadata'
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
    name: 'filter',
    required: false,
    description: 'MeiliSearch filter string (e.g., "hasReferencePdf = true")',
    example: 'hasReferencePdf = true'
  })
  @ApiQuery({
    name: 'onlyWithSources',
    required: false,
    description: 'Exclude works with no sources',
    example: true
  })
  @ApiResponse({
    status: 200,
    description: 'List of works retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        works: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              workId: { type: 'string', example: '164349' },
              title: { type: 'string', example: 'Prelude in C Major' },
              composer: { type: 'string', example: 'J.S. Bach' },
              catalogNumber: { type: 'string', example: 'BWV 846' },
              sourceCount: { type: 'number', example: 2 },
              availableFormats: {
                type: 'array',
                items: { type: 'string' },
                example: ['application/xml', 'application/vnd.recordare.musicxml']
              },
              latestRevisionAt: { type: 'string', format: 'date-time' }
            }
          }
        },
        total: { type: 'number', example: 150 },
        totalSourceCount: { type: 'number', example: 4821, nullable: true },
        limit: { type: 'number', example: 20 },
        offset: { type: 'number', example: 0 }
      }
    }
  })
  findAll(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('filter') filter?: string,
    @Query('onlyWithSources') onlyWithSources?: string
  ) {
    const parsedLimit = limit ? Math.min(parseInt(limit, 10), 100) : 20;
    const parsedOffset = offset ? Math.max(parseInt(offset, 10), 0) : 0;
    const parsedOnlyWithSources = onlyWithSources === 'true';
    return this.worksService.findAll({
      limit: parsedLimit,
      offset: parsedOffset,
      filter,
      onlyWithSources: parsedOnlyWithSources
    });
  }

  @Post()
  @ApiOperation({
    summary: 'Ensure work exists',
    description: 'Creates or retrieves a work by IMSLP page_id. Fetches metadata from IMSLP if the work doesn\'t exist.'
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['workId'],
      properties: {
        workId: {
          type: 'string',
          description: 'IMSLP numeric page_id',
          example: '164349'
        }
      }
    }
  })
  @ApiResponse({
    status: 201,
    description: 'Work ensured successfully',
    schema: {
      type: 'object',
      properties: {
        workId: { type: 'string', example: '164349' },
        title: { type: 'string', example: 'Prelude in C Major' },
        composer: { type: 'string', example: 'J.S. Bach' }
      }
    }
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid workId format (must be numeric IMSLP page_id)'
  })
  @ApiResponse({
    status: 404,
    description: 'Work not found in IMSLP'
  })
  ensureWork(@Body('workId') workId: string): Promise<EnsureWorkResponse> {
    if (!workId || !workId.trim()) {
      throw new BadRequestException('workId is required');
    }
    const trimmed = workId.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new BadRequestException('workId must be the numeric IMSLP page_id');
    }

    return this.worksService.ensureWorkWithMetadata(trimmed);
  }

  @Post('save-by-url')
  saveWorkByUrl(@Body('url') url: string): Promise<EnsureWorkResponse> {
    const trimmed = url?.trim();
    if (!trimmed) {
      throw new BadRequestException('url is required');
    }
    return this.worksService.saveWorkByImslpUrl(trimmed);
  }

  @Get(':workId')
  @UseGuards(AuthOptionalGuard)
  async findOne(
    @Param('workId') workId: string,
    @CurrentUser() user?: RequestUser,
    @Req() req?: Request
  ) {
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    const detail = await this.worksService.getWorkDetail(workId, viewer);
    const sources = Array.isArray(detail.sources) ? detail.sources : [];
    const primarySource = sources.find((source) => source.isPrimary) ?? sources[0];
    if (req) {
      this.trackScoreViewed(req, user, {
        workId: detail.workId,
        sourceId: primarySource?.sourceId,
        revisionId: primarySource?.latestRevisionId
      });
    }
    return detail;
  }

  @Post(":workId/metadata")
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  updateMetadata(
    @Param('workId') workId: string,
    @Body('title') title?: string,
    @Body('composer') composer?: string,
    @Body('catalogNumber') catalogNumber?: string
  ) {
    return this.worksService.updateWorkMetadata(workId, { title, composer, catalogNumber });
  }

  @Post(":workId/sources/prune-pending")
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  @ApiOperation({
    summary: 'Prune pending sources',
    description: 'Delete sources for a work that have not completed the derivative pipeline. Requires admin role.'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiResponse({ status: 200, description: 'Pending sources pruned successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized - authentication required' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  prunePending(@Param('workId') workId: string) {
    return this.worksService.prunePendingSources(workId);
  }

  @Post(":workId/sources/delete-all")
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  @ApiOperation({
    summary: 'Delete all sources for a work',
    description: 'Permanently delete all sources and revisions for a work. Requires admin role.'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiResponse({ status: 200, description: 'All sources deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized - authentication required' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  deleteAll(@Param('workId') workId: string) {
    return this.worksService.deleteAllSources(workId);
  }

  @Delete(":workId/sources/:sourceId")
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Delete a source',
    description: 'Delete a single source and its revisions. Requires source owner or admin.'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiResponse({ status: 200, description: 'Source deleted successfully', schema: { type: 'object', properties: { removed: { type: 'boolean', example: true } } } })
  @ApiResponse({ status: 401, description: 'Unauthorized - authentication required' })
  @ApiResponse({ status: 403, description: 'Forbidden - only source owner or admin can delete source' })
  @ApiResponse({ status: 404, description: 'Source not found' })
  deleteSource(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: RequestUser
  ) {
    return this.worksService.deleteSource(workId, sourceId, { userId: user.userId, roles: user.roles });
  }

  @Patch(":workId/sources/:sourceId")
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Update source metadata',
    description: 'Update the label and/or description of a source. Requires source owner or admin role.'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        label: { type: 'string', example: 'Piano Score', description: 'Source title/label' },
        description: { type: 'string', example: 'Original manuscript', description: 'Source description' }
      }
    }
  })
  @ApiResponse({ status: 200, description: 'Source updated successfully', schema: { type: 'object', properties: { ok: { type: 'boolean', example: true } } } })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - only source owner or admin can update source' })
  @ApiResponse({ status: 404, description: 'Source not found' })
  updateSource(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Body('label') label?: string,
    @Body('description') description?: string,
    @CurrentUser() user?: RequestUser
  ) {
    return this.worksService.updateSource(workId, sourceId, { label, description }, { userId: user?.userId, roles: user?.roles });
  }

  @Post(':workId/sources')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'file', maxCount: 1 },
      { name: 'referencePdf', maxCount: 1 },
      { name: 'originalMscz', maxCount: 1 }
    ], {
      storage: memoryStorage(),
      limits: {
        fileSize: 100 * 1024 * 1024 // 100 MB safeguard
      }
    })
  )
  @UseGuards(AuthOptionalGuard)
  @ApiTags('uploads')
  @ApiOperation({
    summary: 'Upload a new source',
    description: 'Upload a MusicXML file as a new source for a work. Optionally include a reference PDF. Generates derivatives (PDF, canonical XML, etc.) asynchronously.'
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary', description: 'Score file (.mscz, .mscx, .musicxml, .mxl, or .xml)' },
        referencePdf: { type: 'string', format: 'binary', description: 'Optional reference PDF file' },
        originalMscz: { type: 'string', format: 'binary', description: 'Optional original .mscz file when score file is pre-converted to .mxl client-side' },
        isPrimary: { type: 'boolean', description: 'Whether this is the primary source', example: true },
        formatHint: { type: 'string', description: 'Format hint (e.g., "musicxml")', example: 'musicxml' },
        branch: { type: 'string', description: 'Target branch name', example: 'trunk' },
        license: { type: 'string', description: 'License for the uploaded content', example: 'CC-BY-4.0' },
        rightsDeclarationAccepted: { type: 'boolean', description: 'Whether uploader confirms they have legal rights to upload this content' }
      },
      required: ['file']
    }
  })
  @ApiResponse({ status: 201, description: 'Source uploaded successfully, derivatives being generated' })
  @ApiResponse({ status: 400, description: 'Invalid file or parameters' })
  async uploadSource(
    @Param('workId') workId: string,
    @Body() body: UploadSourceRequest,
    @UploadedFiles() files?: { file?: Express.Multer.File[]; referencePdf?: Express.Multer.File[]; originalMscz?: Express.Multer.File[] },
    @Headers('x-progress-id') progressId?: string,
    @CurrentUser() user?: RequestUser,
    @Req() req?: Request
  ) {
    const normalizedBody: UploadSourceRequest = {
      ...body,
      isPrimary: this.toBoolean(body?.isPrimary),
      formatHint: body?.formatHint,
      rightsDeclarationAccepted: this.toBoolean((body as any)?.rightsDeclarationAccepted)
    };
    const file = files?.file?.[0];
    const referencePdfFile = files?.referencePdf?.[0];
    const originalMsczFile = files?.originalMscz?.[0];
    const result = await this.uploadSourceService.upload(
      workId,
      normalizedBody,
      file,
      referencePdfFile,
      progressId,
      user,
      originalMsczFile
    );
    if (req) {
      const actor = this.analyticsService.toActor(user);
      const requestContext = this.analyticsService.getRequestContext(req, {
        sourceApp: 'backend',
        route: req.originalUrl ?? req.url
      });
      await this.analyticsService.trackBestEffort({
        eventName: 'upload_success',
        actor,
        requestContext,
        properties: {
          work_id: result.workId,
          source_id: result.sourceId,
          revision_id: result.revisionId,
          file_ext: file?.originalname?.split('.').pop()?.toLowerCase() ?? 'unknown',
          file_size_bytes: file?.size ?? 0
        }
      });
      await this.analyticsService.trackBestEffort({
        eventName: 'editor_revision_saved',
        actor,
        requestContext,
        properties: {
          work_id: result.workId,
          source_id: result.sourceId,
          revision_id: result.revisionId,
          save_mode: 'manual'
        }
      });
    }
    return result;
  }

  @Post(':workId/sources/:sourceId/revisions')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'file', maxCount: 1 },
      { name: 'referencePdf', maxCount: 1 },
      { name: 'originalMscz', maxCount: 1 }
    ], {
      storage: memoryStorage(),
      limits: {
        fileSize: 100 * 1024 * 1024
      }
    })
  )
  @UseGuards(AuthOptionalGuard)
  @ApiTags('uploads')
  @ApiOperation({
    summary: 'Upload a revision to an existing source',
    description: 'Upload a new revision of an existing source. Optionally include a reference PDF. Generates derivatives.'
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary', description: 'Score file (.mscz, .mscx, .musicxml, .mxl, or .xml)' },
        referencePdf: { type: 'string', format: 'binary', description: 'Optional reference PDF file' },
        originalMscz: { type: 'string', format: 'binary', description: 'Optional original .mscz file when score file is pre-converted to .mxl client-side' },
        isPrimary: { type: 'boolean', description: 'Whether this is the primary source' },
        formatHint: { type: 'string', description: 'Format hint (e.g., "musicxml")', example: 'musicxml' },
        branch: { type: 'string', description: 'Target branch name', example: 'trunk' },
        createBranch: { type: 'boolean', description: 'Create a new branch for this revision' },
        branchName: { type: 'string', description: 'Name of new branch if createBranch is true' },
        changeSummary: { type: 'string', description: 'Summary of changes in this revision', example: 'Fixed measure 42 dynamics' },
        license: { type: 'string', description: 'License for the uploaded content', example: 'CC-BY-4.0' },
        rightsDeclarationAccepted: { type: 'boolean', description: 'Whether uploader confirms they have legal rights to upload this content' }
      },
      required: ['file']
    }
  })
  @ApiResponse({ status: 201, description: 'Revision uploaded successfully, derivatives and diff being generated' })
  @ApiResponse({ status: 400, description: 'Invalid file or parameters' })
  @ApiResponse({ status: 404, description: 'Source not found' })
  async uploadRevision(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Body() body: UploadSourceRequest,
    @UploadedFiles() files?: { file?: Express.Multer.File[]; referencePdf?: Express.Multer.File[]; originalMscz?: Express.Multer.File[] },
    @Headers('x-progress-id') progressId?: string,
    @CurrentUser() user?: RequestUser,
    @Req() req?: Request
  ) {
    const normalizedBody: UploadSourceRequest = {
      ...body,
      isPrimary: this.toBoolean(body?.isPrimary),
      formatHint: body?.formatHint,
      createBranch: this.toBoolean((body as any)?.createBranch),
      branchName: (body as any)?.branchName,
      rightsDeclarationAccepted: this.toBoolean((body as any)?.rightsDeclarationAccepted)
    };
    const file = files?.file?.[0];
    const referencePdfFile = files?.referencePdf?.[0];
    const originalMsczFile = files?.originalMscz?.[0];
    const result = await this.uploadSourceService.uploadRevision(
      workId,
      sourceId,
      normalizedBody,
      file,
      referencePdfFile,
      progressId,
      user,
      originalMsczFile
    );
    if (req) {
      const actor = this.analyticsService.toActor(user);
      const requestContext = this.analyticsService.getRequestContext(req, {
        sourceApp: 'backend',
        route: req.originalUrl ?? req.url
      });
      await this.analyticsService.trackBestEffort({
        eventName: 'upload_success',
        actor,
        requestContext,
        properties: {
          work_id: result.workId,
          source_id: result.sourceId,
          revision_id: result.revisionId,
          file_ext: file?.originalname?.split('.').pop()?.toLowerCase() ?? 'unknown',
          file_size_bytes: file?.size ?? 0
        }
      });
      await this.analyticsService.trackBestEffort({
        eventName: 'editor_revision_saved',
        actor,
        requestContext,
        properties: {
          work_id: result.workId,
          source_id: result.sourceId,
          revision_id: result.revisionId,
          save_mode: 'manual'
        }
      });
    }
    return result;
  }

  @Post(':workId/sources/:sourceId/reference.pdf')
  @UseInterceptors(
    FileInterceptor('referencePdf', {
      storage: memoryStorage(),
      limits: {
        fileSize: 50 * 1024 * 1024 // 50 MB safeguard
      }
    })
  )
  @UseGuards(AuthRequiredGuard)
  @ApiTags('uploads')
  @ApiOperation({
    summary: 'Upload reference PDF for an existing source',
    description: 'Upload a reference PDF for a source that does not already have one. Requires source owner or admin.'
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        referencePdf: { type: 'string', format: 'binary', description: 'Reference PDF file (must match IMSLP hash)' }
      },
      required: ['referencePdf']
    }
  })
  @ApiResponse({ status: 200, description: 'Reference PDF uploaded successfully' })
  @ApiResponse({ status: 400, description: 'Invalid file or reference PDF already exists' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - only source owner or admin can upload reference PDF' })
  uploadReferencePdf(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @UploadedFile() referencePdfFile?: Express.Multer.File,
    @Headers('x-progress-id') progressId?: string,
    @CurrentUser() user?: RequestUser
  ) {
    return this.uploadSourceService.uploadReferencePdf(workId, sourceId, referencePdfFile, progressId, user);
  }

  @Post(':workId/sources/:sourceId/migrate')
  @UseGuards(AuthRequiredGuard)
  @ApiTags('works')
  @ApiOperation({
    summary: 'Migrate source to a new work (admin only)',
    description: 'Move a source and all associated data to a new work by IMSLP URL. Creates the work if needed.'
  })
  @ApiParam({ name: 'workId', description: 'Current Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        imslpUrl: { type: 'string', description: 'IMSLP permalink or slug URL for the target work' }
      },
      required: ['imslpUrl']
    }
  })
  @ApiResponse({ status: 200, description: 'Migration completed' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  @ApiResponse({ status: 404, description: 'Source not found' })
  async migrateSource(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Body('imslpUrl') imslpUrl: string,
    @CurrentUser() user?: RequestUser
  ) {
    if (!user?.roles?.includes('admin')) {
      throw new ForbiddenException('Admin role required');
    }
    if (!imslpUrl || !imslpUrl.trim()) {
      throw new BadRequestException('imslpUrl is required');
    }
    return this.worksService.migrateSourceToWorkByImslpUrl(workId, sourceId, imslpUrl.trim(), { userId: user.userId, roles: user.roles });
  }

  @Post(':workId/sources/:sourceId/revisions/:revisionId/approve')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Approve a revision',
    description: 'Approve a pending revision (for branches with owner_approval policy). Requires authentication and ownership permissions.'
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
    @CurrentUser() user: RequestUser
  ) {
    return this.worksService.approveRevision(workId, sourceId, revisionId, { userId: user.userId, roles: user.roles });
  }

  @Post(':workId/sources/:sourceId/revisions/:revisionId/reject')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Reject a revision',
    description: 'Reject a pending revision (for branches with owner_approval policy). Requires authentication and ownership permissions.'
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
    @CurrentUser() user: RequestUser
  ) {
    return this.worksService.rejectRevision(workId, sourceId, revisionId, { userId: user.userId, roles: user.roles });
  }

  // Rating endpoints
  @Post(':workId/sources/:sourceId/revisions/:revisionId/rate')
  @UseGuards(AuthRequiredGuard)
  @ApiTags('works')
  @ApiOperation({
    summary: 'Rate a revision',
    description: 'Submit a 1-5 star rating for a revision. One rating per user per revision.'
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
    @Req() req?: Request
  ) {
    const isAdmin = user?.roles?.includes('admin') ?? false;
    const result = await this.worksService.rateRevision(
      workId,
      sourceId,
      revisionId,
      user.userId,
      body.rating,
      isAdmin
    );
    if (req) {
      await this.analyticsService.trackBestEffort({
        eventName: 'revision_rated',
        actor: this.analyticsService.toActor(user),
        requestContext: this.analyticsService.getRequestContext(req, {
          sourceApp: 'backend',
          route: req.originalUrl ?? req.url
        }),
        properties: {
          work_id: workId,
          source_id: sourceId,
          revision_id: revisionId,
          rating_value: body.rating
        }
      });
    }
    return result;
  }

  @Get(':workId/sources/:sourceId/revisions/:revisionId/ratings')
  @ApiTags('works')
  @ApiOperation({
    summary: 'Get rating histogram',
    description: 'Get rating distribution (histogram) for a revision, showing user and admin counts per star level'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID' })
  @ApiResponse({ status: 200, description: 'Rating histogram returned' })
  @ApiResponse({ status: 404, description: 'Revision not found' })
  async getRevisionRatings(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Param('revisionId') revisionId: string
  ) {
    return this.worksService.getRevisionRatings(workId, sourceId, revisionId);
  }

  @Get(':workId/sources/:sourceId/revisions/:revisionId/ratings/check')
  @UseGuards(AuthRequiredGuard)
  @ApiTags('works')
  @ApiOperation({
    summary: 'Check if user has rated',
    description: 'Check if the current user has already rated this revision'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID' })
  @ApiResponse({ status: 200, description: 'Returns { hasRated: boolean }' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  async checkUserRating(
    @Param('revisionId') revisionId: string,
    @CurrentUser() user: RequestUser
  ) {
    const hasRated = await this.worksService.hasUserRatedRevision(revisionId, user.userId);
    return { hasRated };
  }

  // Comment endpoints
  @Post(':workId/sources/:sourceId/revisions/:revisionId/comments')
  @UseGuards(AuthRequiredGuard)
  @ApiTags('works')
  @ApiOperation({
    summary: 'Create a comment',
    description: 'Post a comment on a revision or reply to an existing comment'
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
    @Req() req?: Request
  ) {
    const result = await this.worksService.createComment(
      workId,
      sourceId,
      revisionId,
      user.userId,
      body.content,
      body.parentCommentId
    );
    if (req) {
      await this.analyticsService.trackBestEffort({
        eventName: 'revision_commented',
        actor: this.analyticsService.toActor(user),
        requestContext: this.analyticsService.getRequestContext(req, {
          sourceApp: 'backend',
          route: req.originalUrl ?? req.url
        }),
        properties: {
          work_id: workId,
          source_id: sourceId,
          revision_id: revisionId,
          is_reply: Boolean(body.parentCommentId)
        }
      });
    }
    return result;
  }

  @Get(':workId/sources/:sourceId/revisions/:revisionId/comments')
  @ApiTags('works')
  @ApiOperation({
    summary: 'Get comments',
    description: 'Get all comments for a revision (nested structure with vote info for authenticated user)'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID' })
  @ApiResponse({ status: 200, description: 'Comments retrieved' })
  @ApiResponse({ status: 404, description: 'Revision not found' })
  async getComments(
    @Param('revisionId') revisionId: string,
    @CurrentUser() user?: RequestUser
  ) {
    return this.worksService.getComments(revisionId, user?.userId);
  }

  @Patch(':workId/sources/:sourceId/revisions/:revisionId/comments/:commentId')
  @UseGuards(AuthRequiredGuard)
  @ApiTags('works')
  @ApiOperation({
    summary: 'Update a comment',
    description: 'Edit your own comment'
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
    @CurrentUser() user: RequestUser
  ) {
    return this.worksService.updateComment(commentId, user.userId, body.content);
  }

  @Delete(':workId/sources/:sourceId/revisions/:revisionId/comments/:commentId')
  @UseGuards(AuthRequiredGuard)
  @ApiTags('works')
  @ApiOperation({
    summary: 'Delete a comment',
    description: 'Delete your own comment (or any comment if admin)'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID' })
  @ApiParam({ name: 'commentId', description: 'Comment ID' })
  @ApiResponse({ status: 200, description: 'Comment deleted' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Not authorized to delete' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async deleteComment(
    @Param('commentId') commentId: string,
    @CurrentUser() user: RequestUser
  ) {
    const isAdmin = user?.roles?.includes('admin') ?? false;
    return this.worksService.deleteComment(commentId, user.userId, isAdmin);
  }

  @Post(':workId/sources/:sourceId/revisions/:revisionId/comments/:commentId/vote')
  @UseGuards(AuthRequiredGuard)
  @ApiTags('works')
  @ApiOperation({
    summary: 'Vote on a comment',
    description: 'Upvote or downvote a comment (toggle to remove vote)'
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
    @CurrentUser() user: RequestUser
  ) {
    return this.worksService.voteComment(commentId, user.userId, body.voteType);
  }

  @Post(':workId/sources/:sourceId/revisions/:revisionId/comments/:commentId/flag')
  @UseGuards(AuthRequiredGuard)
  @ApiTags('works')
  @ApiOperation({
    summary: 'Flag a comment for review',
    description: 'Report a comment as inappropriate or violating guidelines'
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
    @CurrentUser() user: RequestUser
  ) {
    return this.worksService.flagComment(commentId, user.userId, body.reason);
  }

  @Delete(':workId/sources/:sourceId/revisions/:revisionId/comments/:commentId/flag')
  @UseGuards(AuthRequiredGuard)
  @ApiTags('works')
  @ApiOperation({
    summary: 'Remove flag from comment (admin only)',
    description: 'Clear the flag from a comment'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID' })
  @ApiParam({ name: 'commentId', description: 'Comment ID' })
  @ApiResponse({ status: 200, description: 'Flag removed' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async unflagComment(
    @Param('commentId') commentId: string,
    @CurrentUser() user?: RequestUser
  ) {
    if (!user?.roles?.includes('admin')) {
      throw new ForbiddenException('Admin role required');
    }
    return this.worksService.unflagComment(commentId);
  }

  // Admin flagged comments dashboard
  @Get('admin/flagged-comments')
  @UseGuards(AuthRequiredGuard)
  @ApiTags('works')
  @ApiOperation({
    summary: 'Get all flagged comments (admin only)',
    description: 'Retrieve all flagged comments for moderation dashboard'
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
  @ApiTags('works')
  @ApiOperation({
    summary: 'Get all flagged sources (admin only)',
    description: 'Retrieve all flagged sources for moderation and legal review.'
  })
  @ApiResponse({ status: 200, description: 'List of flagged sources with context' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  async getFlaggedSources(@CurrentUser() user?: RequestUser) {
    if (!user?.roles?.includes('admin')) {
      throw new ForbiddenException('Admin role required');
    }
    return this.worksService.getFlaggedSources();
  }

  // Admin verification endpoints
  @Post(':workId/sources/:sourceId/verify')
  @UseGuards(AuthRequiredGuard)
  @ApiTags('works')
  @ApiOperation({
    summary: 'Verify source (admin only)',
    description: 'Mark a source as verified/valid transcription'
  })
  @ApiParam({ name: 'workId', description: 'Work ID' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Optional verification note' }
      }
    }
  })
  @ApiResponse({ status: 200, description: 'Source verified successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Source not found' })
  async verifySource(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Body() body: { note?: string },
    @CurrentUser() user?: RequestUser
  ) {
    if (!user?.roles?.includes('admin')) {
      throw new ForbiddenException('Admin role required');
    }
    return this.worksService.verifySource(workId, sourceId, user.userId, body.note);
  }

  @Delete(':workId/sources/:sourceId/verify')
  @UseGuards(AuthRequiredGuard)
  @ApiTags('works')
  @ApiOperation({
    summary: 'Remove verification (admin only)',
    description: 'Remove verification from a source'
  })
  @ApiParam({ name: 'workId', description: 'Work ID' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiResponse({ status: 200, description: 'Verification removed successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Source not found' })
  async removeVerification(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user?: RequestUser
  ) {
    if (!user?.roles?.includes('admin')) {
      throw new ForbiddenException('Admin role required');
    }
    return this.worksService.removeVerification(workId, sourceId);
  }

  @Post(':workId/sources/:sourceId/flag')
  @UseGuards(AuthRequiredGuard)
  @ApiTags('works')
  @ApiOperation({
    summary: 'Flag source for deletion',
    description: 'Mark a source as problematic/should be deleted. Any authenticated user can flag sources.'
  })
  @ApiParam({ name: 'workId', description: 'Work ID' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string', description: 'Reason for flagging' }
      }
    }
  })
  @ApiResponse({ status: 200, description: 'Source flagged successfully' })
  @ApiResponse({ status: 400, description: 'Reason required' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 404, description: 'Source not found' })
  async flagSource(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Body() body: { reason: string },
    @CurrentUser() user?: RequestUser
  ) {
    if (!body.reason?.trim()) {
      throw new BadRequestException('Reason is required');
    }
    return this.worksService.flagSource(workId, sourceId, user.userId, body.reason);
  }

  @Delete(':workId/sources/:sourceId/flag')
  @UseGuards(AuthRequiredGuard)
  @ApiTags('works')
  @ApiOperation({
    summary: 'Remove flag (admin only)',
    description: 'Remove deletion flag from a source'
  })
  @ApiParam({ name: 'workId', description: 'Work ID' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiResponse({ status: 200, description: 'Flag removed successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Source not found' })
  async removeFlag(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user?: RequestUser
  ) {
    if (!user?.roles?.includes('admin')) {
      throw new ForbiddenException('Admin role required');
    }
    return this.worksService.removeFlag(workId, sourceId);
  }

  // Server-Sent Events stream for progress updates
  @Sse('progress/:progressId/stream')
  progress(@Param('progressId') progressId: string): Observable<MessageEvent> {
    return this.progressService.stream(progressId);
  }

  private toBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false') {
        return false;
      }
    }
    return undefined;
  }
}
