import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
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
  private readonly ingestRateWindowMs = 60_000;
  private readonly ingestRateBuckets = new Map<string, { windowStartMs: number; events: number }>();

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
    const eventCount = this.estimateEventCount(body);
    const rateKey = this.buildRateLimitKey(req, user);
    const maxEvents = user?.userId ? 600 : 120;
    if (!this.consumeIngestBudget(rateKey, eventCount, maxEvents)) {
      throw new HttpException('Analytics ingest rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

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

  private estimateEventCount(body: unknown): number {
    const payload = body as Record<string, unknown> | null | undefined;
    if (Array.isArray(payload)) {
      return Math.max(1, payload.length);
    }
    const maybeEvents = payload?.events;
    if (Array.isArray(maybeEvents)) {
      return Math.max(1, maybeEvents.length);
    }
    return 1;
  }

  private buildRateLimitKey(req: Request, user?: RequestUser): string {
    if (user?.userId) {
      return `user:${user.userId}`;
    }
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      typeof forwarded === 'string'
        ? forwarded.split(',')[0]?.trim()
        : Array.isArray(forwarded)
          ? forwarded[0]
          : req.ip;
    return `ip:${ip || 'unknown'}`;
  }

  private consumeIngestBudget(rateKey: string, events: number, maxEventsPerWindow: number): boolean {
    const now = Date.now();
    if (events > maxEventsPerWindow) {
      return false;
    }
    const current = this.ingestRateBuckets.get(rateKey);
    if (!current || now - current.windowStartMs >= this.ingestRateWindowMs) {
      this.ingestRateBuckets.set(rateKey, {
        windowStartMs: now,
        events
      });
      this.pruneExpiredRateBuckets(now);
      return true;
    }

    const nextEvents = current.events + events;
    if (nextEvents > maxEventsPerWindow) {
      return false;
    }

    current.events = nextEvents;
    this.ingestRateBuckets.set(rateKey, current);
    this.pruneExpiredRateBuckets(now);
    return true;
  }

  private pruneExpiredRateBuckets(nowMs: number): void {
    for (const [key, bucket] of this.ingestRateBuckets.entries()) {
      if (nowMs - bucket.windowStartMs > this.ingestRateWindowMs * 2) {
        this.ingestRateBuckets.delete(key);
      }
    }
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
