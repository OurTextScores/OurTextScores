import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  ParseEnumPipe,
  PayloadTooLargeException,
  ParseIntPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { AdminRequiredGuard } from '../auth/guards/admin-required.guard';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequestUser } from '../auth/types/auth-user';
import { ScannerService } from './scanner.service';
import { SCANNER_REQUEST_OVERHEAD_BYTES, SCANNER_UPLOAD_DIRECTORY } from './scanner.constants';

/** Zoom levels for a review crop; scanner-crop.ts explains why only two. */
const SCANNER_CROP_LEVELS = { staff: 'staff', context: 'context' } as const;

@ApiTags('scanner')
@ApiBearerAuth()
@Controller('scanner/jobs')
@UseGuards(AuthRequiredGuard)
export class ScannerController {
  constructor(private readonly scanner: ScannerService) {}

  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FilesInterceptor('file', 20, {
      storage: diskStorage({
        destination: (_request, _file, callback) => {
          mkdirSync(SCANNER_UPLOAD_DIRECTORY, { recursive: true });
          callback(null, SCANNER_UPLOAD_DIRECTORY);
        },
        filename: (_request, _file, callback) => callback(null, randomUUID())
      }),
      limits: { fileSize: 25 * 1024 * 1024, files: 20 },
      // Refuse the request from its declared length, before multer stages a
      // byte. `SCANNER_MAX_UPLOAD_BYTES` is enforced in `createJob`, which runs
      // after every file has already been written, so without this a caller can
      // stage 20 files at the per-file limit — 500 MB — and only then be told
      // the combined upload is too large. Concurrent requests multiply it, and
      // the staging directory is shared with the rest of the host.
      fileFilter: (request, _file, callback) => {
        const declared = Number(request.headers['content-length'] || 0);
        const limit =
          Number(process.env.SCANNER_MAX_UPLOAD_BYTES || 25 * 1024 * 1024) +
          SCANNER_REQUEST_OVERHEAD_BYTES;
        if (Number.isFinite(declared) && declared > limit) {
          callback(
            new PayloadTooLargeException(
              `Combined upload exceeds the ${limit - SCANNER_REQUEST_OVERHEAD_BYTES} byte limit`
            ),
            false
          );
          return;
        }
        callback(null, true);
      }
    })
  )
  // 202, not 201: the job is accepted for asynchronous preparation and is not
  // yet a complete resource (design section 8.1).
  @HttpCode(202)
  async create(
    @CurrentUser() user: RequestUser,
    @UploadedFiles() files: Express.Multer.File[],
    @Res({ passthrough: true }) response: Response,
    @Body('detectTitle') detectTitle?: string
  ) {
    try {
      const job = await this.scanner.createJob({
        userId: user.userId,
        files,
        detectTitle: detectTitle === 'true' || detectTitle === '1'
      });
      response.setHeader('Location', `/api/scanner/jobs/${job.jobId}`);
      return job;
    } finally {
      const { promises: fs } = await import('node:fs');
      await Promise.all((files || []).map((file) => fs.rm(file.path, { force: true })));
    }
  }

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('cursor') cursor?: string
  ) {
    return this.scanner.listJobs(user.userId, { limit, cursor });
  }

  // Operational aggregates only, and admin-only: section 12.1 keeps admin
  // operational access distinct from access to score content. Declared before
  // ':jobId' so the literal path is not captured as a job id.
  @Get('metrics')
  @UseGuards(AdminRequiredGuard)
  metrics(@Query('windowHours', new ParseIntPipe({ optional: true })) windowHours?: number) {
    return this.scanner.metrics(windowHours);
  }

  @Get('corrections/export')
  @UseGuards(AdminRequiredGuard)
  exportCorrections(
    @Query('policyVersion') policyVersion?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string
  ) {
    const parsedSince = since ? new Date(since) : undefined;
    return this.scanner.exportCorrections({
      policyVersion,
      since: parsedSince && !Number.isNaN(parsedSince.getTime()) ? parsedSince : undefined,
      limit: limit ? Number(limit) : undefined
    });
  }

  @Get(':jobId')
  get(@CurrentUser() user: RequestUser, @Param('jobId') jobId: string) {
    return this.scanner.getJob(user.userId, jobId);
  }

  @Patch(':jobId/pages')
  configurePages(
    @CurrentUser() user: RequestUser,
    @Param('jobId') jobId: string,
    @Body('pages')
    pages: Array<{
      pageNumber: number;
      ordinal: number;
      rotationDegrees: number;
      included: boolean;
    }>
  ) {
    return this.scanner.configurePages(user.userId, jobId, pages);
  }

  @Post(':jobId/start')
  start(@CurrentUser() user: RequestUser, @Param('jobId') jobId: string) {
    return this.scanner.startJob(user.userId, jobId);
  }

  @Post(':jobId/cancel')
  cancel(@CurrentUser() user: RequestUser, @Param('jobId') jobId: string) {
    return this.scanner.cancelJob(user.userId, jobId);
  }

  @Post(':jobId/retry')
  retry(@CurrentUser() user: RequestUser, @Param('jobId') jobId: string) {
    return this.scanner.retryJob(user.userId, jobId);
  }

  @Post(':jobId/pages/:pageNumber/retry')
  retryPage(
    @CurrentUser() user: RequestUser,
    @Param('jobId') jobId: string,
    @Param('pageNumber', ParseIntPipe) pageNumber: number
  ) {
    return this.scanner.retryPage(user.userId, jobId, pageNumber);
  }

  @Delete(':jobId')
  remove(@CurrentUser() user: RequestUser, @Param('jobId') jobId: string) {
    return this.scanner.deleteJob(user.userId, jobId);
  }

  @Get(':jobId/pages/:pageNumber/review')
  review(
    @CurrentUser() user: RequestUser,
    @Param('jobId') jobId: string,
    @Param('pageNumber', ParseIntPipe) pageNumber: number
  ) {
    return this.scanner.pageReview(user.userId, jobId, pageNumber);
  }

  @Get(':jobId/pages/:pageNumber/comparison')
  comparison(
    @CurrentUser() user: RequestUser,
    @Param('jobId') jobId: string,
    @Param('pageNumber', ParseIntPipe) pageNumber: number,
    @Query('baseEngine') baseEngine: string | undefined,
    @Query('candidateEngine') candidateEngine: string | undefined
  ) {
    return this.scanner.pageComparison(
      user.userId,
      jobId,
      pageNumber,
      String(baseEngine ?? ''),
      String(candidateEngine ?? '')
    );
  }

  @Get(':jobId/pages/:pageNumber/comparison/blocks/:blockIndex/crop')
  async comparisonBlockCrop(
    @CurrentUser() user: RequestUser,
    @Param('jobId') jobId: string,
    @Param('pageNumber', ParseIntPipe) pageNumber: number,
    @Param('blockIndex', ParseIntPipe) blockIndex: number,
    @Query('baseEngine') baseEngine: string | undefined,
    @Query('candidateEngine') candidateEngine: string | undefined,
    @Query('statusVersion', ParseIntPipe) statusVersion: number,
    @Query('contentSignature') contentSignature: string | undefined,
    @Query('geometrySignature') geometrySignature: string | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    const crop = await this.scanner.pageComparisonBlockCrop(
      user.userId,
      jobId,
      pageNumber,
      blockIndex,
      String(baseEngine ?? ''),
      String(candidateEngine ?? ''),
      statusVersion,
      String(contentSignature ?? ''),
      String(geometrySignature ?? '')
    );
    response.setHeader('Content-Type', crop.contentType);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(crop.body);
  }

  @Post(':jobId/pages/:pageNumber/corrections')
  correct(
    @CurrentUser() user: RequestUser,
    @Param('jobId') jobId: string,
    @Param('pageNumber', ParseIntPipe) pageNumber: number,
    @Body()
    body: { spotId?: number; chosen?: string; engineId?: string; contentSignature?: string }
  ) {
    return this.scanner.applyCorrection(
      user.userId,
      jobId,
      pageNumber,
      Number(body?.spotId),
      String(body?.chosen ?? ''),
      String(body?.engineId ?? ''),
      String(body?.contentSignature ?? '')
    );
  }

  @Get(':jobId/pages/:pageNumber/crop/:spotId')
  async crop(
    @CurrentUser() user: RequestUser,
    @Param('jobId') jobId: string,
    @Param('pageNumber', ParseIntPipe) pageNumber: number,
    @Param('spotId', ParseIntPipe) spotId: number,
    @Query('level', new ParseEnumPipe(SCANNER_CROP_LEVELS, { optional: true }))
    level: 'staff' | 'context' | undefined,
    @Query('engineId') engineId: string | undefined,
    @Query('contentSignature') contentSignature: string | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    const crop = await this.scanner.pageCrop(
      user.userId,
      jobId,
      pageNumber,
      spotId,
      level || 'staff',
      String(engineId ?? ''),
      String(contentSignature ?? '')
    );
    response.setHeader('Content-Type', crop.contentType);
    response.setHeader('Cache-Control', 'private, no-store');
    // The crop is a rendering of user-uploaded content; never let it be sniffed
    // into something executable.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(crop.body);
  }

  @Get(':jobId/artifacts/:kind')
  async artifact(
    @CurrentUser() user: RequestUser,
    @Param('jobId') jobId: string,
    @Param('kind') kind: string,
    @Query('page', new ParseIntPipe({ optional: true })) page: number | undefined,
    @Query('engine') engine: string | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    const artifact = await this.scanner.getArtifact(user.userId, jobId, kind, page, engine);
    response.setHeader('Content-Type', artifact.contentType);
    response.setHeader(
      'Content-Disposition',
      `${kind === 'pdf' || kind === 'thumbnail' ? 'inline' : 'attachment'}; filename="${artifact.filename}"`
    );
    response.setHeader('Cache-Control', 'private, no-store');
    // Provider output is never trusted as active content: stop a browser from
    // sniffing MusicXML or a manifest into something it will execute.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(artifact.stream);
  }
}
