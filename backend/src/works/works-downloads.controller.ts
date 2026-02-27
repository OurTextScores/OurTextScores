import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AnalyticsService } from '../analytics/analytics.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types/auth-user';
import { AuthOptionalGuard } from '../auth/guards/auth-optional.guard';
import { FossilService } from '../fossil/fossil.service';
import { StorageService } from '../storage/storage.service';
import { DownloadAssetKind, WorksService } from './works.service';

@ApiTags('works')
@Controller('works')
export class WorksDownloadsController {
  constructor(
    private readonly worksService: WorksService,
    private readonly storageService: StorageService,
    private readonly fossilService: FossilService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  private sendBuffer(
    res: Response,
    buffer: Buffer,
    filename: string,
    contentType: string,
    immutable: boolean,
    disposition: 'inline' | 'attachment' = 'attachment',
  ) {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (filename) {
      res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(filename)}"`);
    }
    res.send(buffer);
  }

  private trackScoreDownloaded(
    req: Request,
    user: RequestUser | undefined,
    payload: {
      workId: string;
      sourceId: string;
      revisionId?: string;
      fileFormat: string;
      routePath: string;
    },
  ): void {
    void this.analyticsService.trackBestEffort({
      eventName: 'score_downloaded',
      actor: this.analyticsService.toActor(user),
      requestContext: this.analyticsService.getRequestContext(req, {
        sourceApp: 'backend',
        route: payload.routePath,
      }),
      properties: {
        work_id: payload.workId,
        source_id: payload.sourceId,
        revision_id: payload.revisionId ?? null,
        file_format: payload.fileFormat,
        download_surface: 'api',
      },
    });
  }

  private async resolveDownloadAsset(params: {
    workId: string;
    sourceId: string;
    revisionId?: string;
    user?: RequestUser;
    kind: DownloadAssetKind;
  }) {
    const viewer = params.user ? { userId: params.user.userId, roles: params.user.roles } : undefined;
    return this.worksService.resolveDownloadAsset({
      workId: params.workId,
      sourceId: params.sourceId,
      revisionId: params.revisionId,
      viewer,
      kind: params.kind,
    });
  }

  private async resolveDownloadAssetOrThrow(
    params: {
      workId: string;
      sourceId: string;
      revisionId?: string;
      user?: RequestUser;
      kind: DownloadAssetKind;
    },
    notFoundMessage: string,
  ) {
    try {
      return await this.resolveDownloadAsset(params);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException(notFoundMessage);
      }
      throw error;
    }
  }

  @Get(':workId/sources/:sourceId/normalized.mxl')
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download normalized MXL',
    description: 'Get the normalized compressed MusicXML (.mxl) file for a source or specific revision',
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'r', required: false, description: 'Revision ID (optional, defaults to latest)' })
  @ApiResponse({
    status: 200,
    description: 'Normalized MXL file returned',
    content: { 'application/vnd.recordare.musicxml': {} },
  })
  @ApiResponse({ status: 404, description: 'Normalized MXL not found for this source' })
  async downloadNormalized(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('r') revisionId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser,
    @Req() req?: Request,
  ) {
    const { sourceOriginalFilename, locator } = await this.resolveDownloadAssetOrThrow(
      {
        workId,
        sourceId,
        revisionId,
        user,
        kind: 'normalizedMxl',
      },
      'Normalized MXL not found for this source',
    );
    const buffer = await this.storageService.getObjectBuffer(locator.bucket, locator.objectKey);
    const baseName = (sourceOriginalFilename || 'score').replace(/\.[^.]+$/, '') + '.mxl';
    if (req) {
      this.trackScoreDownloaded(req, user, {
        workId,
        sourceId,
        revisionId,
        fileFormat: 'mxl',
        routePath: req.originalUrl ?? req.url,
      });
    }
    this.sendBuffer(
      res,
      buffer,
      baseName,
      locator.contentType || 'application/vnd.recordare.musicxml',
      !!revisionId,
      'attachment',
    );
  }

  @Get(':workId/sources/:sourceId/canonical.xml')
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download canonical XML',
    description: 'Get the canonical MusicXML representation of a source or specific revision',
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
    @CurrentUser() user?: RequestUser,
    @Req() req?: Request,
  ) {
    const { sourceOriginalFilename, locator } = await this.resolveDownloadAssetOrThrow(
      {
        workId,
        sourceId,
        revisionId,
        user,
        kind: 'canonicalXml',
      },
      'Canonical XML not found for this source',
    );
    const buffer = await this.storageService.getObjectBuffer(locator.bucket, locator.objectKey);
    const baseName = (sourceOriginalFilename || 'score').replace(/\.[^.]+$/, '') + '.xml';
    if (req) {
      this.trackScoreDownloaded(req, user, {
        workId,
        sourceId,
        revisionId,
        fileFormat: 'musicxml',
        routePath: req.originalUrl ?? req.url,
      });
    }
    this.sendBuffer(res, buffer, baseName, 'application/xml; charset=utf-8', !!revisionId, 'attachment');
  }

  @Get(':workId/sources/:sourceId/score.pdf')
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download PDF score',
    description: 'Get the PDF rendering of a source or specific revision',
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
    @CurrentUser() user?: RequestUser,
    @Req() req?: Request,
  ) {
    const { sourceOriginalFilename, locator } = await this.resolveDownloadAssetOrThrow(
      {
        workId,
        sourceId,
        revisionId,
        user,
        kind: 'pdf',
      },
      'PDF not found for this source',
    );
    const buffer = await this.storageService.getObjectBuffer(locator.bucket, locator.objectKey);
    const baseName = (sourceOriginalFilename || 'score').replace(/\.[^.]+$/, '') + '.pdf';
    if (req) {
      this.trackScoreDownloaded(req, user, {
        workId,
        sourceId,
        revisionId,
        fileFormat: 'pdf',
        routePath: req.originalUrl ?? req.url,
      });
    }
    this.sendBuffer(res, buffer, baseName, 'application/pdf', !!revisionId, 'inline');
  }

  @Get(':workId/sources/:sourceId/score.mscz')
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download MuseScore file',
    description: 'Get the original MuseScore (.mscz) file for a source or specific revision',
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'r', required: false, description: 'Revision ID (optional, defaults to latest)' })
  @ApiResponse({
    status: 200,
    description: 'MuseScore file returned',
    content: { 'application/vnd.musescore.mscz': {} },
  })
  @ApiResponse({ status: 404, description: 'MuseScore file not found for this source' })
  async downloadMscz(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('r') revisionId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser,
    @Req() req?: Request,
  ) {
    const { sourceOriginalFilename, locator } = await this.resolveDownloadAssetOrThrow(
      {
        workId,
        sourceId,
        revisionId,
        user,
        kind: 'mscz',
      },
      'MuseScore file not found for this source',
    );
    const buffer = await this.storageService.getObjectBuffer(locator.bucket, locator.objectKey);
    const baseName = (sourceOriginalFilename || 'score').replace(/\.[^.]+$/, '') + '.mscz';
    if (req) {
      this.trackScoreDownloaded(req, user, {
        workId,
        sourceId,
        revisionId,
        fileFormat: 'mscz',
        routePath: req.originalUrl ?? req.url,
      });
    }
    this.sendBuffer(res, buffer, baseName, 'application/vnd.musescore.mscz', !!revisionId, 'attachment');
  }

  @Get(':workId/sources/:sourceId/score.krn')
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download Kern file',
    description: 'Get the original Kern (.krn) file for a source or specific revision',
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiQuery({ name: 'r', required: false, description: 'Revision ID (optional, defaults to latest)' })
  @ApiResponse({ status: 200, description: 'Kern file returned', content: { 'application/x-kern': {} } })
  @ApiResponse({ status: 404, description: 'Kern file not found for this source' })
  async downloadKern(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('r') revisionId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser,
    @Req() req?: Request,
  ) {
    const { sourceOriginalFilename, locator } = await this.resolveDownloadAssetOrThrow(
      {
        workId,
        sourceId,
        revisionId,
        user,
        kind: 'krn',
      },
      'Kern file not found for this source',
    );
    const buffer = await this.storageService.getObjectBuffer(locator.bucket, locator.objectKey);
    const baseName = (sourceOriginalFilename || 'score').replace(/\.[^.]+$/, '') + '.krn';
    if (req) {
      this.trackScoreDownloaded(req, user, {
        workId,
        sourceId,
        revisionId,
        fileFormat: 'other',
        routePath: req.originalUrl ?? req.url,
      });
    }
    this.sendBuffer(
      res,
      buffer,
      baseName,
      locator.contentType || 'application/x-kern; charset=utf-8',
      !!revisionId,
      'attachment',
    );
  }

  @Get(':workId/sources/:sourceId/reference.pdf')
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download reference PDF',
    description: 'Get the reference PDF file for a source or specific revision',
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
    @CurrentUser() user?: RequestUser,
    @Req() req?: Request,
  ) {
    const { locator } = await this.resolveDownloadAssetOrThrow(
      {
        workId,
        sourceId,
        revisionId,
        user,
        kind: 'referencePdf',
      },
      'Reference PDF not found for this source',
    );
    const buffer = await this.storageService.getObjectBuffer(locator.bucket, locator.objectKey);
    if (req) {
      this.trackScoreDownloaded(req, user, {
        workId,
        sourceId,
        revisionId,
        fileFormat: 'pdf',
        routePath: req.originalUrl ?? req.url,
      });
    }
    this.sendBuffer(res, buffer, 'reference.pdf', 'application/pdf', !!revisionId, 'inline');
  }

  @Get(':workId/sources/:sourceId/thumbnail.png')
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download thumbnail',
    description: 'Get the PNG thumbnail of a source or specific revision',
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
    @CurrentUser() user?: RequestUser,
    @Req() req?: Request,
  ) {
    const { locator } = await this.resolveDownloadAssetOrThrow(
      {
        workId,
        sourceId,
        revisionId,
        user,
        kind: 'thumbnail',
      },
      'Thumbnail not found for this source',
    );
    const buffer = await this.storageService.getObjectBuffer(locator.bucket, locator.objectKey);
    if (req) {
      this.trackScoreDownloaded(req, user, {
        workId,
        sourceId,
        revisionId,
        fileFormat: 'png',
        routePath: req.originalUrl ?? req.url,
      });
    }
    this.sendBuffer(res, buffer, '', 'image/png', !!revisionId, 'inline');
  }

  @Get(':workId/sources/:sourceId/manifest.json')
  @UseGuards(AuthOptionalGuard)
  @ApiTags('derivatives')
  @ApiOperation({
    summary: 'Download manifest',
    description: 'Get the manifest file containing metadata about the source and its derivatives',
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
    @CurrentUser() user?: RequestUser,
    @Req() req?: Request,
  ) {
    const { locator } = await this.resolveDownloadAssetOrThrow(
      {
        workId,
        sourceId,
        revisionId,
        user,
        kind: 'manifest',
      },
      'Manifest not found for this source',
    );
    const buffer = await this.storageService.getObjectBuffer(locator.bucket, locator.objectKey);
    if (req) {
      this.trackScoreDownloaded(req, user, {
        workId,
        sourceId,
        revisionId,
        fileFormat: 'other',
        routePath: req.originalUrl ?? req.url,
      });
    }
    this.sendBuffer(res, buffer, 'manifest.json', 'application/json; charset=utf-8', !!revisionId, 'attachment');
  }

  @Get(':workId/sources/:sourceId/textdiff')
  @UseGuards(AuthOptionalGuard)
  async textDiffOnDemand(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('revA') revA: string,
    @Query('revB') revB: string,
    @Query('file') file: string,
    @Res() res: Response,
    @CurrentUser() user?: RequestUser,
  ) {
    if (!revA || !revB) {
      throw new BadRequestException('revA and revB are required');
    }
    const kind = (file || '').toLowerCase();
    const viewer = user ? { userId: user.userId, roles: user.roles } : undefined;
    const detail = await this.worksService.getWorkDetail(workId, viewer);
    const source = detail.sources.find((s) => s.sourceId === sourceId);
    if (!source) {
      throw new NotFoundException('Source not found');
    }

    const aRev = source.revisions.find((revision) => revision.revisionId === revA);
    const bRev = source.revisions.find((revision) => revision.revisionId === revB);
    if (!aRev || !bRev) {
      throw new NotFoundException('One or both revisions not found');
    }

    let aLoc;
    let bLoc;
    if (kind === 'canonical' || kind === 'xml') {
      aLoc = aRev.derivatives?.canonicalXml;
      bLoc = bRev.derivatives?.canonicalXml;
    } else if (kind === 'manifest' || kind === 'json') {
      aLoc = aRev.manifest;
      bLoc = bRev.manifest;
    } else {
      throw new BadRequestException('Unsupported file type for textdiff');
    }

    if (!aLoc || !bLoc) {
      throw new NotFoundException('Selected artifact missing for one or both revisions');
    }

    const [bufA, bufB] = await Promise.all([
      this.storageService.getObjectBuffer(aLoc.bucket, aLoc.objectKey),
      this.storageService.getObjectBuffer(bLoc.bucket, bLoc.objectKey),
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
    } catch (error: any) {
      if (error && error.stdout) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(error.stdout);
      } else {
        throw error;
      }
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  @Get(':workId/sources/:sourceId/fossil/diff')
  async fossilDiff(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Query('a') artifactA: string,
    @Query('b') artifactB: string,
    @Query('file') file = 'canonical.xml',
    @Res() res: Response,
  ) {
    if (!artifactA || !artifactB) {
      throw new BadRequestException('a and b (artifact ids) are required');
    }
    const allowed = new Set(['canonical.xml', 'manifest.json']);
    if (!allowed.has(file)) {
      throw new BadRequestException('Unsupported file for fossil diff');
    }
    const diffText = await this.fossilService.diff(workId, sourceId, artifactA, artifactB, file);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(diffText);
  }

  @Get(':workId/sources/:sourceId/fossil/branches')
  async listBranches(@Param('workId') workId: string, @Param('sourceId') sourceId: string) {
    const branches = await this.fossilService.listBranches(workId, sourceId);
    return { branches };
  }
}
