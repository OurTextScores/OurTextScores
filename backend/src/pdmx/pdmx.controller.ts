import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { AdminRequiredGuard } from '../auth/guards/admin-required.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types/auth-user';
import { PdmxService } from './pdmx.service';

@ApiTags('pdmx')
@Controller('pdmx')
@UseGuards(AuthRequiredGuard, AdminRequiredGuard)
export class PdmxController {
  constructor(private readonly pdmxService: PdmxService) {}

  @Get('records')
  @ApiOperation({ summary: 'List/search PDMX records (admin only)' })
  @ApiQuery({ name: 'q', required: false })
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
  @ApiOperation({ summary: 'Associate PDMX record with IMSLP and project by importing actual MXL (admin only)' })
  associateSource(
    @Param('pdmxId') pdmxId: string,
    @Body()
    body: {
      imslpUrl: string;
      projectId: string;
      sourceLabel?: string;
      sourceType?: 'score' | 'parts' | 'audio' | 'metadata' | 'other';
    },
    @CurrentUser() user: RequestUser
  ) {
    return this.pdmxService.associateSource(pdmxId, body, user);
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
