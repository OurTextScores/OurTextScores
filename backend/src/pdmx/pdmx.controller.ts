import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseInterceptors,
  UseGuards
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { AdminRequiredGuard } from '../auth/guards/admin-required.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types/auth-user';
import { PdmxService } from './pdmx.service';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

@ApiTags('pdmx')
@Controller('pdmx')
@UseGuards(AuthRequiredGuard, AdminRequiredGuard)
export class PdmxController {
  constructor(private readonly pdmxService: PdmxService) {}

  @Get('records')
  @ApiOperation({ summary: 'List/search PDMX records (admin only)' })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'group', required: false, example: 'openwelltemperedclavier' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({ name: 'sort', required: false, example: 'updated_desc' })
  @ApiQuery({ name: 'excludeUnacceptable', required: false, example: 'true' })
  @ApiQuery({ name: 'requireNoLicenseConflict', required: false, example: 'true' })
  @ApiQuery({ name: 'importStatus', required: false, example: 'imported' })
  @ApiQuery({ name: 'hideImported', required: false, example: 'false' })
  @ApiQuery({ name: 'hasPdf', required: false, example: 'true' })
  @ApiQuery({ name: 'subset', required: false, example: 'all_valid' })
  listRecords(
    @Query('q') q?: string,
    @Query('group') group?: string,
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
    @Query('sort') sort?: string,
    @Query('excludeUnacceptable') excludeUnacceptable?: string,
    @Query('requireNoLicenseConflict') requireNoLicenseConflict?: string,
    @Query('importStatus') importStatus?: string,
    @Query('hideImported') hideImported?: string,
    @Query('hasPdf') hasPdf?: string,
    @Query('subset') subset?: string | string[]
  ) {
    return this.pdmxService.listRecords({
      q,
      group,
      limit: Number(limit),
      offset: Number(offset),
      sort,
      excludeUnacceptable: this.toBoolean(excludeUnacceptable),
      requireNoLicenseConflict: this.toBoolean(requireNoLicenseConflict),
      importStatus,
      hideImported: this.toBoolean(hideImported),
      hasPdf: this.toBoolean(hasPdf),
      subset
    });
  }

  @Get('groups')
  @ApiOperation({ summary: 'List PDMX groups by size (admin only)' })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'groupQ', required: false, example: 'bach' })
  @ApiQuery({ name: 'limit', required: false, example: 30 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({ name: 'excludeUnacceptable', required: false, example: 'true' })
  @ApiQuery({ name: 'requireNoLicenseConflict', required: false, example: 'true' })
  @ApiQuery({ name: 'importStatus', required: false, example: 'imported' })
  @ApiQuery({ name: 'hideImported', required: false, example: 'false' })
  @ApiQuery({ name: 'hasPdf', required: false, example: 'true' })
  @ApiQuery({ name: 'subset', required: false, example: 'all_valid' })
  listGroups(
    @Query('q') q?: string,
    @Query('groupQ') groupQ?: string,
    @Query('limit') limit = '30',
    @Query('offset') offset = '0',
    @Query('excludeUnacceptable') excludeUnacceptable?: string,
    @Query('requireNoLicenseConflict') requireNoLicenseConflict?: string,
    @Query('importStatus') importStatus?: string,
    @Query('hideImported') hideImported?: string,
    @Query('hasPdf') hasPdf?: string,
    @Query('subset') subset?: string | string[]
  ) {
    return this.pdmxService.listGroups({
      q,
      groupQ,
      limit: Number(limit),
      offset: Number(offset),
      excludeUnacceptable: this.toBoolean(excludeUnacceptable),
      requireNoLicenseConflict: this.toBoolean(requireNoLicenseConflict),
      importStatus,
      hideImported: this.toBoolean(hideImported),
      hasPdf: this.toBoolean(hasPdf),
      subset
    });
  }

  @Get('records/:pdmxId')
  @ApiOperation({ summary: 'Get PDMX record detail (admin only)' })
  getRecord(@Param('pdmxId') pdmxId: string) {
    return this.pdmxService.getRecord(pdmxId);
  }

  @Get('records/:pdmxId/pdf')
  @ApiOperation({ summary: 'Stream PDMX record PDF (admin only)' })
  @ApiResponse({ status: 200, description: 'PDF stream returned' })
  async streamPdf(@Param('pdmxId') pdmxId: string, @Res() res: Response) {
    const { stream, filename } = await this.pdmxService.getPdfStream(pdmxId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    stream.pipe(res);
  }

  @Patch('records/:pdmxId/review')
  @ApiOperation({ summary: 'Update PDMX review status/flags (admin only)' })
  updateReview(
    @Param('pdmxId') pdmxId: string,
    @Body()
    body: {
      qualityStatus?: 'unknown' | 'acceptable' | 'unacceptable';
      excludedFromSearch?: boolean;
      reason?: string;
      notes?: string;
    },
    @CurrentUser() user: RequestUser
  ) {
    return this.pdmxService.updateReview(pdmxId, body, user);
  }

  @Patch('groups/:group/review')
  @ApiOperation({ summary: 'Mark all records in a PDMX group unacceptable (admin only)' })
  updateGroupReview(
    @Param('group') group: string,
    @Body()
    body: {
      reason?: string;
      notes?: string;
    },
    @CurrentUser() user: RequestUser
  ) {
    return this.pdmxService.markGroupUnacceptable(group, body || {}, user);
  }

  @Patch('records/:pdmxId/import')
  @ApiOperation({ summary: 'Update PDMX import state (admin only)' })
  updateImport(
    @Param('pdmxId') pdmxId: string,
    @Body()
    body: {
      status?: 'not_imported' | 'imported' | 'failed';
      importedWorkId?: string;
      importedSourceId?: string;
      importedRevisionId?: string;
      importedProjectId?: string;
      imslpUrl?: string;
      error?: string;
    },
    @CurrentUser() user: RequestUser
  ) {
    return this.pdmxService.updateImportState(pdmxId, body, user);
  }

  @Post('records/:pdmxId/associate-source')
  @UseInterceptors(
    FileFieldsInterceptor(
      [{ name: 'referencePdf', maxCount: 1 }],
      {
        storage: memoryStorage(),
        limits: {
          fileSize: 100 * 1024 * 1024
        }
      }
    )
  )
  @ApiOperation({ summary: 'Associate PDMX record with IMSLP and project by importing actual MXL (admin only)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['imslpUrl', 'projectId'],
      properties: {
        imslpUrl: { type: 'string' },
        projectId: { type: 'string' },
        sourceLabel: { type: 'string' },
        sourceType: { type: 'string', enum: ['score', 'parts', 'audio', 'metadata', 'other'] },
        license: { type: 'string' },
        adminVerified: { type: 'boolean' },
        referencePdf: { type: 'string', format: 'binary' }
      }
    }
  })
  associateSource(
    @Param('pdmxId') pdmxId: string,
    @Body()
    body: {
      imslpUrl: string;
      projectId: string;
      sourceLabel?: string;
      sourceType?: 'score' | 'parts' | 'audio' | 'metadata' | 'other';
      license?: string;
      adminVerified?: boolean | string;
    },
    @UploadedFiles() files: { referencePdf?: Express.Multer.File[] },
    @CurrentUser() user: RequestUser,
    @Headers('x-progress-id') progressId?: string
  ) {
    return this.pdmxService.associateSource(
      pdmxId,
      {
        ...body,
        adminVerified: this.toBoolean(body.adminVerified) === true
      },
      user,
      files?.referencePdf?.[0],
      progressId
    );
  }

  private toBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return undefined;
  }
}
