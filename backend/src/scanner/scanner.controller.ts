import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  ParseEnumPipe,
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
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequestUser } from '../auth/types/auth-user';
import { ScannerService } from './scanner.service';
import { SCANNER_UPLOAD_DIRECTORY } from './scanner.constants';

const SCANNER_ARTIFACT_KINDS = {
  musicxml: 'musicxml',
  pdf: 'pdf',
  thumbnail: 'thumbnail',
  zip: 'zip'
} as const;

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
      limits: { fileSize: 25 * 1024 * 1024, files: 20 }
    })
  )
  async create(
    @CurrentUser() user: RequestUser,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('detectTitle') detectTitle?: string
  ) {
    try {
      return await this.scanner.createJob({
        userId: user.userId,
        files,
        detectTitle: detectTitle === 'true' || detectTitle === '1'
      });
    } finally {
      const { promises: fs } = await import('node:fs');
      await Promise.all((files || []).map((file) => fs.rm(file.path, { force: true })));
    }
  }

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.scanner.listJobs(user.userId);
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

  @Get(':jobId/artifacts/:kind')
  async artifact(
    @CurrentUser() user: RequestUser,
    @Param('jobId') jobId: string,
    @Param('kind', new ParseEnumPipe(SCANNER_ARTIFACT_KINDS))
    kind: 'musicxml' | 'pdf' | 'thumbnail' | 'zip',
    @Query('page', new ParseIntPipe({ optional: true })) page: number | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    const artifact = await this.scanner.getArtifact(user.userId, jobId, kind, page);
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
