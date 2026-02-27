import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import { AuthOptionalGuard } from '../auth/guards/auth-optional.guard';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { AdminRequiredGuard } from '../auth/guards/admin-required.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types/auth-user';
import type { Request } from 'express';
import { AnalyticsService } from './analytics.service';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Post('events')
  @UseGuards(AuthOptionalGuard)
  @ApiOperation({
    summary: 'Ingest analytics events',
    description:
      'Stores one or more analytics events. Authentication is optional; authenticated users are automatically attached.'
  })
  @ApiResponse({ status: 201, description: 'Events accepted' })
  async ingestEvents(
    @Body() body: unknown,
    @CurrentUser() user: RequestUser | undefined,
    @Req() req: Request
  ) {
    const actor = this.analytics.toActor(user);
    const requestContext = this.analytics.getRequestContext(req, {
      sourceApp: 'frontend',
      route: req.originalUrl ?? req.url
    });
    const result = await this.analytics.ingest(body, actor, requestContext, {
      trustedIngest: false
    });
    return { ok: true, accepted: result.accepted };
  }

  @Get('metrics/overview')
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  @ApiOperation({
    summary: 'Get analytics overview metrics',
    description:
      'Returns summary business metrics for a time window. Admin-only endpoint for dashboard backends.'
  })
  @ApiQuery({ name: 'from', required: false, description: 'ISO start timestamp (inclusive)' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO end timestamp (exclusive)' })
  @ApiQuery({ name: 'excludeAdmins', required: false, description: 'Exclude admin activity (default true)' })
  @ApiResponse({ status: 200, description: 'Overview metrics returned' })
  async getOverview(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('excludeAdmins') excludeAdmins?: string
  ) {
    const parsedFrom = this.parseDateOrUndefined(from, 'from');
    const parsedTo = this.parseDateOrUndefined(to, 'to');
    const exclude = excludeAdmins == null ? true : excludeAdmins !== 'false';
    return this.analytics.getOverview({
      from: parsedFrom,
      to: parsedTo,
      excludeAdmins: exclude
    });
  }

  @Get('metrics/timeseries')
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  @ApiOperation({
    summary: 'Get analytics timeseries',
    description:
      'Returns bucketed activity and engagement metrics for dashboard charting.'
  })
  @ApiQuery({ name: 'from', required: false, description: 'ISO start timestamp (inclusive)' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO end timestamp (exclusive)' })
  @ApiQuery({ name: 'excludeAdmins', required: false, description: 'Exclude admin activity (default true)' })
  @ApiQuery({ name: 'timezone', required: false, description: 'IANA timezone (default America/New_York)' })
  @ApiQuery({ name: 'bucket', required: false, description: 'Bucket granularity: day|week (default day)' })
  @ApiResponse({ status: 200, description: 'Timeseries metrics returned' })
  async getTimeseries(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('excludeAdmins') excludeAdmins?: string,
    @Query('timezone') timezone?: string,
    @Query('bucket') bucket?: string
  ) {
    const parsedFrom = this.parseDateOrUndefined(from, 'from');
    const parsedTo = this.parseDateOrUndefined(to, 'to');
    const exclude = excludeAdmins == null ? true : excludeAdmins !== 'false';
    const normalizedBucket = bucket === 'week' ? 'week' : 'day';
    return this.analytics.getTimeseries({
      from: parsedFrom,
      to: parsedTo,
      excludeAdmins: exclude,
      timezone,
      bucket: normalizedBucket
    });
  }

  @Get('metrics/funnel')
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  @ApiOperation({
    summary: 'Get funnel metrics',
    description: 'Returns signup -> load -> save -> returned-next-week conversion funnel.'
  })
  @ApiQuery({ name: 'from', required: false, description: 'ISO start timestamp (inclusive)' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO end timestamp (exclusive)' })
  @ApiQuery({ name: 'excludeAdmins', required: false, description: 'Exclude admin activity (default true)' })
  @ApiResponse({ status: 200, description: 'Funnel metrics returned' })
  async getFunnel(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('excludeAdmins') excludeAdmins?: string
  ) {
    const parsedFrom = this.parseDateOrUndefined(from, 'from');
    const parsedTo = this.parseDateOrUndefined(to, 'to');
    const exclude = excludeAdmins == null ? true : excludeAdmins !== 'false';
    return this.analytics.getFunnel({
      from: parsedFrom,
      to: parsedTo,
      excludeAdmins: exclude
    });
  }

  @Get('metrics/retention')
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  @ApiOperation({
    summary: 'Get retention cohorts',
    description: 'Returns activation cohorts with W1/W4/W8 retention.'
  })
  @ApiQuery({ name: 'from', required: false, description: 'ISO start timestamp (inclusive)' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO end timestamp (exclusive)' })
  @ApiQuery({ name: 'excludeAdmins', required: false, description: 'Exclude admin activity (default true)' })
  @ApiQuery({ name: 'timezone', required: false, description: 'IANA timezone (default America/New_York)' })
  @ApiResponse({ status: 200, description: 'Retention report returned' })
  async getRetention(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('excludeAdmins') excludeAdmins?: string,
    @Query('timezone') timezone?: string
  ) {
    const parsedFrom = this.parseDateOrUndefined(from, 'from');
    const parsedTo = this.parseDateOrUndefined(to, 'to');
    const exclude = excludeAdmins == null ? true : excludeAdmins !== 'false';
    return this.analytics.getRetention({
      from: parsedFrom,
      to: parsedTo,
      excludeAdmins: exclude,
      timezone
    });
  }

  @Get('metrics/catalog')
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  @ApiOperation({
    summary: 'Get catalog size and growth metrics',
    description: 'Returns total works/sources/revisions and range-based additions.'
  })
  @ApiQuery({ name: 'from', required: false, description: 'ISO start timestamp (inclusive)' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO end timestamp (exclusive)' })
  @ApiResponse({ status: 200, description: 'Catalog metrics returned' })
  async getCatalog(
    @Query('from') from?: string,
    @Query('to') to?: string
  ) {
    const parsedFrom = this.parseDateOrUndefined(from, 'from');
    const parsedTo = this.parseDateOrUndefined(to, 'to');
    return this.analytics.getCatalogStats({
      from: parsedFrom,
      to: parsedTo
    });
  }

  private parseDateOrUndefined(value: string | undefined, field: string): Date | undefined {
    if (!value) {
      return undefined;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${field} must be an ISO date-time string`);
    }
    return parsed;
  }
}
