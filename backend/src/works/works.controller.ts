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
  findOne(@Param('workId') workId: string, @CurrentUser() user?: RequestUser) {
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    return this.worksService.getWorkDetail(workId, viewer);
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
      : (source?.derivatives?.referencePdf ?? source?.revisions.find(r => r.derivatives?.referencePdf)?.derivatives?.referencePdf);
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

  // On-demand non-adjacent plain text diff for XML/manifest
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
    if (kind === 'canonical' || kind === 'xml') {
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
    @Query('file') file: string = 'canonical.xml',
    @Res() res: Response
  ) {
    if (!artifactA || !artifactB) throw new BadRequestException('a and b (artifact ids) are required');
    const allowed = new Set(['canonical.xml', 'manifest.json']);
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
  uploadSource(
    @Param('workId') workId: string,
    @Body() body: UploadSourceRequest,
    @UploadedFiles() files?: { file?: Express.Multer.File[]; referencePdf?: Express.Multer.File[]; originalMscz?: Express.Multer.File[] },
    @Headers('x-progress-id') progressId?: string,
    @CurrentUser() user?: RequestUser
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
    return this.uploadSourceService.upload(workId, normalizedBody, file, referencePdfFile, progressId, user, originalMsczFile);
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
  uploadRevision(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Body() body: UploadSourceRequest,
    @UploadedFiles() files?: { file?: Express.Multer.File[]; referencePdf?: Express.Multer.File[]; originalMscz?: Express.Multer.File[] },
    @Headers('x-progress-id') progressId?: string,
    @CurrentUser() user?: RequestUser
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
    return this.uploadSourceService.uploadRevision(workId, sourceId, normalizedBody, file, referencePdfFile, progressId, user, originalMsczFile);
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
    @CurrentUser() user: RequestUser
  ) {
    return this.worksService.createComment(
      workId,
      sourceId,
      revisionId,
      user.userId,
      body.content,
      body.parentCommentId
    );
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
