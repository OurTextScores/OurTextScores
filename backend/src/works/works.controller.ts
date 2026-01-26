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
  NotFoundException,
  Res,
  Query,
  Sse,
  Headers
} from '@nestjs/common';
import type { Response } from 'express';
import { StorageService } from '../storage/storage.service';
import { FossilService } from '../fossil/fossil.service';
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
import type { Observable } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody, ApiConsumes, ApiQuery } from '@nestjs/swagger';

@ApiTags('works')
@Controller('works')
export class WorksController {
  constructor(
    private readonly worksService: WorksService,
    private readonly uploadSourceService: UploadSourceService,
    private readonly storageService: StorageService,
    private readonly fossilService: FossilService,
    private readonly progressService: ProgressService
  ) { }

  private sendBuffer(
    res: Response,
    buffer: Buffer,
    filename: string,
    contentType: string,
    immutable: boolean,
    disposition: 'inline' | 'attachment' = 'attachment'
  ) {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (filename) {
      res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(filename)}"`);
    }
    res.send(buffer);
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
        limit: { type: 'number', example: 20 },
        offset: { type: 'number', example: 0 }
      }
    }
  })
  findAll(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('filter') filter?: string
  ) {
    const parsedLimit = limit ? Math.min(parseInt(limit, 10), 100) : 20;
    const parsedOffset = offset ? Math.max(parseInt(offset, 10), 0) : 0;
    return this.worksService.findAll({ limit: parsedLimit, offset: parsedOffset, filter });
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
  findOne(@Param('workId') workId: string, @CurrentUser() user?: RequestUser) {
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    return this.worksService.getWorkDetail(workId, viewer);
  }

  @Post(":workId/metadata")
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
    description: 'Update the label and/or description of a source. Requires authentication.'
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
  @ApiResponse({ status: 404, description: 'Source not found' })
  updateSource(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Body('label') label?: string,
    @Body('description') description?: string
  ) {
    return this.worksService.updateSource(workId, sourceId, { label, description });
  }

  @Get(":workId/sources/:sourceId/normalized.mxl")
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download normalized MXL',
    description: 'Get the normalized compressed MusicXML (.mxl) file for a source or specific revision'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'r', required: false, description: 'Revision ID (optional, defaults to latest)' })
  @ApiResponse({ status: 200, description: 'Normalized MXL file returned', content: { 'application/vnd.recordare.musicxml': {} } })
  @ApiResponse({ status: 404, description: 'Normalized MXL not found for this source' })
  async downloadNormalized(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('r') revisionId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser
  ) {
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    const detail = await this.worksService.getWorkDetail(workId, viewer);
    const source = detail.sources.find((s) => s.sourceId === sourceId);
    const locator = revisionId
      ? (source?.revisions.find(r => r.revisionId === revisionId)?.derivatives?.normalizedMxl)
      : source?.derivatives?.normalizedMxl;
    if (!source || !locator) {
      throw new NotFoundException('Normalized MXL not found for this source');
    }
    const loc = locator;
    const buffer = await this.storageService.getObjectBuffer(loc!.bucket, loc!.objectKey);
    const baseName = (source.originalFilename || 'score').replace(/\.[^.]+$/, '') + '.mxl';
    this.sendBuffer(res, buffer, baseName, loc.contentType || 'application/vnd.recordare.musicxml', !!revisionId, 'attachment');
  }

  @Get(":workId/sources/:sourceId/canonical.xml")
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download canonical XML',
    description: 'Get the canonical MusicXML representation of a source or specific revision'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'r', required: false, description: 'Revision ID (optional, defaults to latest)' })
  @ApiResponse({ status: 200, description: 'Canonical XML file returned', content: { 'application/xml': {} } })
  @ApiResponse({ status: 404, description: 'Canonical XML not found for this source' })
  async downloadCanonical(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('r') revisionId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser
  ) {
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    const detail = await this.worksService.getWorkDetail(workId, viewer);
    const source = detail.sources.find((s) => s.sourceId === sourceId);
    const locator = revisionId
      ? (source?.revisions.find(r => r.revisionId === revisionId)?.derivatives?.canonicalXml)
      : source?.derivatives?.canonicalXml;
    if (!source || !locator) {
      throw new NotFoundException('Canonical XML not found for this source');
    }
    const loc = locator;
    const buffer = await this.storageService.getObjectBuffer(loc!.bucket, loc!.objectKey);
    const baseName = (source.originalFilename || 'score').replace(/\.[^.]+$/, '') + '.xml';
    this.sendBuffer(res, buffer, baseName, 'application/xml; charset=utf-8', !!revisionId, 'attachment');
  }

  @Get(":workId/sources/:sourceId/score.pdf")
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download PDF score',
    description: 'Get the PDF rendering of a source or specific revision'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'r', required: false, description: 'Revision ID (optional, defaults to latest)' })
  @ApiResponse({ status: 200, description: 'PDF file returned', content: { 'application/pdf': {} } })
  @ApiResponse({ status: 404, description: 'PDF not found for this source' })
  async downloadPdf(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('r') revisionId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser
  ) {
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    const detail = await this.worksService.getWorkDetail(workId, viewer);
    const source = detail.sources.find((s) => s.sourceId === sourceId);
    const locator = revisionId
      ? (source?.revisions.find(r => r.revisionId === revisionId)?.derivatives?.pdf)
      : source?.derivatives?.pdf;
    if (!source || !locator) {
      throw new NotFoundException('PDF not found for this source');
    }
    const loc = locator;
    const buffer = await this.storageService.getObjectBuffer(loc!.bucket, loc!.objectKey);
    const baseName = (source.originalFilename || 'score').replace(/\.[^.]+$/, '') + '.pdf';
    this.sendBuffer(res, buffer, baseName, 'application/pdf', !!revisionId, 'inline');
  }

  @Get(":workId/sources/:sourceId/score.mscz")
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download MuseScore file',
    description: 'Get the original MuseScore (.mscz) file for a source or specific revision'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'r', required: false, description: 'Revision ID (optional, defaults to latest)' })
  @ApiResponse({ status: 200, description: 'MuseScore file returned', content: { 'application/vnd.musescore.mscz': {} } })
  @ApiResponse({ status: 404, description: 'MuseScore file not found for this source' })
  async downloadMscz(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('r') revisionId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser
  ) {
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    const detail = await this.worksService.getWorkDetail(workId, viewer);
    const source = detail.sources.find((s) => s.sourceId === sourceId);
    const locator = revisionId
      ? (source?.revisions.find(r => r.revisionId === revisionId)?.derivatives?.mscz)
      : source?.derivatives?.mscz;
    if (!source || !locator) {
      throw new NotFoundException('MuseScore file not found for this source');
    }
    const loc = locator;
    const buffer = await this.storageService.getObjectBuffer(loc!.bucket, loc!.objectKey);
    const baseName = (source.originalFilename || 'score').replace(/\.[^.]+$/, '') + '.mscz';
    this.sendBuffer(res, buffer, baseName, 'application/vnd.musescore.mscz', !!revisionId, 'attachment');
  }

  @Get(":workId/sources/:sourceId/reference.pdf")
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download reference PDF',
    description: 'Get the reference PDF file for a source or specific revision'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'r', required: false, description: 'Revision ID (optional, defaults to latest)' })
  @ApiResponse({ status: 200, description: 'Reference PDF file returned', content: { 'application/pdf': {} } })
  @ApiResponse({ status: 404, description: 'Reference PDF not found for this source' })
  async downloadReferencePdf(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('r') revisionId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser
  ) {
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    const detail = await this.worksService.getWorkDetail(workId, viewer);
    const source = detail.sources.find((s) => s.sourceId === sourceId);
    const locator = revisionId
      ? (source?.revisions.find(r => r.revisionId === revisionId)?.derivatives?.referencePdf)
      : source?.derivatives?.referencePdf;
    if (!source || !locator) {
      throw new NotFoundException('Reference PDF not found for this source');
    }
    const loc = locator;
    const buffer = await this.storageService.getObjectBuffer(loc!.bucket, loc!.objectKey);
    const baseName = 'reference.pdf';
    this.sendBuffer(res, buffer, baseName, 'application/pdf', !!revisionId, 'inline');
  }

  @Get(":workId/sources/:sourceId/thumbnail.png")
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download thumbnail',
    description: 'Get the PNG thumbnail of a source or specific revision'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'r', required: false, description: 'Revision ID (optional, defaults to latest)' })
  @ApiResponse({ status: 200, description: 'Thumbnail returned', content: { 'image/png': {} } })
  @ApiResponse({ status: 404, description: 'Thumbnail not found for this source' })
  async downloadThumbnail(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('r') revisionId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser
  ) {
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    const detail = await this.worksService.getWorkDetail(workId, viewer);
    const source = detail.sources.find((s) => s.sourceId === sourceId);
    const locator = revisionId
      ? (source?.revisions.find(r => r.revisionId === revisionId)?.derivatives?.thumbnail)
      : source?.derivatives?.thumbnail;
    if (!source || !locator) {
      throw new NotFoundException('Thumbnail not found for this source');
    }
    const loc = locator;
    const buffer = await this.storageService.getObjectBuffer(loc!.bucket, loc!.objectKey);
    // Thumbnails are always inline images
    this.sendBuffer(res, buffer, '', 'image/png', !!revisionId, 'inline');
  }

  @Get(":workId/sources/:sourceId/linearized.lmx")
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download linearized XML',
    description: 'Get the linearized MusicXML representation (LMX format) for MusicDiff processing'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'r', required: false, description: 'Revision ID (optional, defaults to latest)' })
  @ApiResponse({ status: 200, description: 'Linearized XML file returned', content: { 'text/plain': {} } })
  @ApiResponse({ status: 404, description: 'Linearized XML not found for this source' })
  async downloadLinearized(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('r') revisionId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser
  ) {
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    const detail = await this.worksService.getWorkDetail(workId, viewer);
    const source = detail.sources.find((s) => s.sourceId === sourceId);
    const locator = revisionId
      ? (source?.revisions.find(r => r.revisionId === revisionId)?.derivatives?.linearizedXml)
      : source?.derivatives?.linearizedXml;
    if (!source || !locator) {
      throw new NotFoundException('Linearized XML not found for this source');
    }
    const buffer = await this.storageService.getObjectBuffer(locator!.bucket, locator!.objectKey);
    const baseName = (source.originalFilename || 'score').replace(/\.[^.]+$/, '') + '.lmx';
    this.sendBuffer(res, buffer, baseName, 'text/plain; charset=utf-8', !!revisionId, 'attachment');
  }

  @Get(":workId/sources/:sourceId/manifest.json")
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download manifest',
    description: 'Get the manifest file containing metadata about the source and its derivatives'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'r', required: false, description: 'Revision ID (optional, defaults to latest)' })
  @ApiResponse({ status: 200, description: 'Manifest JSON returned', content: { 'application/json': {} } })
  @ApiResponse({ status: 404, description: 'Manifest not found for this source' })
  async downloadManifest(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('r') revisionId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser
  ) {
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    const detail = await this.worksService.getWorkDetail(workId, viewer);
    const source = detail.sources.find((s) => s.sourceId === sourceId);
    const locator = revisionId
      ? (source?.revisions.find(r => r.revisionId === revisionId)?.manifest)
      : source?.derivatives?.manifest;
    if (!source || !locator) {
      throw new NotFoundException('Manifest not found for this source');
    }
    const buffer = await this.storageService.getObjectBuffer(locator!.bucket, locator!.objectKey);
    const baseName = 'manifest.json';
    this.sendBuffer(res, buffer, baseName, 'application/json; charset=utf-8', !!revisionId, 'attachment');
  }

  @Get(":workId/sources/:sourceId/musicdiff.txt")
  @UseGuards(AuthOptionalGuard)
  @ApiTags('diffs')
  @ApiOperation({
    summary: 'Download MusicDiff text report',
    description: 'Get the semantic diff report comparing this revision to its predecessor (text format)'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'r', required: false, description: 'Revision ID (optional, defaults to latest)' })
  @ApiResponse({ status: 200, description: 'MusicDiff text report returned', content: { 'text/plain': {} } })
  @ApiResponse({ status: 404, description: 'MusicDiff report not found for this source' })
  async downloadMusicDiff(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('r') revisionId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser
  ) {
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    const detail = await this.worksService.getWorkDetail(workId, viewer);
    const source = detail.sources.find((s) => s.sourceId === sourceId);
    const locator = revisionId
      ? (source?.revisions.find(r => r.revisionId === revisionId)?.derivatives?.musicDiffReport)
      : source?.revisions.length && source.revisions.length > 1
        ? source.revisions[0].derivatives?.musicDiffReport
        : undefined;
    if (!source || !locator) {
      throw new NotFoundException('musicdiff report not found for this source');
    }
    const buffer = await this.storageService.getObjectBuffer(locator!.bucket, locator!.objectKey);
    const baseName = 'musicdiff.txt';
    this.sendBuffer(res, buffer, baseName, 'text/plain; charset=utf-8', !!revisionId, 'attachment');
  }

  @Get(":workId/sources/:sourceId/musicdiff.html")
  @UseGuards(AuthOptionalGuard)
  @ApiTags('diffs')
  @ApiOperation({
    summary: 'Download MusicDiff HTML wrapper',
    description: 'Get an HTML page embedding the visual PDF diff for viewing in a browser'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'r', required: false, description: 'Revision ID (optional, defaults to latest)' })
  @ApiResponse({ status: 200, description: 'HTML wrapper returned', content: { 'text/html': {} } })
  @ApiResponse({ status: 404, description: 'Revision not found for HTML diff' })
  async downloadMusicDiffHtml(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('r') revisionId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser
  ) {
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    const detail = await this.worksService.getWorkDetail(workId, viewer);
    const source = detail.sources.find((s) => s.sourceId === sourceId);
    if (!source) throw new NotFoundException('Source not found');
    const currentRev = revisionId
      ? source.revisions.find(r => r.revisionId === revisionId)
      : (source.revisions.length >= 2 ? source.revisions[0] : undefined);
    if (!currentRev) throw new NotFoundException('Revision not found for HTML diff');
    let locator = currentRev.derivatives?.musicDiffHtml;
    if (!locator) {
      // Fallback: compute for adjacent previous revision and persist
      const prev = source.revisions.find(r => r.sequenceNumber === currentRev.sequenceNumber - 1);
      const a = prev?.derivatives?.canonicalXml;
      const b = currentRev.derivatives?.canonicalXml;
      if (!a || !b) throw new NotFoundException('Canonical XML missing for one or both adjacent revisions');
      const [bufA, bufB] = await Promise.all([
        this.storageService.getObjectBuffer(a.bucket, a.objectKey),
        this.storageService.getObjectBuffer(b.bucket, b.objectKey)
      ]);
      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(exec);
      const tmp = await import('node:os');
      const fsPromises = await import('node:fs/promises');
      const path = await import('node:path');
      const { createHash } = await import('node:crypto');
      const dir = await fsPromises.mkdtemp(path.join(tmp.tmpdir(), 'ots-mdiff-html-'));
      try {
        const pA = path.join(dir, 'a.xml');
        const pB = path.join(dir, 'b.xml');
        await fsPromises.writeFile(pA, bufA);
        await fsPromises.writeFile(pB, bufB);
        // Build wrapper that embeds the PDF endpoint for this revision
        const pdfUrl = `/api/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/musicdiff.pdf?r=${encodeURIComponent(currentRev.revisionId)}`;
        const html = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>MusicDiff (visual)</title></head><body style=\"margin:0;padding:0;height:100vh\"><object data=\"${pdfUrl}\" type=\"application/pdf\" style=\"width:100%;height:100%\"><p>Open PDF: <a href=\"${pdfUrl}\">${pdfUrl}</a></p></object></body></html>`, 'utf-8');
        const base = `${workId}/${sourceId}/rev-${currentRev.sequenceNumber.toString().padStart(4, '0')}`;
        const put = await this.storageService.putAuxiliaryObject(
          `${base}/musicdiff.html`,
          html,
          html.length,
          'text/html'
        );
        locator = {
          bucket: put.bucket,
          objectKey: put.objectKey,
          sizeBytes: html.length,
          checksum: { algorithm: 'sha256', hexDigest: createHash('sha256').update(html).digest('hex') },
          contentType: 'text/html',
          lastModifiedAt: new Date()
        } as any;
        await this.worksService.upsertMusicDiffDerivatives(workId, sourceId, currentRev.revisionId, { musicDiffHtml: locator as any });
      } finally {
        await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => { });
      }
    }
    const buffer = await this.storageService.getObjectBuffer(locator.bucket, locator.objectKey);
    const baseName = 'musicdiff.html';
    this.sendBuffer(res, buffer, baseName, 'text/html; charset=utf-8', !!revisionId, 'inline');
  }

  @Get(":workId/sources/:sourceId/musicdiff.pdf")
  @UseGuards(AuthOptionalGuard)
  @ApiTags('diffs')
  @ApiOperation({
    summary: 'Download MusicDiff PDF',
    description: 'Get the visual diff PDF comparing this revision to its predecessor, generated by MusicDiff'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'r', required: false, description: 'Revision ID (optional, defaults to latest)' })
  @ApiResponse({ status: 200, description: 'MusicDiff PDF returned', content: { 'application/pdf': {} } })
  @ApiResponse({ status: 404, description: 'Revision not found for PDF diff' })
  async downloadMusicDiffPdf(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('r') revisionId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser
  ) {
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    const detail = await this.worksService.getWorkDetail(workId, viewer);
    const source = detail.sources.find((s) => s.sourceId === sourceId);
    if (!source) throw new NotFoundException('Source not found');
    const currentRev = revisionId
      ? source.revisions.find(r => r.revisionId === revisionId)
      : (source.revisions.length >= 2 ? source.revisions[0] : undefined);
    if (!currentRev) throw new NotFoundException('Revision not found for PDF diff');
    let locator = (currentRev as any).derivatives?.musicDiffPdf as any;
    if (locator && (!locator.sizeBytes || locator.sizeBytes <= 0)) {
      locator = undefined;
    }
    if (!locator) {
      // Fallback compute for adjacent pair
      const prev = source.revisions.find(r => r.sequenceNumber === currentRev.sequenceNumber - 1);
      const a = prev?.derivatives?.canonicalXml;
      const b = currentRev.derivatives?.canonicalXml;
      if (!a || !b) throw new NotFoundException('Canonical XML missing for one or both adjacent revisions');
      const [bufA, bufB] = await Promise.all([
        this.storageService.getObjectBuffer(a.bucket, a.objectKey),
        this.storageService.getObjectBuffer(b.bucket, b.objectKey)
      ]);
      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(exec);
      const tmp = await import('node:os');
      const fsPromises = await import('node:fs/promises');
      const path = await import('node:path');
      const { createHash } = await import('node:crypto');
      const dir = await fsPromises.mkdtemp(path.join(tmp.tmpdir(), 'ots-mdiff-pdf-'));
      try {
        const pA = path.join(dir, 'a.xml');
        const pB = path.join(dir, 'b.xml');
        await fsPromises.writeFile(pA, bufA);
        await fsPromises.writeFile(pB, bufB);
        const pdfOut = path.join(dir, 'musicdiff.pdf');
        const scriptPath = '/app/python/musicdiff_pdf.py';
        const { stdout: scriptOutput, stderr: scriptErr } = await execAsync(
          `python3 ${scriptPath} ${pA} ${pB} ${pdfOut}`
        );
        if (!await fsPromises.stat(pdfOut).catch(() => null)) {
          throw new Error(`musicdiff PDF generation failed: ${scriptErr || scriptOutput}`);
        }
        const pdf = await fsPromises.readFile(pdfOut);
        const base = `${workId}/${sourceId}/rev-${currentRev.sequenceNumber.toString().padStart(4, '0')}`;
        const put = await this.storageService.putAuxiliaryObject(
          `${base}/musicdiff.pdf`,
          pdf,
          pdf.length,
          'application/pdf'
        );
        locator = {
          bucket: put.bucket,
          objectKey: put.objectKey,
          sizeBytes: pdf.length,
          checksum: { algorithm: 'sha256', hexDigest: createHash('sha256').update(pdf).digest('hex') },
          contentType: 'application/pdf',
          lastModifiedAt: new Date()
        } as any;
        await this.worksService.upsertMusicDiffDerivatives(workId, sourceId, currentRev.revisionId, { musicDiffPdf: locator as any });
      } finally {
        await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => { });
      }
    }
    const buffer = await this.storageService.getObjectBuffer(locator.bucket, locator.objectKey);
    this.sendBuffer(res, buffer, 'musicdiff.pdf', 'application/pdf', !!revisionId, 'inline');
  }

  @Get(":workId/sources/:sourceId/musicdiff")
  @UseGuards(AuthOptionalGuard)
  @ApiTags('diffs')
  @ApiOperation({
    summary: 'On-demand MusicDiff between any two revisions',
    description: 'Generate a MusicDiff comparison between any two revisions (not just adjacent ones). Returns text or visual PDF format.'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'revA', required: true, description: 'First revision ID to compare' })
  @ApiQuery({ name: 'revB', required: true, description: 'Second revision ID to compare' })
  @ApiQuery({ name: 'format', required: false, description: 'Output format: "semantic" for text diff (default), "visual" for PDF diff', example: 'semantic' })
  @ApiResponse({ status: 200, description: 'MusicDiff comparison returned (text/plain or application/pdf)' })
  @ApiResponse({ status: 400, description: 'Bad request - revA and revB are required' })
  @ApiResponse({ status: 404, description: 'Source or canonical XML not found for one or both revisions' })
  async musicDiffOnDemand(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('revA') revA: string,
    @Query('revB') revB: string,
    @Query('format') format: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser,
    @Param() _params?: any,
    @Body() _body?: any,
    @Query() _query?: any,
    @Headers() _headers?: any,
    @Param('workId') _w?: string,
    @Param('sourceId') _s?: string
  ) {
    if (!revA || !revB) throw new BadRequestException('revA and revB are required');
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    const detail = await this.worksService.getWorkDetail(workId, viewer);
    const source = detail.sources.find((s) => s.sourceId === sourceId);
    if (!source) throw new NotFoundException('Source not found');
    const a = source.revisions.find(r => r.revisionId === revA)?.derivatives?.canonicalXml;
    const b = source.revisions.find(r => r.revisionId === revB)?.derivatives?.canonicalXml;
    if (!a || !b) throw new NotFoundException('Canonical XML missing for one or both revisions');
    const [bufA, bufB] = await Promise.all([
      this.storageService.getObjectBuffer(a.bucket, a.objectKey),
      this.storageService.getObjectBuffer(b.bucket, b.objectKey)
    ]);
    // Run musicdiff
    const { exec, spawn } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    const tmp = await import('node:os');
    const fsPromises = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = await fsPromises.mkdtemp(path.join(tmp.tmpdir(), 'ots-mdiff-'));
    // Try cached aux object first
    const outFmt = (format || 'text').toLowerCase();
    const ext = outFmt === 'pdf' ? 'pdf' : (outFmt === 'html' ? 'html' : 'txt');
    const key = `diffs/${revA}_to_${revB}/musicdiff.${ext}`;
    try {
      if (outFmt !== 'html' && await this.storageService.statAuxObject(key)) {
        const cached = await this.storageService.getAuxObjectBuffer(key);
        res.setHeader('Content-Type', outFmt === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.send(cached);
      }
    } catch { }

    try {
      const pA = path.join(dir, 'a.xml');
      const pB = path.join(dir, 'b.xml');
      await fsPromises.writeFile(pA, bufA);
      await fsPromises.writeFile(pB, bufB);
      const outFmt = (format || 'text').toLowerCase();
      if (outFmt === 'html') {
        // Build absolute origin from the incoming request since this HTML will often be embedded in the frontend page
        const req = (res as any).req as import('express').Request;
        const host = req.get('host');
        const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
        const origin = `${proto}://${host}`;
        const absPdf = `${origin}/api/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/musicdiff?revA=${encodeURIComponent(revA)}&revB=${encodeURIComponent(revB)}&format=pdf`;
        const wrapper = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>MusicDiff (visual)</title></head><body style="margin:0;padding:0;height:100vh"><object data="${absPdf}" type="application/pdf" style="width:100%;height:100%"><p>Open PDF: <a href="${absPdf}">PDF</a></p></object></body></html>`, 'utf-8');
        await this.storageService.putAuxiliaryObject(key, wrapper, wrapper.length, 'text/html');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.send(wrapper);
      } else if (outFmt === 'text') {
        const { stdout } = await execAsync(`python3 -m musicdiff -o=text -- ${pA} ${pB}`);
        const buf = Buffer.from(stdout, 'utf-8');
        await this.storageService.putAuxiliaryObject(key, buf, buf.length, 'text/plain');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.send(buf);
      } else if (outFmt === 'pdf') {
        // Use helper script that properly uses musicdiff API with explicit output paths
        const pdfOut = path.join(dir, 'combined.pdf');
        const scriptPath = '/app/python/musicdiff_pdf.py';
        const { stdout: scriptOutput, stderr: scriptErr } = await execAsync(
          `python3 ${scriptPath} ${pA} ${pB} ${pdfOut}`
        );
        if (!await fsPromises.stat(pdfOut).catch(() => null)) {
          throw new Error(`musicdiff PDF generation failed: ${scriptErr || scriptOutput}`);
        }
        const pdf = await fsPromises.readFile(pdfOut);
        await this.storageService.putAuxiliaryObject(key, pdf, pdf.length, 'application/pdf');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.send(pdf);
      } else {
        throw new BadRequestException('Unsupported format (use text|html|pdf)');
      }
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => { });
    }
  }

  // On-demand non-adjacent plain text diff for LMX/XML/manifest
  @Get(":workId/sources/:sourceId/textdiff")
  @UseGuards(AuthOptionalGuard)
  async textDiffOnDemand(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('revA') revA: string,
    @Query('revB') revB: string,
    @Query('file') file: string,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser
  ) {
    if (!revA || !revB) throw new BadRequestException('revA and revB are required');
    const kind = (file || '').toLowerCase();
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    const detail = await this.worksService.getWorkDetail(workId, viewer);
    const source = detail.sources.find((s) => s.sourceId === sourceId);
    if (!source) throw new NotFoundException('Source not found');
    const aRev = source.revisions.find(r => r.revisionId === revA);
    const bRev = source.revisions.find(r => r.revisionId === revB);
    if (!aRev || !bRev) throw new NotFoundException('One or both revisions not found');

    let aLoc, bLoc;
    if (kind === 'linearized' || kind === 'lmx') {
      aLoc = aRev.derivatives?.linearizedXml;
      bLoc = bRev.derivatives?.linearizedXml;
    } else if (kind === 'canonical' || kind === 'xml') {
      aLoc = aRev.derivatives?.canonicalXml;
      bLoc = bRev.derivatives?.canonicalXml;
    } else if (kind === 'manifest' || kind === 'json') {
      aLoc = aRev.manifest;
      bLoc = bRev.manifest;
    } else {
      throw new BadRequestException('Unsupported file type for textdiff');
    }
    if (!aLoc || !bLoc) throw new NotFoundException('Selected artifact missing for one or both revisions');

    const [bufA, bufB] = await Promise.all([
      this.storageService.getObjectBuffer(aLoc.bucket, aLoc.objectKey),
      this.storageService.getObjectBuffer(bLoc.bucket, bLoc.objectKey)
    ]);
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    const tmp = await import('node:os');
    const fsPromises = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = await fsPromises.mkdtemp(path.join(tmp.tmpdir(), 'ots-tdiff-'));
    try {
      const pA = path.join(dir, 'a');
      const pB = path.join(dir, 'b');
      await fsPromises.writeFile(pA, bufA);
      await fsPromises.writeFile(pB, bufB);
      const { stdout } = await execAsync(`diff -u ${pA} ${pB}`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(stdout || '(no differences)\n');
    } catch (err: any) {
      // diff exits with code 1 when differences are found; stdout contains the diff
      if (err && err.stdout) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(err.stdout);
      } else {
        throw err;
      }
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => { });
    }
  }

  // Fossil text diff between two fossil artifact IDs for a given file
  @Get(":workId/sources/:sourceId/fossil/diff")
  async fossilDiff(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('a') artifactA: string,
    @Query('b') artifactB: string,
    @Query('file') file: string = 'linearized.lmx',
    @Res() res: Response
  ) {
    if (!artifactA || !artifactB) throw new BadRequestException('a and b (artifact ids) are required');
    const allowed = new Set(['linearized.lmx', 'canonical.xml', 'manifest.json']);
    if (!allowed.has(file)) throw new BadRequestException('Unsupported file for fossil diff');
    const diffText = await this.fossilService.diff(workId, sourceId, artifactA, artifactB, file);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(diffText);
  }

  // List branches for a given source repository
  @Get(":workId/sources/:sourceId/fossil/branches")
  async listBranches(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string
  ) {
    const branches = await this.fossilService.listBranches(workId, sourceId);
    return { branches };
  }

  @Post(':workId/sources')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'file', maxCount: 1 },
      { name: 'referencePdf', maxCount: 1 }
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
        file: { type: 'string', format: 'binary', description: 'MusicXML file (.musicxml, .mxl, or .xml)' },
        referencePdf: { type: 'string', format: 'binary', description: 'Optional reference PDF file' },
        isPrimary: { type: 'boolean', description: 'Whether this is the primary source', example: true },
        formatHint: { type: 'string', description: 'Format hint (e.g., "musicxml")', example: 'musicxml' },
        branch: { type: 'string', description: 'Target branch name', example: 'trunk' },
        license: { type: 'string', description: 'License for the uploaded content', example: 'CC-BY-4.0' }
      },
      required: ['file']
    }
  })
  @ApiResponse({ status: 201, description: 'Source uploaded successfully, derivatives being generated' })
  @ApiResponse({ status: 400, description: 'Invalid file or parameters' })
  uploadSource(
    @Param('workId') workId: string,
    @Body() body: UploadSourceRequest,
    @UploadedFiles() files?: { file?: Express.Multer.File[]; referencePdf?: Express.Multer.File[] },
    @Headers('x-progress-id') progressId?: string,
    @CurrentUser() user?: RequestUser
  ) {
    const normalizedBody: UploadSourceRequest = {
      ...body,
      isPrimary: this.toBoolean(body?.isPrimary),
      formatHint: body?.formatHint
    };
    const file = files?.file?.[0];
    const referencePdfFile = files?.referencePdf?.[0];
    return this.uploadSourceService.upload(workId, normalizedBody, file, referencePdfFile, progressId, user);
  }

  @Post(':workId/sources/:sourceId/revisions')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'file', maxCount: 1 },
      { name: 'referencePdf', maxCount: 1 }
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
    description: 'Upload a new revision of an existing source. Optionally include a reference PDF. Generates derivatives and MusicDiff comparison with previous revision.'
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary', description: 'MusicXML file (.musicxml, .mxl, or .xml)' },
        referencePdf: { type: 'string', format: 'binary', description: 'Optional reference PDF file' },
        isPrimary: { type: 'boolean', description: 'Whether this is the primary source' },
        formatHint: { type: 'string', description: 'Format hint (e.g., "musicxml")', example: 'musicxml' },
        branch: { type: 'string', description: 'Target branch name', example: 'trunk' },
        createBranch: { type: 'boolean', description: 'Create a new branch for this revision' },
        branchName: { type: 'string', description: 'Name of new branch if createBranch is true' },
        changeSummary: { type: 'string', description: 'Summary of changes in this revision', example: 'Fixed measure 42 dynamics' },
        license: { type: 'string', description: 'License for the uploaded content', example: 'CC-BY-4.0' }
      },
      required: ['file']
    }
  })
  @ApiResponse({ status: 201, description: 'Revision uploaded successfully, derivatives and diff being generated' })
  @ApiResponse({ status: 400, description: 'Invalid file or parameters' })
  @ApiResponse({ status: 404, description: 'Source not found' })
  uploadRevision(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Body() body: UploadSourceRequest,
    @UploadedFiles() files?: { file?: Express.Multer.File[]; referencePdf?: Express.Multer.File[] },
    @Headers('x-progress-id') progressId?: string,
    @CurrentUser() user?: RequestUser
  ) {
    const normalizedBody: UploadSourceRequest = {
      ...body,
      isPrimary: this.toBoolean(body?.isPrimary),
      formatHint: body?.formatHint,
      createBranch: this.toBoolean((body as any)?.createBranch),
      branchName: (body as any)?.branchName
    };
    const file = files?.file?.[0];
    const referencePdfFile = files?.referencePdf?.[0];
    return this.uploadSourceService.uploadRevision(workId, sourceId, normalizedBody, file, referencePdfFile, progressId, user);
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
    @CurrentUser() user: RequestUser
  ) {
    const isAdmin = user?.roles?.includes('admin') ?? false;
    return this.worksService.rateRevision(
      workId,
      sourceId,
      revisionId,
      user.userId,
      body.rating,
      isAdmin
    );
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
