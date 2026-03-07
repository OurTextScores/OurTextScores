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

  @Get(':workId/sources/:sourceId/history')
  @UseGuards(AuthOptionalGuard)
  @ApiOperation({
    summary: 'Get source history',
    description: 'Returns branch metadata and visible revisions for a source.'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'branch', required: false, description: 'Selected branch name', example: 'trunk' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of revisions to return', example: 50 })
  @ApiQuery({ name: 'cursor', required: false, description: 'Pagination cursor for older revisions' })
  async getSourceHistory(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('branch') branch?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @CurrentUser() user?: RequestUser
  ) {
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    return this.worksService.getSourceHistory({
      workId,
      sourceId,
      viewer,
      branch,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      cursor
    });
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
    description: 'Upload a score file as a new source for a work. Optionally include a reference PDF. Generates derivatives (PDF, canonical XML, etc.) asynchronously.'
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary', description: 'Score file (.mscz, .mscx, .musicxml, .mxl, .xml, .krn, or .abc)' },
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
        file: { type: 'string', format: 'binary', description: 'Score file (.mscz, .mscx, .musicxml, .mxl, .xml, .krn, or .abc)' },
        referencePdf: { type: 'string', format: 'binary', description: 'Optional reference PDF file' },
        originalMscz: { type: 'string', format: 'binary', description: 'Optional original .mscz file when score file is pre-converted to .mxl client-side' },
        isPrimary: { type: 'boolean', description: 'Whether this is the primary source' },
        formatHint: { type: 'string', description: 'Format hint (e.g., "musicxml")', example: 'musicxml' },
        branch: { type: 'string', description: 'Target branch name', example: 'trunk' },
        createBranch: { type: 'boolean', description: 'Create a new branch for this revision' },
        branchName: { type: 'string', description: 'Name of new branch if createBranch is true' },
        baseRevisionId: { type: 'string', description: 'Base revision for detached or empty-branch commits' },
        expectedHeadRevisionId: { type: 'string', description: 'Expected current branch head revision for optimistic concurrency' },
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
      baseRevisionId: (body as any)?.baseRevisionId,
      expectedHeadRevisionId: (body as any)?.expectedHeadRevisionId,
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
